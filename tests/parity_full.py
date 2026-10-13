"""Full-model parity across two machines: MLX [0, split) here, then [split, n) on the machine that
holds the rest, run once with MLX and once with PyTorch. Every position's next-token prediction
must agree, except where MLX's top two logits are a near-tie.

  dump  (machine with layers [0, split) + embeddings):
      python -m tests.parity_full dump MODEL_DIR --split 24 --out DIR
      writes DIR/states.npz (hidden states after layer split-1, fp16, as on the wire)
  check (machine with layers [split, n)):
      python -m tests.parity_full check --dump DIR [--model-dir MODEL_DIR] [--head HEAD]

Each text is fed as a prefill block and then one token at a time, so the KV cache is exercised.
MLX and PyTorch run one after the other, so the machine never holds both copies of the layers.
"""
import argparse
import gc
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

TEXTS = [
    "The capital of France is Paris, which is known for the Eiffel Tower, the Louvre museum and "
    "its cafés. Every year millions of tourists visit the city to see its famous landmarks.",
    "def fibonacci(n):\n    if n < 2:\n        return n\n    return fibonacci(n - 1) + fibonacci(n - 2)\n\n"
    "print([fibonacci(i) for i in range(10)])",
    "Photosynthesis is the process by which green plants use sunlight, water and carbon dioxide to "
    "produce glucose and oxygen. It takes place mainly in the chloroplasts of leaf cells.",
    "Q: Who wrote Hamlet?\nA: William Shakespeare wrote Hamlet around 1600. It is one of his "
    "longest plays and tells the story of a Danish prince seeking revenge.",
    "In 1969, Neil Armstrong and Buzz Aldrin became the first humans to walk on the Moon, while "
    "Michael Collins orbited above in the command module.",
    "SELECT name, email FROM users WHERE created_at > '2024-01-01' ORDER BY name LIMIT 10;",
]
PREFILL = 16
TIE_MARGIN = 0.25    # logits closer than this are a coin flip in bfloat16
AGREE_MIN = 0.98     # share of clear (non-tie) positions whose top-1 token must agree
REL_MAX = 0.15       # final hidden state, ||mlx - torch|| / ||mlx||, median over texts


def dump(a):
    import mlx.core as mx
    from mlx_lm.utils import load_tokenizer

    from podtorrent.shard import Shard

    d = Path(a.model_dir)
    tok = load_tokenizer(d)
    sh = Shard(d, 0, a.split, embed=True)
    out = {}
    for i, text in enumerate(TEXTS):
        ids = tok.encode(text)
        cache = sh.make_cache()
        hs = [sh.run_layers(sh.embed(mx.array([ids[:PREFILL]])), cache)]
        for t in ids[PREFILL:]:
            hs.append(sh.run_layers(sh.embed(mx.array([[t]])), cache))
        h = mx.concatenate(hs, axis=1).astype(mx.float16)
        mx.eval(h)
        out[f"h{i}"], out[f"ids{i}"] = np.array(h), np.array(ids)
        print(f"text {i}: {len(ids)} tokens")
    Path(a.out).mkdir(parents=True, exist_ok=True)
    np.savez(Path(a.out) / "states.npz", split=a.split, **out)
    print(f"wrote {Path(a.out) / 'states.npz'}")


def find_model_dir(split):
    """A local model dir whose safetensors hold the last layer (default ~/.podtorrent/models/*)."""
    from safetensors import safe_open
    root = Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent")) / "models"
    for d in sorted(root.glob("*")):
        cfg = d / "config.json"
        if not cfg.exists() or json.loads(cfg.read_text()).get("model_type") != "qwen3_moe":
            continue
        last = json.loads(cfg.read_text())["num_hidden_layers"] - 1
        for f in d.glob("*.safetensors"):
            with safe_open(str(f), "np") as sf:
                keys = set(sf.keys())
            if any(k.startswith(f"model.layers.{last}.") for k in keys) and \
                    any(k.startswith(f"model.layers.{split}.") for k in keys):
                return d
    sys.exit(f"no model with layers [{split}, end) found under {root}; pass --model-dir")


def head_dir(model_dir, head):
    """A dir with the model's config and the head weights, for Shard(d, 0, 0, head=True)."""
    d = Path(tempfile.mkdtemp(prefix="parity-head-"))
    (d / "config.json").symlink_to(Path(model_dir).resolve() / "config.json")
    (d / "head.safetensors").symlink_to(Path(head).resolve())
    return d


