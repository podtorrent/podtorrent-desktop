"""Golden test: greedy decode through a chain of peers must match a single-process reference.

Usage: python -m tests.golden MODEL_DIR --layers 16 --splits 5,10
Spawns one `podtorrent peer` per slice ([0,5), [5,10), [10,16) above), each with its own identity,
lets them find each other through the rendezvous and connect over QUIC, then sends every prompt
to the first peer's /api/complete and compares tokens and logits with the reference.
"""
import argparse
import gc
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import mlx.core as mx
from mlx_lm.utils import load_tokenizer

from podtorrent.shard import Shard

PROMPTS = [
    "The capital of France is", "def fibonacci(n):", "Explain photosynthesis in one sentence.",
    "2 + 2 =", "Once upon a time, in a small village,", "The three primary colors are",
    "import numpy as np\n", "Q: Who wrote Hamlet?\nA:", "Translate to French: Good morning",
    "The speed of light is approximately", "List three fruits:", "In 1969, humans first",
    "SELECT * FROM users WHERE", "The largest planet in our solar system is",
    "Write a haiku about rain:", "What is the square root of 144?", "Water boils at",
    "The Python keyword for defining a function is", "Albert Einstein was born in",
    "A binary search runs in time",
]


def http(url, body=None, timeout=600):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--layers", type=int, default=16)
    ap.add_argument("--splits", default="8", help="comma-separated slice boundaries")
    ap.add_argument("--tokens", type=int, default=12)
    ap.add_argument("--port", type=int, default=8100)
    ap.add_argument("--prompts", type=int, default=len(PROMPTS))
    a = ap.parse_args()
    prompts = PROMPTS[:a.prompts]
    tok = load_tokenizer(Path(a.model_dir))

    # Reference: all layers in this process.
    ref = Shard(a.model_dir, 0, a.layers, embed=True, head=True)
    ref_out = []
    for p in prompts:
        ids = mx.array(tok.encode(p))[None]
        cache, toks = ref.make_cache(), []
        for _ in range(a.tokens):
            lg = ref.logits(ref.run_layers(ref.embed(ids), cache)[:, -1:, :])[0, -1]
            t = int(mx.argmax(lg).item())
            toks.append(t)
            ids = mx.array([[t]])
        ref_out.append(toks)
    del ref
    gc.collect()
    mx.clear_cache()

    bounds = [0, *(int(x) for x in a.splits.split(",")), a.layers]
    slices = list(zip(bounds, bounds[1:]))
    tmp = Path(tempfile.mkdtemp(prefix="podtorrent-golden-"))
    procs = []
    for i, (lo, hi) in enumerate(slices):
        env = {**os.environ, "PODTORRENT_HOME": str(tmp / f"peer{i}")}
        log = open(tmp / f"peer{i}.log", "w")
        procs.append(subprocess.Popen(
            [sys.executable, "-m", "podtorrent.cli", "peer", "--model-dir", a.model_dir, "--layers", str(a.layers),
             "--port", str(a.port + i), "--serve", f"{lo}:{hi}"], env=env, stdout=log, stderr=subprocess.STDOUT))
    print(f"peers: {slices} (logs in {tmp})")
    base = f"http://127.0.0.1:{a.port}"
    try:
        for _ in range(300):
            try:
                st = http(base + "/status", timeout=3)
                if len(st["route"]) == len(slices):
                    break
            except OSError:
                pass
            time.sleep(1)
        else:
            sys.exit(f"no full route; last status: {st}")
        print("route:", " → ".join(f"{n} [{lo},{hi})" for n, lo, hi in st["route"]))
        fails, nets = 0, []
        for p, rt in zip(prompts, ref_out):
            r = http(base + "/api/complete", {"ids": tok.encode(p), "max_tokens": a.tokens})
            if "error" in r:
                sys.exit(f"error: {r['error']}")
            ok = r["tokens"] == rt
            fails += not ok
            for tm in r["timings"][1:]:
                nets.append(sum(s["compute_ms"] for s in tm["stages"] if s["node"] == "network"))
            print(f"{'PASS' if ok else 'FAIL'} {p!r}" + ("" if ok else f"\n  got {r['tokens']}\n  ref {rt}"))
        print(f"\n{len(prompts) - fails}/{len(prompts)} token-exact; "
              f"mean network+serde {sum(nets) / max(len(nets), 1):.2f} ms/token over {len(slices) - 1} remote hops")
        sys.exit(1 if fails else 0)
    finally:
        for pr in procs:
            pr.terminate()


if __name__ == "__main__":
    main()
