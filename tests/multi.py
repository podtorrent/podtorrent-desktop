"""Phase 5 test: several slices and several models per peer, serve / unserve, memory checks, coverage.

Usage: python -m tests.multi MODEL_DIR

No downloads: a second model, `local/alias`, is MODEL_DIR's first 8 layers under another name (its
files are symlinked, with num_hidden_layers patched to 8). Two peers:

    A: default [0,5) [10,16)   alias [0,4)
    B: default [5,10)          alias [4,8)

Checks that both models answer token-exact against single-process references, that /api/models
reports both as available, that unserving alias [4,8) on B turns it partial with gap 4–7, that
serving it on A brings it back, that a slice too big for B's (capped) memory budget is refused up front, and that
A's config.json remembers its slices.
"""
import argparse
import gc
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import mlx.core as mx
from mlx_lm.utils import load_tokenizer

from podtorrent.shard import Shard
from tests.golden import http

ALIAS = "local/alias"
PROMPTS = ["The capital of France is", "def fibonacci(n):", "2 + 2 ="]


def reference(model_dir, n, tok, tokens):
    ref = Shard(model_dir, 0, n, embed=True, head=True)
    out = []
    for p in PROMPTS:
        ids, cache, toks = mx.array(tok.encode(p))[None], ref.make_cache(), []
        for _ in range(tokens):
            t = int(mx.argmax(ref.logits(ref.run_layers(ref.embed(ids), cache)[:, -1:, :])[0, -1]).item())
            toks.append(t)
            ids = mx.array([[t]])
        out.append(toks)
    del ref
    gc.collect()
    mx.clear_cache()
    return out


def make_alias(src: Path, dst: Path, n: int):
    dst.mkdir(parents=True)
    for f in src.iterdir():
        if f.suffix == ".safetensors" or f.name.startswith("tokenizer"):
            (dst / f.name).symlink_to(f)
    cfg = json.loads((src / "config.json").read_text())
    idx = json.loads((src / "model.safetensors.index.json").read_text())
    idx["metadata"]["total_size"] = idx["metadata"]["total_size"] * n // cfg["num_hidden_layers"]
    cfg["num_hidden_layers"] = n
    (dst / "config.json").write_text(json.dumps(cfg))
    (dst / "model.safetensors.index.json").write_text(json.dumps(idx))


def wait(what, fn, timeout=120):
    for _ in range(timeout * 2):
        if (v := fn()):
            return v
        time.sleep(0.5)
    sys.exit(f"timed out waiting for {what}")


