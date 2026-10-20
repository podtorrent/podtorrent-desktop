"""The H3 prompt encoder as layer slices: Qwen3-VL's language model in MLX.

H3 reads Qwen3-VL-32B truncated to its first 50 layers (ComfyUI's comfy/text_encoders/minimax.py):
the prompt is tokenized raw (no chat template, no special tokens, no padding), runs one causal pass
with no attention mask, and the conditioning is the hidden state after layer 50 with no final norm.
So an encoder slice is a Shard without the head and without a KV cache: [1, T] ids in,
[1, T, hidden] out of the last slice.

Text only for now. With no image in the prompt, Qwen3-VL's interleaved M-RoPE gives every axis the
same position, which is exactly plain 1-D RoPE, and DeepStack injects nothing. Images (phase 6) need
the vision tower, M-RoPE position IDs and DeepStack.

Loads both the original Hugging Face checkpoints (`model.language_model.layers.N...`) and MLX
conversions (`language_model.model.layers.N...`), quantized or not.
"""
import json
import re
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx_lm.models.base import create_attention_mask
from mlx_lm.models.qwen3 import ModelArgs, TransformerBlock

H3_LAYERS = 50  # H3 reads the output of this layer (of Qwen3-VL-32B's 64)

_LAYER = re.compile(r"(?:^|\.)layers\.(\d+)\.(.+)$")


def text_config(model_dir: str | Path) -> dict:
    cfg = json.loads((Path(model_dir) / "config.json").read_text())
    tc = dict(cfg.get("text_config", cfg))
    # Text-only M-RoPE is plain RoPE (see above); drop the M-RoPE section so mlx_lm builds that.
    tc.pop("rope_scaling", None)
    rp = tc.pop("rope_parameters", None) or {}
    tc.setdefault("rope_theta", rp.get("rope_theta", 5_000_000))
    tc.setdefault("tie_word_embeddings", cfg.get("tie_word_embeddings", False))
    if "quantization" in cfg:
        tc["quantization"] = cfg["quantization"]
    return tc


def _local_key(k: str, lo: int, hi: int, embed: bool) -> str | None:
    """Map a checkpoint key to this slice's key, or None if the slice doesn't hold it."""
    if "visual" in k or "vision_tower" in k or k.startswith("lm_head"):
        return None
    if m := _LAYER.search(k):
        i = int(m.group(1))
        return f"layers.{i - lo}.{m.group(2)}" if lo <= i < hi else None
    if embed and "embed_tokens." in k:
        return "embed_tokens." + k.split("embed_tokens.", 1)[1]
    return None


class EncoderShard(nn.Module):
    """Global layers [lo, hi) of the encoder, plus the token embedding if `embed`."""

    def __init__(self, model_dir: str | Path, lo: int, hi: int, embed=False):
        super().__init__()
        d = Path(model_dir)
        cfg = text_config(d)
        self.args = ModelArgs.from_dict(cfg)
        assert 0 <= lo <= hi <= self.args.num_hidden_layers, (lo, hi, self.args.num_hidden_layers)
        self.lo, self.hi, self.has_embed = lo, hi, embed
        if embed:
            self.embed_tokens = nn.Embedding(self.args.vocab_size, self.args.hidden_size)
        self.layers = [TransformerBlock(self.args) for _ in range(lo, hi)]

        local = {}
        for f in sorted(d.glob("*.safetensors")):
            for k, v in mx.load(str(f)).items():
                if (lk := _local_key(k, lo, hi, embed)) is not None:
                    local[lk] = v
        if q := cfg.get("quantization"):
            def pred(path, m):
                s = local.get(f"{path}.scales")
                if not hasattr(m, "to_quantized") or s is None:
                    return False
                bits = local[f"{path}.weight"].shape[-1] * 32 // (s.shape[-1] * q["group_size"])
                return {"group_size": q["group_size"], "bits": bits}
            nn.quantize(self, class_predicate=pred)
        self.load_weights(list(local.items()), strict=True)
        mx.eval(self.parameters())

    def embed(self, ids: mx.array) -> mx.array:
        return self.embed_tokens(ids)

    def run_layers(self, h: mx.array) -> mx.array:
        """One causal pass of [1, T, hidden] through all of this slice's layers."""
        mask = create_attention_mask(h, None)
        for layer in self.layers:
            h = layer(h, mask, None)
        return h


def tokenize(model_dir: str | Path, prompt: str) -> list[int]:
    """Token ids exactly as ComfyUI's MiniMaxH3Tokenizer makes them for a text-only prompt."""
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(str(model_dir))
    ids = tok.encode(prompt, add_special_tokens=False)
    return ids or [151643]  # ComfyUI sends one pad token for an empty prompt


H3_ENCODER_REPO = "mlx-community/Qwen3-VL-32B-Instruct-4bit"


def download_slice(out_dir: str | Path, lo: int, hi: int, repo: str = H3_ENCODER_REPO, on_progress=None) -> Path:
    """Fetch only layers [lo, hi) of the encoder (plus the embedding if lo == 0) by range requests,
    so no machine downloads the whole 32B. Several slices can share one out_dir."""
    from podtorrent.slicer import download_slice as fetch
    return fetch(repo, out_dir, lo, hi, host=lo == 0, on_progress=on_progress, name=f"enc-{lo}-{hi}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Fetch one H3 encoder slice: python -m podtorrent.video.encoder_mlx DIR LO HI")
    ap.add_argument("out_dir")
    ap.add_argument("lo", type=int)
    ap.add_argument("hi", type=int)
    ap.add_argument("--repo", default=H3_ENCODER_REPO)
    a = ap.parse_args()
    print(download_slice(a.out_dir, a.lo, a.hi, a.repo,
                         lambda d, t: print(f"\r{d / 1e9:.2f} / {t / 1e9:.2f} GB", end="", flush=True)))
