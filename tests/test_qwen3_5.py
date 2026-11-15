"""Qwen3.5-MoE (`qwen3_5_moe`): gated-DeltaNet linear-attention layers mixed with gated full attention.

On a tiny random checkpoint with the real model's layout (tests/tiny_qwen3_5.py):
- the MLX shard reproduces mlx_lm's own model exactly;
- a split run (layers [0,k) then [k,n), each with its own caches, as two peers hold them) matches
  an unsplit one exactly, on both backends, through prefill and decode;
- PyTorch matches MLX layer by layer and end to end, and in a mixed MLX -> fp16 wire -> PyTorch chain.

PyTorch vs MLX is checked tightly on bfloat16 weights. With 4-bit weights MLX's quantized matmul itself
is 0.5-0.8% off an exact dequantize-and-multiply, and a random tiny model amplifies any difference
(1-ulp noise on its input moves its logits ~10%), so there only per-layer error is checked.
"""
import json

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")
pytest.importorskip("mlx_lm.models.qwen3_5")

from podtorrent import slicer  # noqa: E402
from podtorrent.shard import Shard  # noqa: E402

from tests.tiny_qwen3_5 import build  # noqa: E402

N = 8
IDS = [5, 17, 200, 3, 99, 400, 12, 7, 300, 1, 44, 45]
CHUNKS = [IDS[:8]] + [[i] for i in IDS[8:]]     # a prefill, then one token per decode step
SPLITS = (1, 3, 4, 6)                             # inside a linear run, either side of a full-attention layer


@pytest.fixture(scope="module")
def q4(tmp_path_factory):
    d = tmp_path_factory.mktemp("qwen3_5_q4")
    return d, build(d, N)


@pytest.fixture(scope="module")
def bf16(tmp_path_factory):
    d = tmp_path_factory.mktemp("qwen3_5_bf16")
    return d, build(d, N, quantize=False)


def f32(a):
    if isinstance(a, mx.array):
        return np.array(a.astype(mx.float32))
    return a.detach().float().cpu().numpy()


def rel(a, b):
    a, b = f32(a).ravel(), f32(b).ravel()
    return float(np.linalg.norm(a - b) / np.linalg.norm(a))


def wire(h):
    """What a peer receives: fp16 hidden states."""
    return f32(h).astype(np.float16)


# ---- MLX ----

@pytest.mark.parametrize("which", ["q4", "bf16"])
def test_mlx_shard_matches_mlx_lm(which, request):
    d, ref = request.getfixturevalue(which)
    sh = Shard(d, 0, N, embed=True, head=True)
    rc, sc = ref.make_cache(), sh.make_cache()
    assert [type(c).__name__ for c in sc] == ["ArraysCache"] * 3 + ["KVCache"] + ["ArraysCache"] * 3 + ["KVCache"]
    for c in CHUNKS:
        ids = mx.array([c])
        want, got = ref(ids, cache=rc), sh.logits(sh.run_layers(sh.embed(ids), sc))
        np.testing.assert_array_equal(f32(want), f32(got))


@pytest.mark.parametrize("k", SPLITS)
def test_mlx_split_matches_unsplit(q4, k):
    d, _ = q4
    whole, a, b = Shard(d, 0, N, embed=True), Shard(d, 0, k, embed=True), Shard(d, k, N)
    cw, ca, cb = whole.make_cache(), a.make_cache(), b.make_cache()
    for c in CHUNKS:
        ids = mx.array([c])
        want = whole.run_layers(whole.embed(ids), cw)
        got = b.run_layers(a.run_layers(a.embed(ids), ca), cb)
        np.testing.assert_array_equal(f32(want), f32(got))


def test_one_shard_runs_pieces_with_their_own_caches(q4):
    """A peer serving [0, N) asked for [0,k) and [k,N) as separate hops keeps a cache per piece."""
    d, _ = q4
    sh = Shard(d, 0, N, embed=True)
    cw, c1, c2 = sh.make_cache(), sh.make_cache(0, 4), sh.make_cache(4, N)
    for c in CHUNKS:
        x = sh.embed(mx.array([c]))
        np.testing.assert_array_equal(f32(sh.run_layers(x, cw)),
                                      f32(sh.run_layers(sh.run_layers(x, c1, 0, 4), c2, 4, N)))


# ---- PyTorch ----

def torch_shard(d, lo, hi, **kw):
    pytest.importorskip("torch")
    from podtorrent.shard_torch import TorchShard
    return TorchShard(d, lo, hi, device="cpu", **kw)


def to_torch(h):
    import torch
    return torch.from_numpy(f32(h)).bfloat16()


@pytest.mark.parametrize("k", SPLITS)
def test_torch_split_matches_unsplit(bf16, k):
    d, _ = bf16
    whole, a, b = torch_shard(d, 0, N, embed=True), torch_shard(d, 0, k, embed=True), torch_shard(d, k, N)
    cw, ca, cb = whole.make_cache(), a.make_cache(), b.make_cache()
    assert [type(c).__name__ for c in cw] == ["LinearCache"] * 3 + ["KVCache"] + ["LinearCache"] * 3 + ["KVCache"]
    for c in CHUNKS:
        want = whole.run_layers(whole.embed([c]), cw)
        got = b.run_layers(a.run_layers(a.embed([c]), ca), cb)
        np.testing.assert_array_equal(f32(want), f32(got))