def model(base, name):
    return next((m for m in http(base + "/api/models")["models"] if m["model"] == name), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--tokens", type=int, default=8)
    ap.add_argument("--port", type=int, default=8200)
    a = ap.parse_args()
    src = Path(a.model_dir).resolve()
    tok = load_tokenizer(src)
    ref16, ref8 = reference(src, 16, tok, a.tokens), reference(src, 8, tok, a.tokens)

    tmp = Path(tempfile.mkdtemp(prefix="podtorrent-multi-"))
    specs = {"A": ["0:5", "10:16", f"{ALIAS}:0:4"], "B": ["5:10", f"{ALIAS}:4:8"]}
    procs, bases = {}, {}
    for i, (name, serve) in enumerate(specs.items()):
        home = tmp / name
        make_alias(src, home / "models" / "alias", 8)
        env = {**os.environ, "PODTORRENT_HOME": str(home), "PODTORRENT_NAME": name,
               **({"PODTORRENT_MEM_BUDGET_GB": "4.5"} if name == "B" else {})}
        args = [sys.executable, "-m", "podtorrent.cli", "peer", "--model-dir", str(src), "--layers", "16",
                "--port", str(a.port + i)]
        for s in serve:
            args += ["--serve", s]
        procs[name] = subprocess.Popen(args, env=env, stdout=open(tmp / f"{name}.log", "w"), stderr=subprocess.STDOUT)
        bases[name] = f"http://127.0.0.1:{a.port + i}"
    print(f"peers: {specs} (logs in {tmp})")
    A, B = bases["A"], bases["B"]
    fails = 0

    def check(ok, msg):
        nonlocal fails
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'} {msg}", flush=True)

    try:
        def up():
            try:
                ms = {m["model"]: m for m in http(A + "/api/models", timeout=3)["models"]}
            except OSError:
                return None
            return ms if all(ms.get(k, {}).get("state") == "available" for k in (ALIAS, *[http(A + "/status")["repo"]])) else None
        ms = wait("both models available on A", up, 300)
        repo = http(A + "/status")["repo"]
        for m in (repo, ALIAS):
            print(f"  {m}: route " + " → ".join(f"{n}[{lo},{hi})" for n, lo, hi in ms[m]["route"]))
        check(ms[repo]["route"] == [["A", 0, 5], ["B", 5, 10], ["A", 10, 16]], "default model routes A → B → A")
        check(ms[ALIAS]["route"] == [["A", 0, 4], ["B", 4, 8]], "alias routes A → B")
        check(len(http(A + "/status")["slices"]) == 3, "A serves three slices")

        for p, r16, r8 in zip(PROMPTS, ref16, ref8):
            got16 = http(A + "/api/complete", {"ids": tok.encode(p), "max_tokens": a.tokens})
            got8 = http(A + "/api/complete", {"ids": tok.encode(p), "max_tokens": a.tokens, "model": ALIAS})
            check(got16.get("tokens") == r16, f"default {p!r}" + ("" if got16.get("tokens") == r16 else f" {got16}"))
            check(got8.get("tokens") == r8, f"alias {p!r}" + ("" if got8.get("tokens") == r8 else f" {got8}"))

        r = http(B + "/api/unserve", {"model": ALIAS, "lo": 4, "hi": 8})
        check(r.get("removed") == [[ALIAS, 4, 8]], "B unserves alias [4,8)")
        m = wait("alias partial on A", lambda: (x := model(A, ALIAS)) and x["state"] == "partial" and x, 30)
        check(m["gaps"] == [[4, 8]], f"alias partial with gap 4–7 (got {m['gaps']})")
        r = http(A + "/api/complete", {"ids": tok.encode(PROMPTS[0]), "max_tokens": 2, "model": ALIAS})
        check("not covered" in r.get("error", ""), f"completion refused while partial ({r.get('error')})")

        r = http(A + "/api/serve", {"model": ALIAS, "lo": 4, "hi": 8, "wait": True})
        check(r.get("ok"), f"A serves alias [4,8) ({r.get('error', 'ok')})")
        m = model(A, ALIAS)
        check(m["state"] == "available" and m["route"] == [["A", 0, 8]], f"alias available on A alone ({m['route']})")
        got = http(A + "/api/complete", {"ids": tok.encode(PROMPTS[0]), "max_tokens": a.tokens, "model": ALIAS})
        check(got.get("tokens") == ref8[0], "alias still token-exact after the change")

        r = http(B + "/api/serve", {"lo": 0, "hi": 16, "wait": True})  # ~5 GB against B's 4.5 GB budget
        check("need ~" in r.get("error", ""), f"oversized slice refused ({r.get('error')})")
        check(len(http(B + "/status")["slices"]) == 1, "B still serves just [5,10)")
        r = http(A + "/api/serve", {"model": ALIAS, "lo": 4, "hi": 9, "wait": True})
        check("out of bounds" in r.get("error", ""), f"range past the model refused ({r.get('error')})")

        saved = json.loads((tmp / "A" / "config.json").read_text())["serve"]
        want = [{"model": repo, "lo": 0, "hi": 5}, {"model": repo, "lo": 10, "hi": 16},
                {"model": ALIAS, "lo": 0, "hi": 4}, {"model": ALIAS, "lo": 4, "hi": 8}]
        check(sorted(saved, key=str) == sorted(want, key=str), f"A's config remembers its slices ({saved})")

        print(f"\n{'all passed' if not fails else f'{fails} failed'}")
        sys.exit(1 if fails else 0)
    finally:
        for p in procs.values():
            p.terminate()
        shutil.rmtree(tmp / "A" / "models", ignore_errors=True)
        shutil.rmtree(tmp / "B" / "models", ignore_errors=True)


if __name__ == "__main__":
    main()
