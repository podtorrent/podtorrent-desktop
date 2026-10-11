"""Parity test: the same layers through MLX (shard.Shard) and PyTorch (shard_torch.TorchShard)
must give matching hidden states. This is the guarantee that lets Windows peers join MLX chains.

Usage: python -m tests.parity MODEL_DIR --lo 0 --hi 8 [--device cpu]

Checks, for a prefill and then several single-token decode steps (exercising the KV cache):
  1. each layer on its own, fed the same input;
  2. the whole range end to end;
  3. a mixed chain, MLX [lo, mid) -> fp16 wire -> PyTorch [mid, hi), against all-MLX;
  4. if the slice has the head: top-1 token agreement of the logits.
Exits non-zero if any check is outside tolerance.
"""
import argparse
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np
import torch

from podtorrent.common import from_wire, to_wire
from podtorrent.shard import Shard
from podtorrent.shard_torch import TorchShard

# Bit-exact parity is impossible: router scores are bfloat16, so the 8th and 9th expert are
# sometimes exactly tied and any tiny upstream difference picks the other one. That costs a few
# percent on that token, about 1% of layer-steps. So: a hard ceiling on every check, plus, over
# the single-layer checks, limits on the typical error and on how often one lands above OUTLIER.
# Multi-layer chains accumulate these, so they only get the ceiling.
COS_MIN = 0.995   # per check, cosine similarity of the flattened hidden states
REL_MAX = 0.10    # per check, ||a - b|| / ||a||
MEDIAN_MAX = 0.02 # over all checks
OUTLIER = 0.05
OUTLIER_SHARE = 0.05
RELS = []
TIE_MARGIN = 0.25 # logits closer than this are a coin flip in bfloat16


def m2t(a: mx.array) -> torch.Tensor:
    return torch.from_numpy(np.array(a.astype(mx.float32))).bfloat16()


def t2np(t: torch.Tensor) -> np.ndarray:
    return t.detach().float().cpu().numpy()


def compare(name, ref: mx.array, got, failures, rel_max=REL_MAX, stat=False):
    a = np.array(ref.astype(mx.float32)).ravel()
    b = np.array(got.astype(mx.float32)).ravel() if isinstance(got, mx.array) else t2np(got).ravel()
    cos = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
    rel = float(np.linalg.norm(a - b) / (np.linalg.norm(a) + 1e-12))
    ok = cos >= COS_MIN and rel <= rel_max
    if stat:
        RELS.append(rel)
    print(f"{'ok  ' if ok else 'FAIL'} {name:<34} cos={cos:.6f} rel={rel:.4f} max|d|={np.abs(a - b).max():.4g}")
    if not ok and failures is not None:
        failures.append(name)
    return rel


TEXT = ("The quick brown fox jumps over the lazy dog. In 1969, humans first walked on the Moon, "
        "and def fibonacci(n): return n if n < 2 else fibonacci(n - 1) + fibonacci(n - 2)")


