"""Phase 1 parity test: the H3 prompt encoder split across 2 processes matches the reference.

Usage: python -m tests.parity_h3_encoder MODEL_DIR [--layers 50] [--split K]

For the real 32B on a 16 GB Mac, fetch just the two halves (about 7 GB each) and skip the parts
that need all of it in memory at once:
    python -m podtorrent.video.encoder_mlx DIR 0 25
    python -m podtorrent.video.encoder_mlx DIR 25 50
    python -m tests.parity_h3_encoder DIR --no-whole --no-reference

MODEL_DIR is any Qwen3-VL checkpoint. Qwen3-VL-32B is what H3 uses; a small one (Qwen3-VL-2B) has
the same architecture and lets the bf16 reference fit next to everything else on a 16 GB Mac.

For each prompt:
  1. process A: token embedding + layers [0, K), sends its hidden state over the fp16 wire;
  2. process B: layers [K, L), returns the conditioning [1, T, hidden];
  3. the reference: Hugging Face transformers in fp32 on the CPU, the output of layer L (no norm);
  4. the same MLX layers in one process (baseline: how much of the gap the split itself adds);
  5. mixed: MLX [0, K) -> fp16 wire -> PyTorch [K, L), the shape of a 1-Mac + Windows chain.
Prints each process's peak memory. Exits non-zero if any check is outside tolerance.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

# MLX runs in the checkpoint's bf16, the reference in fp32, so a bf16-sized error is expected.
COS_MIN = 0.999   # cosine similarity of the flattened conditioning
REL_MAX = 0.03    # ||ref - got|| / ||ref||
SPLIT_REL_MAX = 0.01  # the split vs. the same layers in one process: only the fp16 wire differs

PROMPTS = [
    "A red fox runs through fresh snow at dawn, its breath steaming, the camera tracking low beside it.",
    "Close-up of a jazz trumpeter on a dim stage; warm spotlight, smoke, and the crowd applauding.",
    "Waves",
]


def stage(a):
    """Run one half in this process (called as a subprocess). Writes the output and peak memory."""
    import mlx.core as mx

    from podtorrent.backend import from_wire, to_wire
    from podtorrent.video.encoder_mlx import EncoderShard

    job = json.loads(Path(a.job).read_text())
    shard = EncoderShard(a.model_dir, a.lo, a.hi, embed=a.lo == 0)
    loaded = mx.get_peak_memory()
    outs = []
    for i, ids in enumerate(job["ids"]):
        if a.lo == 0:
            h = shard.embed(mx.array([ids]))
        else:
            h = from_wire(Path(a.inp, f"{i}.bin").read_bytes(), (1, len(ids), shard.args.hidden_size))
        h = shard.run_layers(h)
        mx.eval(h)
        Path(a.out, f"{i}.bin").write_bytes(to_wire(h))
        outs.append(list(h.shape))
    Path(a.out, "stats.json").write_text(json.dumps(
        {"weights_gb": loaded / 1e9, "peak_gb": mx.get_peak_memory() / 1e9, "shapes": outs}))


def run_stage(model_dir, lo, hi, job, inp, out):
    out.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "tests.parity_h3_encoder", str(model_dir), "--stage",
           "--lo", str(lo), "--hi", str(hi), "--job", str(job), "--inp", str(inp), "--out", str(out)]
    subprocess.run(cmd, check=True)
    return json.loads((out / "stats.json").read_text())


def reference(model_dir, layers, prompts_ids):
    """Hugging Face transformers, fp32 on CPU: the output of layer `layers` (1-based), no norm."""
    import torch
    from transformers import AutoModelForImageTextToText

    model = AutoModelForImageTextToText.from_pretrained(str(model_dir), dtype=torch.float32)
    lm = model.model.language_model
    lm.layers = lm.layers[:layers]  # H3 truncates the checkpoint; nothing after layer L runs
    got = {}
    lm.layers[-1].register_forward_hook(lambda m, i, o: got.__setitem__("h", o[0] if isinstance(o, tuple) else o))
    outs = []
    with torch.no_grad():
        for ids in prompts_ids:
            model(input_ids=torch.tensor([ids]))
            outs.append(got["h"].float().reshape(1, len(ids), -1).numpy())
    del model
    return outs


def compare(name, ref, got, rel_max, failures):
    a, b = ref.astype(np.float64).ravel(), got.astype(np.float64).ravel()
    cos = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
    rel = float(np.linalg.norm(a - b) / (np.linalg.norm(a) + 1e-12))
    ok = cos >= COS_MIN and rel <= rel_max
    print(f"{'ok  ' if ok else 'FAIL'} {name:<44} cos={cos:.6f} rel={rel:.4f} max|d|={np.abs(a - b).max():.4g}")
    if not ok and failures is not None:
        failures.append(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--layers", type=int, help="layers H3 reads (default: 50, or the model's depth if smaller)")
    ap.add_argument("--split", type=int, help="first layer of process B (default: the middle)")
    ap.add_argument("--device", default="cpu", help="PyTorch device for the mixed check")
    ap.add_argument("--no-whole", action="store_true",
                    help="skip the one-process run (the 32B's 50 layers don't fit one 16 GB Mac); "
                         "the split then serves as the baseline for the mixed check")
    ap.add_argument("--no-reference", action="store_true", help="skip transformers (for models too big for RAM)")
    # internal: one half, run as a subprocess
    ap.add_argument("--stage", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--lo", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--hi", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--job", help=argparse.SUPPRESS)
    ap.add_argument("--inp", help=argparse.SUPPRESS)
    ap.add_argument("--out", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.stage:
        return stage(a)

    from podtorrent.video.encoder_mlx import H3_LAYERS, text_config, tokenize

    d = Path(a.model_dir)
    depth = text_config(d)["num_hidden_layers"]
    layers = a.layers or min(H3_LAYERS, depth)
    k = a.split or layers // 2
    assert 0 < k < layers <= depth, (k, layers, depth)
    ids = [tokenize(d, p) for p in PROMPTS]
    hidden = text_config(d)["hidden_size"]
    failures = []

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        job = tmp / "job.json"
        job.write_text(json.dumps({"ids": ids}))
        print(f"process A: layers [0, {k})  process B: layers [{k}, {layers})  of {depth}")
        sa = run_stage(d, 0, k, job, tmp, tmp / "a")
        sb = run_stage(d, k, layers, job, tmp / "a", tmp / "b")
        stats = [("A", sa), ("B", sb)]
        if not a.no_whole:
            stats.append(("one process", run_stage(d, 0, layers, job, tmp, tmp / "whole")))
        for name, s in stats:
            print(f"     {name:<12} weights {s['weights_gb']:.2f} GB, peak {s['peak_gb']:.2f} GB")

        def load(sub, i):
            return np.frombuffer((tmp / sub / f"{i}.bin").read_bytes(), np.float16).reshape(1, len(ids[i]), hidden)

        split = [load("b", i) for i in range(len(ids))]
        whole = None if a.no_whole else [load("whole", i) for i in range(len(ids))]
        mid = [load("a", i) for i in range(len(ids))]

    # The 1-Mac demo shape: Mac runs [0, K), the Windows peer (PyTorch) runs [K, L).
    import torch

    from podtorrent.video.encoder_torch import TorchEncoderShard
    ts = TorchEncoderShard(d, k, layers, device=a.device)
    mixed = [ts.run_layers(torch.from_numpy(m.copy())).float().cpu().numpy() for m in mid]
    del ts

    for i, s in enumerate(sb["shapes"]):
        assert s == [1, len(ids[i]), hidden], (s, len(ids[i]), hidden)
    for i in range(len(ids)):
        if whole is None:
            compare(f"prompt {i} ({len(ids[i])} tok): MLX->torch vs MLX->MLX", split[i], mixed[i], REL_MAX, failures)
            continue
        compare(f"prompt {i} ({len(ids[i])} tok): split vs one process", whole[i], split[i], SPLIT_REL_MAX, failures)
        compare(f"prompt {i}: MLX->torch vs one process", whole[i], mixed[i], REL_MAX, failures)

    if not a.no_reference:
        print("reference: transformers fp32 on CPU")
        refs = reference(d, layers, ids)
        for i in range(len(ids)):
            compare(f"prompt {i}: split vs transformers", refs[i], split[i], REL_MAX, failures)
            if whole is not None:
                compare(f"prompt {i}: one process vs transformers (baseline)", refs[i], whole[i], REL_MAX, None)

    print("PASS" if not failures else f"FAIL: {len(failures)} check(s): {', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