def run_mlx(model_dir, hd, split, n, data):
    import mlx.core as mx

    from podtorrent.common import from_wire
    from podtorrent.shard import Shard

    sh, head = Shard(model_dir, split, n), Shard(hd, 0, 0, head=True)
    res = []
    for i in range(len(TEXTS)):
        h, cache = data[f"h{i}"], sh.make_cache()
        outs = [sh.run_layers(from_wire(c.tobytes(), c.shape), cache) for c in chunks(h)]
        o = mx.concatenate(outs, axis=1)
        lg = head.logits(o)
        mx.eval(o, lg)
        res.append((np.array(o.astype(mx.float32)), np.array(lg.astype(mx.float32))[0]))
    return res


def run_torch(model_dir, hd, split, n, data, device):
    import torch

    from podtorrent.shard_torch import TorchShard

    torch.set_num_threads(os.cpu_count() or 8)
    sh = TorchShard(model_dir, split, n, device=device)
    head = TorchShard(hd, 0, 0, head=True, device=device)
    res = []
    for i in range(len(TEXTS)):
        h, cache = data[f"h{i}"], sh.make_cache()
        outs = [sh.run_layers(torch.from_numpy(c.copy()), cache) for c in chunks(h)]
        o = torch.cat(outs, dim=1)
        lg = head.logits(o)
        res.append((o.float().cpu().numpy(), lg.float().cpu().numpy()[0]))
        print(f"  torch text {i} done")
    return res


def chunks(h):
    yield h[:, :PREFILL]
    for t in range(PREFILL, h.shape[1]):
        yield h[:, t:t + 1]


def check(a):
    data = np.load(Path(a.dump) / "states.npz")
    split = int(data["split"])
    model_dir = Path(a.model_dir) if a.model_dir else find_model_dir(split)
    n = a.end or json.loads((model_dir / "config.json").read_text())["num_hidden_layers"]
    hd = head_dir(model_dir, a.head or Path(a.dump) / "head.safetensors")
    print(f"model {model_dir}, layers [{split}, {n}), {len(TEXTS)} texts")

    t0 = time.time()
    m = run_mlx(model_dir, hd, split, n, data)
    print(f"MLX done in {time.time() - t0:.0f}s")
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:  # noqa: BLE001
        pass
    t0 = time.time()
    t = run_torch(model_dir, hd, split, n, data, a.device)
    print(f"PyTorch ({a.device}) done in {time.time() - t0:.0f}s")

    agree = clear = ties = 0
    rels = []
    for i, ((mh, ml), (th, tl)) in enumerate(zip(m, t)):
        rel = float(np.linalg.norm(mh - th) / np.linalg.norm(mh))
        top2 = np.sort(ml, -1)[:, -2:]
        c = top2[:, 1] - top2[:, 0] > TIE_MARGIN
        same = ml.argmax(-1) == tl.argmax(-1)
        nxt = data[f"ids{i}"][1:]
        hit_m = float((ml.argmax(-1)[:-1] == nxt).mean())
        hit_t = float((tl.argmax(-1)[:-1] == nxt).mean())
        print(f"text {i}: {same.sum()}/{len(same)} same top-1 ({(~same & ~c).sum()} differing at near-ties), "
              f"hidden rel={rel:.4f}, predicts the actual next token: MLX {hit_m:.0%} PyTorch {hit_t:.0%}")
        agree += int((same & c).sum())
        clear += int(c.sum())
        ties += int((~same & ~c).sum())
        rels.append(rel)
    share, med = agree / clear, float(np.median(rels))
    ok = share >= AGREE_MIN and med <= REL_MAX
    print(f"{'PASS' if ok else 'FAIL'}: top-1 agreement {agree}/{clear} = {share:.1%} on clear positions "
          f"(need {AGREE_MIN:.0%}; {ties} near-tie positions differ, ignored); "
          f"median hidden rel={med:.4f} (max {REL_MAX})")
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    d = sp.add_parser("dump")
    d.add_argument("model_dir")
    d.add_argument("--split", type=int, default=24)
    d.add_argument("--out", required=True)
    c = sp.add_parser("check")
    c.add_argument("--dump", required=True)
    c.add_argument("--model-dir")
    c.add_argument("--head", help="head.safetensors (default: the one next to states.npz)")
    c.add_argument("--device", default="cpu")
    c.add_argument("--end", type=int, help="stop before this layer (for testing on a partial model)")
    a = ap.parse_args()
    dump(a) if a.cmd == "dump" else check(a)


if __name__ == "__main__":
    main()