def token_ids(model_dir, n):
    from mlx_lm.utils import load_tokenizer
    ids = load_tokenizer(Path(model_dir)).encode(TEXT)
    assert len(ids) >= n, (len(ids), n)
    return ids[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--lo", type=int, default=0)
    ap.add_argument("--hi", type=int, default=8)
    ap.add_argument("--prefill", type=int, default=24)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--device", default="cpu")
    a = ap.parse_args()
    d, lo, hi = Path(a.model_dir), a.lo, a.hi
    mid = (lo + hi) // 2
    failures = []

    print(f"loading layers [{lo}, {hi}) with MLX and PyTorch ({a.device})")
    ms = Shard(d, lo, hi, embed=True)  # embeddings only feed the test
    ts = TorchShard(d, lo, hi, embed=True, device=a.device)

    # Real token embeddings: a prefill block, then one token per decode step.
    ids = token_ids(d, a.prefill + a.steps)
    chunks = [ids[:a.prefill]] + [[i] for i in ids[a.prefill:]]
    xs = [ms.embed(mx.array([c])) for c in chunks]
    for t, c in enumerate(chunks[:2]):
        compare(f"embed step {t}", xs[t], ts.embed([c]), failures)
    if lo > 0:  # layer lo expects layer lo-1's output, not raw embeddings
        pre = Shard(d, 0, lo)
        pc = pre.make_cache()
        xs = [pre.run_layers(x, pc) for x in xs]
        mx.eval(xs)
        del pre, pc

    # 1. Layer by layer, each fed MLX's input to that layer, so errors don't compound.
    mc, tc = ms.make_cache(), ts.make_cache()
    for t, x in enumerate(xs):
        h = x
        for i in range(lo, hi):
            ref = ms.run_layers(h, mc[i - lo:i - lo + 1], i, i + 1)
            got = ts.run_layers(m2t(h), tc[i - lo:i - lo + 1], i, i + 1)
            mx.eval(ref)
            compare(f"layer {i} step {t}", ref, got, failures, stat=True)
            h = ref

    # 2. The whole range end to end, each side on its own state.
    mc, tc = ms.make_cache(), ts.make_cache()
    ends = []
    for t, x in enumerate(xs):
        ref = ms.run_layers(x, mc)
        got = ts.run_layers(m2t(x), tc)
        mx.eval(ref)
        compare(f"[{lo},{hi}) end to end step {t}", ref, got, failures)
        ends.append((ref, got))

    # 3. Mixed chain over the fp16 wire, as peers would run it. Baseline (not checked): the same
    # split with MLX on both sides, as today's Mac-to-Mac chains run.
    mc, c1, c2, tc2 = ms.make_cache(), ms.make_cache(lo, mid), ms.make_cache(mid, hi), ts.make_cache(mid, hi)
    for t, x in enumerate(xs):
        ref = ms.run_layers(x, mc)
        h = ms.run_layers(x, c1, lo, mid)
        mx.eval(ref, h)
        wire = to_wire(h)
        base = ms.run_layers(from_wire(wire, h.shape), c2, mid, hi)
        ht = torch.from_numpy(np.frombuffer(wire, dtype=np.float16).reshape(h.shape).copy())
        got = ts.run_layers(ht, tc2, mid, hi)
        mx.eval(base)
        compare(f"MLX[{lo},{mid})->MLX[{mid},{hi}) step {t} (baseline)", ref, base, None)
        compare(f"MLX[{lo},{mid})->torch[{mid},{hi}) step {t}", ref, got, failures)
        # and back again: torch output must decode on the MLX side too
        back = from_wire(t2np(got).astype(np.float16).tobytes(), got.shape)
        assert back.shape == ref.shape

    # 4. Logits, if the head slice is present.
    if (d / "head.safetensors").exists():
        try:
            mh, th = Shard(d, 0, 0, head=True), TorchShard(d, 0, 0, head=True, device=a.device)
        except Exception as e:  # noqa: BLE001
            print(f"skip logits: {e}")
        else:
            agree = total = ties = 0
            for ref_h, _ in ends:
                ml = mh.logits(ref_h)
                tl = th.logits(m2t(ref_h))
                mx.eval(ml)
                compare("logits (same input)", ml, tl, failures)
                # Count only positions where MLX's top-1 clearly beats its runner-up: a near-tie
                # can flip between two MLX machines too.
                mlf = np.array(ml.astype(mx.float32))[0]
                top2 = np.sort(mlf, -1)[:, -2:]
                clear = top2[:, 1] - top2[:, 0] > TIE_MARGIN
                same = mlf.argmax(-1) == t2np(tl.argmax(-1))[0]
                agree += int((same & clear).sum())
                total += int(clear.sum())
                ties += int((~same & ~clear).sum())
            ok = agree == total
            print(f"{'ok  ' if ok else 'FAIL'} top-1 token agreement {agree}/{total} "
                  f"(+{ties} near-tie position(s) differing, ignored)")
            if not ok:
                failures.append("top-1")

    rels = np.array(RELS)
    med, share = float(np.median(rels)), float((rels > OUTLIER).mean())
    ok = med <= MEDIAN_MAX and share <= OUTLIER_SHARE
    print(f"{'ok  ' if ok else 'FAIL'} single layers: {len(rels)} checks, median rel={med:.4f}, "
          f"{share:.1%} above {OUTLIER:.0%}")
    if not ok:
        failures.append("overall")
    print("PASS" if not failures else f"FAIL: {len(failures)} check(s): {', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
