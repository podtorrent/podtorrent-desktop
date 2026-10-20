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
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx_lm.models.base import create_attention_mask
from mlx_lm.models.qwen3 import ModelArgs, TransformerBlock

from .encoder_common import H3_ENCODER_REPO, H3_LAYERS, _local_key, download_slice, text_config, tokenize  # noqa: F401


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
