"""Fused decode kernels (podtorrent/torch_kernels.py) against the reference dequantize-and-multiply, and
shard_torch's GPU decode path (Triton kernels + CUDA graphs) against its reference path.

The PyTorch versions run everywhere. The Triton versions and the decode path need a GPU with Triton; run
this file directly (`python tests/test_torch_kernels.py`) on such a machine when pytest isn't installed.
"""
import sys
from pathlib import Path

import torch

try:
    import pytest
except ImportError:  # run directly on a GPU machine without pytest: a stand-in for the one decorator used
    class _Mark:
        def __init__(self, name, args):
            self.name, self.args = name, args

    class pytest:
        class mark:
            @staticmethod
            def parametrize(*args):
                def deco(fn):
                    fn.pytestmark = [*getattr(fn, "pytestmark", []), _Mark("parametrize", args)]
                    return fn
                return deco

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from podtorrent import torch_kernels as tk

DTYPE = torch.bfloat16


def rel(a, b):
    a, b = a.float(), b.float()
    return float((a - b).norm() / b.norm().clamp_min(1e-12))


def qweights(lead, N, K, gs=64, bits=4, seed=0, device="cpu"):
    g = torch.Generator().manual_seed(seed)
    w, s, b = tk.quantize_ref(torch.randn(*lead, N, K, generator=g) * 0.05, gs, bits)
    return w.to(device), s.to(device), b.to(device)


def devices():
    out = ["cpu"]
    if torch.cuda.is_available():
        out.append("cuda")
    return out


@pytest.mark.parametrize("bits", [4, 8])
def test_quantize_ref_roundtrip(bits):
    """quantize_ref writes the layout tk.dequantize (the reference unpacker) reads."""
    g = torch.Generator().manual_seed(1)
    wf = torch.randn(3, 40, 128, generator=g)
    w, s, b = tk.quantize_ref(wf, 64, bits)
    back = tk.dequantize(w, s, b, 64)
    step = s.float().repeat_interleave(64, -1)   # plus bfloat16 rounding of the scale and offset
    assert ((back - wf).abs() <= step * 0.51 + 0.03).all()
    assert rel(back, wf) < (0.1 if bits == 4 else 0.01)


def ref_dense(x, w, s, b, gs):
    return (x.float() @ tk.dequantize(w, s, b, gs).T).to(DTYPE)


def ref_expert(x, w, s, b, gs, e):
    return (x.float() @ tk.dequantize(w[e], s[e], b[e], gs).T).to(DTYPE)


def impls(device):
    yield "torch", tk.qmv_torch, tk.qmv_moe_down_torch
    if device != "cpu" and tk.triton_ok(device):
        yield "triton", tk.qmv_triton, tk.qmv_moe_down_triton


@pytest.mark.parametrize("device", devices())
@pytest.mark.parametrize("bits", [4, 8])
@pytest.mark.parametrize("rows", [1, 3])
def test_qmv_dense(device, bits, rows):
    w, s, b = qweights((), 200, 512, bits=bits, device=device)
    x = torch.randn(rows, 512, device=device).to(DTYPE)
    want = ref_dense(x, w, s, b, 64)
    for name, qmv, _ in impls(device):
        assert rel(qmv(x, w, s, b, 64), want) < 2e-3, name


