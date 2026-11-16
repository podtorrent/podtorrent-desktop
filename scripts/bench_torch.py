"""Time the PyTorch backend on a slice of a real model, so numbers compare between machines.

    python scripts/bench_torch.py ~/.podtorrent/models/Qwen3-30B-A3B-4bit --lo 24 --hi 48

Loads global layers [lo, hi) with TorchShard, runs a prefill of --prompt positions, then --steps
decode steps of one token each, and prints ms per decode token for the slice and per layer.
The input is random hidden states (fixed seed), so no embeddings are needed: any slice on disk works.

--compare also runs the same steps with the fast paths off (PODTORRENT_TORCH_FAST=0 behaviour) on the
same weights and prints how far the outputs drift apart, next to a yardstick: the reference path again
with about half its input values moved by one bfloat16 step (the size of difference any rounding change
upstream makes). --profile prints the top ops of one step.

--synthetic DIR writes a random-weight checkpoint with the layer shapes of Qwen3.5-122B-A10B-4bit
(gated DeltaNet layers, full attention every 4th, 256 experts) into DIR (about 1.4 GB per layer) and
benchmarks that instead, for machines that don't have the real model:

    python scripts/bench_torch.py --synthetic /tmp/q35 --hi 4
"""
import argparse
import statistics
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from podtorrent import shard_torch
from podtorrent.shard_torch import DTYPE, TorchShard
from tests import synthetic


def sync(device):
    if device.startswith("cuda"):
        torch.cuda.synchronize()


def run(sh, x0, toks, args):
    cache = sh.make_cache()
    sync(sh.device)
    t = time.perf_counter()
    outs = [sh.run_layers(x0, cache)]
    sync(sh.device)
    prefill = time.perf_counter() - t
    times = []
    for tok in toks:
        t = time.perf_counter()
        outs.append(sh.run_layers(tok, cache))
        sync(sh.device)
        times.append(time.perf_counter() - t)
    if args.profile:
        from torch.profiler import ProfilerActivity, profile
        acts = [ProfilerActivity.CPU] + ([ProfilerActivity.CUDA] if sh.device.startswith("cuda") else [])
        with profile(activities=acts) as prof:
            sh.run_layers(toks[-1], cache)
            sync(sh.device)
        key = "cuda_time_total" if sh.device.startswith("cuda") else "cpu_time_total"
        print(prof.key_averages().table(sort_by=key, row_limit=25))
    return prefill, times, outs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", type=Path, nargs="?")
    ap.add_argument("--synthetic", type=Path, metavar="DIR")
    ap.add_argument("--lo", type=int, default=0)
    ap.add_argument("--hi", type=int, default=4)
    ap.add_argument("--prompt", type=int, default=32)
    ap.add_argument("--steps", type=int, default=32)
    ap.add_argument("--warmup", type=int, default=3, help="decode steps left out of the timing")
    ap.add_argument("--device")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--profile", action="store_true")
    ap.add_argument("--head", action="store_true", help="also time the final norm + lm_head (logits) per token")
    args = ap.parse_args()
    if args.synthetic:
        if not (args.synthetic / "config.json").exists():
            synthetic.make(args.synthetic, args.hi, synthetic.QWEN3_5_122B)
        args.model = args.synthetic
    elif args.model is None:
        ap.error("give a model directory or --synthetic DIR")

    t = time.perf_counter()
    sh = TorchShard(args.model, args.lo, args.hi, device=args.device)
    sync(sh.device)
    load = time.perf_counter() - t
    n = args.hi - args.lo
    mem = torch.cuda.max_memory_allocated() / 2**30 if sh.device.startswith("cuda") else float("nan")
    print(f"device {sh.device}  torch {torch.__version__}  layers [{args.lo},{args.hi})  "
          f"load {load:.1f}s  peak GPU memory {mem:.2f} GB")
    if hasattr(shard_torch, "describe"):
        print("fast paths:", shard_torch.describe())

    g = torch.Generator().manual_seed(0)
    hid = sh.cfg["hidden_size"]
    x0 = (torch.randn(1, args.prompt, hid, generator=g) * 0.5).to(sh.device, DTYPE)
    toks = [(torch.randn(1, 1, hid, generator=g) * 0.5).to(sh.device, DTYPE)
            for _ in range(args.warmup + args.steps)]

    prefill, times, outs = run(sh, x0, toks, args)
    dec = times[args.warmup:]
    ms = statistics.median(dec) * 1e3
    print(f"prefill {args.prompt} positions: {prefill * 1e3:.0f} ms (first call, includes warm-up)")
    print(f"decode: {ms:.2f} ms/token for {n} layers = {ms / n:.3f} ms/layer "
          f"(median of {len(dec)}, min {min(dec) * 1e3:.2f}, max {max(dec) * 1e3:.2f})")
    print(f"        -> 48 layers would take {ms / n * 48:.0f} ms/token = {1000 / (ms / n * 48):.2f} tok/s")

    if args.head:
        hd = TorchShard(args.model, 0, 0, head=True, device=sh.device)
        x = toks[0]

        def time_logits():
            out = hd.logits(x)
            ts = []
            for _ in range(20):
                sync(sh.device)
                t = time.perf_counter()
                out = hd.logits(x)
                sync(sh.device)
                ts.append(time.perf_counter() - t)
            return statistics.median(ts) * 1e3, out
        fms, fout = time_logits()
        msg = f"logits (norm + lm_head, one position): {fms:.2f} ms"
        if hasattr(shard_torch, "set_fast"):
            shard_torch.set_fast(False)
            rms_, rout = time_logits()
            shard_torch.set_fast(True)
            same = bool((fout.float().argmax(-1) == rout.float().argmax(-1)).all())
            msg += f"; reference path {rms_:.2f} ms; same top token: {same}"
        print(msg)

    if args.compare:
        if not hasattr(shard_torch, "set_fast"):
            sys.exit("--compare needs a shard_torch with set_fast()")
        shard_torch.set_fast(False)
        _, rtimes, routs = run(sh, x0, toks, args)
        def nudge(t):
            gn = torch.Generator().manual_seed(1)
            n = torch.randn(t.shape, generator=gn).to(t.device) * t.float().abs() * 2 ** -8
            return (t.float() + n).to(DTYPE)
        _, _, wouts = run(sh, nudge(x0), [nudge(t) for t in toks], args)
        shard_torch.set_fast(True)
        rms = statistics.median(rtimes[args.warmup:]) * 1e3

        def rels(xs):
            r = [float((a.float() - b.float()).norm() / b.float().norm()) for a, b in zip(xs, routs)]
            return f"decode max {max(r[1:]):.2e} median {statistics.median(r[1:]):.2e}"
        print(f"reference path: {rms:.2f} ms/token  ({rms / ms:.1f}x slower)")
        print(f"relative difference fast vs reference:                 {rels(outs)}")
        print(f"yardstick, reference with inputs nudged by ~1 ulp:     {rels(wouts)}")


if __name__ == "__main__":
    main()