@pytest.mark.parametrize("which,per_layer", [("bf16", 0.02), ("q4", 0.04)])
def test_torch_matches_mlx_layer_by_layer(which, per_layer, request):
    """Each layer fed MLX's input to it, through prefill and decode (exercising both cache kinds)."""
    d, _ = request.getfixturevalue(which)
    ms, ts = Shard(d, 0, N, embed=True), torch_shard(d, 0, N)
    mc, tc = ms.make_cache(), ts.make_cache()
    rels = []
    for c in CHUNKS:
        h = ms.embed(mx.array([c]))
        for i in range(N):
            want = ms.run_layers(h, mc[i:i + 1], i, i + 1)
            got = ts.run_layers(to_torch(h), tc[i:i + 1], i, i + 1)
            rels.append(rel(want, got))
            h = want
    assert max(rels) < per_layer, rels
    assert np.median(rels) < per_layer / 2, rels


def top1_agrees(want, got, margin=0.25):
    """Top-1 tokens agree wherever MLX's best clearly beats its runner-up."""
    w, g = f32(want)[0], f32(got)[0]
    top2 = np.sort(w, -1)[:, -2:]
    clear = top2[:, 1] - top2[:, 0] > margin
    return bool((w.argmax(-1) == g.argmax(-1))[clear].all())


def check_chain(steps):
    """Logits over prefill + decode steps. As in tests/parity.py: router scores are bfloat16, so a
    near-tie between the 2nd and 3rd expert (about one ulp apart in this tiny model) can go either
    way after a few layers of rounding and move one step's logits ~15%. So: top-1 agreement on every
    step, a small typical error, and only a loose ceiling per step."""
    rels = []
    for want, got in steps:
        rels.append(rel(want, got))
        assert top1_agrees(want, got)
    assert max(rels) < 0.25 and np.median(rels) < 0.05, rels


def test_torch_matches_mlx_end_to_end(bf16):
    d, _ = bf16
    ms, ts = Shard(d, 0, N, embed=True, head=True), torch_shard(d, 0, N, embed=True, head=True)
    mc, tc = ms.make_cache(), ts.make_cache()
    check_chain((ms.logits(ms.run_layers(ms.embed(mx.array([c])), mc)),
                 ts.logits(ts.run_layers(ts.embed([c]), tc))) for c in CHUNKS)


@pytest.mark.parametrize("k", SPLITS)
def test_mixed_chain_mlx_then_torch(bf16, k):
    """MLX peer [0,k) -> fp16 wire -> PyTorch peer [k,N) (head included), against all-MLX."""
    import torch
    d, _ = bf16
    whole = Shard(d, 0, N, embed=True, head=True)
    a, b = Shard(d, 0, k, embed=True), torch_shard(d, k, N, head=True)
    cw, ca, cb = whole.make_cache(), a.make_cache(), b.make_cache()

    def step(c):
        ids = mx.array([c])
        want = whole.logits(whole.run_layers(whole.embed(ids), cw))
        h = torch.from_numpy(wire(a.run_layers(a.embed(ids), ca))).bfloat16()
        return want, b.logits(b.run_layers(h, cb))
    check_chain(step(c) for c in CHUNKS)


# ---- config and download plumbing ----

def test_text_config_and_slice_selection(q4):
    d, _ = q4
    cfg = json.loads((d / "config.json").read_text())
    assert "num_hidden_layers" not in cfg and slicer.text_config(cfg)["num_hidden_layers"] == N
    wm = json.loads((d / "model.safetensors.index.json").read_text())["weight_map"]
    tail = slicer.select_tensors(wm, 6, 8, host=False, tail=True)
    assert "language_model.lm_head.weight" in tail and "language_model.model.norm.weight" in tail
    assert all(n.startswith(("language_model.model.layers.6.", "language_model.model.layers.7.",
                             "language_model.lm_head.", "language_model.model.norm.")) for n in tail)
    host = slicer.select_tensors(wm, 0, 1, host=True, tail=False)
    assert "language_model.model.embed_tokens.weight" in host and not any("lm_head" in n for n in host)
    assert 0 < slicer.estimate_slice_bytes(d, 0, 4) < slicer.estimate_slice_bytes(d, 0, 8)


def test_catalog_info_reads_text_config(monkeypatch):
    from podtorrent import catalog
    files = {"config.json": {"model_type": "qwen3_5_moe", "text_config": {"model_type": "qwen3_5_moe_text",
                                                                           "num_hidden_layers": 48}},
             "model.safetensors.index.json": {"metadata": {"total_size": 48 * 2**30}}}

    class R:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            pass

        def json(self):
            return self.body
    monkeypatch.setattr(catalog.httpx, "get", lambda url, **kw: R(files[url.rsplit("/", 1)[-1]]))
    inf = catalog.info("o/Qwen3.5-122B-A10B-4bit")
    assert inf["model_type"] == "qwen3_5_moe" and inf["n_layers"] == 48 and inf["layer_bytes"] == 2**30