@pytest.mark.parametrize("device", devices())
def test_qmv_experts_and_swiglu(device):
    E, N, K, k = 6, 96, 256, 3
    wg, wu = qweights((E,), N, K, device=device), qweights((E,), N, K, seed=1, device=device)
    x = torch.randn(2, K, device=device).to(DTYPE)
    eids = torch.tensor([5, 0, 2, 2, 4, 1], device=device)
    want_g = torch.stack([ref_expert(x[r // k], *wg, 64, int(eids[r])) for r in range(6)])
    want_u = torch.stack([ref_expert(x[r // k], *wu, 64, int(eids[r])) for r in range(6)])
    want = (torch.nn.functional.silu(want_g.float()) * want_u.float()).to(DTYPE)
    for name, qmv, _ in impls(device):
        assert rel(qmv(x, *wg, 64, eids, xdiv=k), want_g) < 2e-3, name
        if name == "torch":
            got = tk.qmv_swiglu_torch(x, wg, wu, 64, eids, xdiv=k)
        else:
            got = tk.qmv_triton(x, *wg, 64, eids, xdiv=k, wu=wu)
        assert rel(got, want) < 4e-3, name


@pytest.mark.parametrize("device", devices())
@pytest.mark.parametrize("residual", [False, True])
def test_moe_down(device, residual):
    E, N, K, k, T = 5, 128, 192, 2, 3
    w, s, b = qweights((E,), N, K, gs=64, device=device)
    h = torch.randn(T * k, K, device=device).to(DTYPE)
    eids = torch.tensor([4, 0, 1, 1, 3, 2], device=device)
    scores = torch.rand(T * k, device=device).to(DTYPE)
    res = torch.randn(T, N, device=device).to(DTYPE) if residual else None
    outs = [ref_expert(h[r], w, s, b, 64, int(eids[r])) for r in range(T * k)]
    want = torch.stack([sum(((outs[t * k + j] * scores[t * k + j]).float() for j in range(k)),
                            torch.zeros(N, device=device)).to(DTYPE) for t in range(T)])
    if residual:
        want = res + want
    for name, _, down in impls(device):
        assert rel(down(h, w, s, b, 64, eids, scores, k, res), want) < 4e-3, name


def test_router_ties_prefer_higher_index():
    logits = torch.tensor([[1.0, 3.0, 2.0, 3.0, 0.5]])
    inds, scores = tk.router_torch(logits, 2, True)
    assert inds.tolist() == [[3, 1]]
    assert abs(float(scores.float().sum()) - 1) < 1e-2


# ---- shard_torch's GPU decode path ----

def gpu_or_skip():
    if not (torch.cuda.is_available() and tk.triton_ok("cuda")):
        pytest.skip("needs a GPU with Triton")


_ckpts = {}


def ckpt(kind):
    """A small random checkpoint: 'qwen3_moe' (4 attention layers) or 'qwen3_5' (8 layers, full attention
    at 3 and 7), with a head."""
    import tempfile

    from tests import synthetic
    if kind not in _ckpts:
        d = Path(tempfile.mkdtemp(prefix=f"pt-{kind}-"))
        text, n = (synthetic.QWEN3_MOE_SMALL, 4) if kind == "qwen3_moe" else (synthetic.QWEN3_5_SMALL, 8)
        _ckpts[kind] = (synthetic.make(d, n, text, head=True), n)
    return _ckpts[kind]


def clone_caches(cl, device):
    """A fresh CacheList holding copies of cl's tensors (no captured graph)."""
    from podtorrent import shard_torch as st
    out = []
    for c in cl:
        n = type(c)()
        n.offset = c.offset
        if isinstance(c, st.KVCache):
            n.k, n.v = (None if t is None else t.clone() for t in (c.k, c.v))
        else:
            n.conv, n.state = (None if t is None else t.clone() for t in (c.conv, c.state))
        out.append(n)
    return st.CacheList(out, device)


def hidden(g, n, H):
    return (torch.randn(1, n, H, generator=g) * 0.5).to("cuda", DTYPE)


@pytest.mark.parametrize("kind", ["qwen3_moe", "qwen3_5"])
def test_gpu_decode_matches_reference_per_layer(kind):
    """Each layer, same input and same cache: fused decode step vs the reference path."""
    gpu_or_skip()
    from podtorrent import shard_torch as st
    d, n = ckpt(kind)
    sh = st.TorchShard(d, 0, n, device="cuda")
    H = sh.cfg["hidden_size"]
    g = torch.Generator().manual_seed(0)
    assert all(layer.fast for layer in sh.layers)
    for i in range(n):
        c = sh.make_cache(i, i + 1)
        sh.run_layers(hidden(g, 12, H), c, i, i + 1)     # prefill: reference path
        for _ in range(5):
            x = hidden(g, 1, H)
            ref = clone_caches(c, "cuda")
            st.set_fast(False)
            want = sh.run_layers(x, ref, i, i + 1)
            st.set_fast(True)
            got = sh.run_layers(x, clone_caches(c, "cuda"), i, i + 1)
            assert rel(got, want) < 1e-2, (kind, i, rel(got, want))
            c = ref


@pytest.mark.parametrize("kind", ["qwen3_moe", "qwen3_5"])
@pytest.mark.parametrize("prompt", [9, 254])
def test_gpu_split_matches_unsplit_and_graphs_match_eager(kind, prompt):
    """Two peers' worth of layers, each with its own caches, equal one shard exactly; so do CUDA-graph
    replays and eager steps. prompt=254 crosses the KV cache's 256-position step mid-decode (regrow and
    recapture)."""
    gpu_or_skip()
    from podtorrent import shard_torch as st
    d, n = ckpt(kind)
    k = n // 2 + 1
    whole, a, b = st.TorchShard(d, 0, n, device="cuda"), st.TorchShard(d, 0, k, device="cuda"), \
        st.TorchShard(d, k, n, device="cuda")
    H = whole.cfg["hidden_size"]
    g = torch.Generator().manual_seed(1)
    xs = [hidden(g, prompt, H)] + [hidden(g, 1, H) for _ in range(8)]
    cw, ca, cb, ce = whole.make_cache(), a.make_cache(), b.make_cache(), whole.make_cache()
    try:
        for step, x in enumerate(xs):
            want = whole.run_layers(x, cw)
            got = b.run_layers(a.run_layers(x, ca), cb)
            assert torch.equal(got, want), (kind, step, rel(got, want))
            st.GRAPHS = False
            eager = whole.run_layers(x, ce)
            st.GRAPHS = True
            assert torch.equal(eager, want), (kind, step, rel(eager, want))
        assert cw.graph is not None and ce.graph is None
    finally:
        st.GRAPHS = True


@pytest.mark.parametrize("kind", ["qwen3_moe", "qwen3_5"])
def test_gpu_logits_match_reference(kind):
    gpu_or_skip()
    from podtorrent import shard_torch as st
    d, _ = ckpt(kind)
    hd = st.TorchShard(d, 0, 0, head=True, device="cuda")
    h = hidden(torch.Generator().manual_seed(2), 1, hd.cfg["hidden_size"])
    got = hd.logits(h)
    st.set_fast(False)
    want = hd.logits(h)
    st.set_fast(True)
    assert rel(got, want) < 2e-3 and torch.equal(got.argmax(-1), want.argmax(-1))


def test_gpu_router_and_norm_kernels():
    gpu_or_skip()
    g = torch.Generator().manual_seed(3)
    # Coarse logits make exact ties in the bfloat16 softmax, as real routers do.
    logits = (torch.randint(0, 12, (5, 128), generator=g).float() / 4).to("cuda", DTYPE)
    for k, norm in ((8, True), (8, False), (2, True)):
        want_i, want_s = tk.router_torch(logits, k, norm)
        got_i, got_s = tk.router_triton(logits, k, norm)
        assert torch.equal(got_i.long(), want_i.reshape(-1)), (k, norm)
        assert torch.equal(got_s, want_s.reshape(-1)), (k, norm)
    x, a = (torch.randn(3, 2048, generator=g).to("cuda", DTYPE) for _ in range(2))
    w = (1 + 0.1 * torch.randn(2048, generator=g)).to("cuda", DTYPE)
    h, out = tk.add_rms_norm_triton(x, a, w, 1e-6)
    assert torch.equal(h, x + a)
    assert rel(out, tk.rms_norm_torch(x + a, w, 1e-6)) < 1e-3


if __name__ == "__main__":
    import itertools
    fails = 0
    for name, fn in list(globals().items()):
        if not name.startswith("test_"):
            continue
        marks = getattr(fn, "pytestmark", [])
        grids = [(m.args[0].split(","), m.args[1]) for m in marks if m.name == "parametrize"]
        names = [n for ns, _ in grids for n in ns]
        for combo in itertools.product(*[vals for _, vals in grids]):
            flat = []
            for (ns, _), v in zip(grids, combo):
                flat += list(v) if len(ns) > 1 else [v]
            kw = dict(zip(names, flat))
            try:
                fn(**kw)
                print("ok  ", name, kw)
            except pytest.skip.Exception as e:
                print("skip", name, kw, e)
            except Exception as e:  # noqa: BLE001
                fails += 1
                print("FAIL", name, kw, type(e).__name__, e)
    print("triton:", {d: tk.triton_ok(d) for d in devices() if d != "cpu"})
    sys.exit(1 if fails else 0)
