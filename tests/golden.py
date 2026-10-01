"""Golden test: greedy decode through host+worker must match a single-process reference.

Usage: python -m tests.golden MODEL_DIR --layers 16 --split 8 [--worker HOST:PORT]
If --worker is omitted a local worker subprocess is spawned.
"""
import argparse
import gc
import subprocess
import sys
import time

import mlx.core as mx
from mlx_lm.utils import load_tokenizer
from pathlib import Path

from podtorrent.host import Host
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


def cos(a, b):
    return (a @ b / (mx.linalg.norm(a) * mx.linalg.norm(b))).item()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--layers", type=int, default=16)
    ap.add_argument("--split", type=int, default=8)
    ap.add_argument("--tokens", type=int, default=12)
    ap.add_argument("--worker")
    ap.add_argument("--port", type=int, default=50061)
    a = ap.parse_args()
    tok = load_tokenizer(Path(a.model_dir))

    # Reference: all layers in this process
    ref = Shard(a.model_dir, 0, a.layers, embed=True, head=True)
    ref_out = []
    for p in PROMPTS:
        ids = mx.array(tok.encode(p))[None]
        cache, toks, lgs = ref.make_cache(), [], []
        for _ in range(a.tokens):
            lg = ref.logits(ref.run_layers(ref.embed(ids), cache)[:, -1:, :])[0, -1].astype(mx.float32)
            t = int(mx.argmax(lg).item())
            toks.append(t); lgs.append(lg)
            ids = mx.array([[t]])
        ref_out.append((toks, lgs))
    del ref; gc.collect(); mx.clear_cache()

    proc = None
    addr = a.worker
    if not addr:
        proc = subprocess.Popen([sys.executable, "-m", "podtorrent.cli", "worker-static", "--model-dir", a.model_dir,
                                 "--lo", str(a.split), "--hi", str(a.layers), "--port", str(a.port)])
        addr = f"localhost:{a.port}"
    host = Host(Shard(a.model_dir, 0, a.split, embed=True, head=True), tok, addr)
    for _ in range(600):
        try:
            host.info(); break
        except Exception:
            time.sleep(1)
    fails, mincos, rtts = 0, 1.0, []
    for p, (rt, rl) in zip(PROMPTS, ref_out):
        evs = list(host.generate(tok.encode(p), a.tokens, keep_logits=True))
        toks = [e.token for e in evs]
        c = min(cos(e.logits, l) for e, l in zip(evs, rl))
        mincos = min(mincos, c)
        ok = toks == rt[:len(toks)] and len(toks) == len(rt)
        fails += not ok
        rtts += [e.network_ms for e in evs[1:]]
        print(f"{'PASS' if ok else 'FAIL'} cos={c:.5f} {p!r}")
    print(f"\n{len(PROMPTS)-fails}/{len(PROMPTS)} token-exact; min logit cosine {mincos:.5f}; "
          f"mean net+serde {sum(rtts)/len(rtts):.2f} ms/token")
    if proc: proc.terminate()
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
