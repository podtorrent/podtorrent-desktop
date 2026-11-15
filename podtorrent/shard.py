"""A shard of a Qwen3-MoE or Qwen3.5-MoE model: a contiguous layer range plus optional embed / head.

Qwen3.5 (`qwen3_5_moe`) mixes gated-DeltaNet linear-attention layers with full-attention layers
(every `full_attention_interval`-th). A linear layer keeps a fixed-size recurrent state (conv tail +
delta-rule state) instead of a KV cache. Each peer keeps the cache entries of its own layers, so a
request split across peers needs nothing extra on the wire.
"""
import json
import re
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx_lm.models.base import create_attention_mask
from mlx_lm.models.cache import ArraysCache, KVCache

from .slicer import text_config

# "language_model.model.layers.N.x" (Qwen3.5) and "model.layers.N.x" (Qwen3) are the same tensor.
PREFIX_RE = re.compile(r"^language_model\.")


def architecture(cfg: dict):
    """(args, layer factory) for config.json `cfg`."""
    if cfg.get("model_type") == "qwen3_5_moe":
        from mlx_lm.models.qwen3_5 import DecoderLayer, TextModelArgs
        return TextModelArgs.from_dict(text_config(cfg)), DecoderLayer
    from mlx_lm.models.qwen3_moe import ModelArgs, Qwen3MoeDecoderLayer
    return ModelArgs.from_dict(cfg), Qwen3MoeDecoderLayer


def is_linear(layer) -> bool:
    return getattr(layer, "is_linear", False)


class Shard(nn.Module):
    def __init__(self, model_dir: str | Path, lo: int, hi: int, embed=False, head=False):
        super().__init__()
        d = Path(model_dir)
        cfg = json.loads((d / "config.json").read_text())
        self.args, make_layer = architecture(cfg)
        self.lo, self.hi, self.has_embed, self.has_head = lo, hi, embed, head
        a = self.args
        if embed:
            self.embed_tokens = nn.Embedding(a.vocab_size, a.hidden_size)
        self.layers = [make_layer(a, i) for i in range(lo, hi)]
        if head:
            self.norm = nn.RMSNorm(a.hidden_size, eps=a.rms_norm_eps)
            self.lm_head = nn.Linear(a.hidden_size, a.vocab_size, bias=False)

        weights = {}
        for f in sorted(d.glob("*.safetensors")):
            weights.update(mx.load(str(f)))
        # Rename global layer indices to local ones; drop the "model." prefix.
        local = {}
        for k, v in weights.items():
            k = PREFIX_RE.sub("", k)
            if k.startswith("model.layers."):
                _, _, idx, rest = k.split(".", 3)
                if not lo <= int(idx) < hi:
                    continue
                k = f"layers.{int(idx) - lo}.{rest}"
            elif k.startswith("model.embed_tokens."):
                if not embed:
                    continue
                k = k[len("model."):]
            elif k.startswith(("model.norm.", "lm_head.")):
                if not head:
                    continue
                k = k[len("model."):] if k.startswith("model.") else k
            else:
                continue  # vision tower, MTP head
            local[k] = v
        q = cfg.get("quantization")  # absent in a bf16 checkpoint (tests)

        def pred(path, m):
            if not hasattr(m, "to_quantized"):
                return False
            s = local.get(f"{path}.scales")
            if s is None:
                return False
            bits = local[f"{path}.weight"].shape[-1] * 32 // (s.shape[-1] * q["group_size"])
            return {"group_size": q["group_size"], "bits": bits}

        if q:
            nn.quantize(self, class_predicate=pred)
        self.load_weights(list(local.items()), strict=True)
        self.eval()  # Qwen3.5's DeltaNet uses its Metal kernel only outside training mode
        mx.eval(self.parameters())

    def make_cache(self, lo=None, hi=None):
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        return [ArraysCache(size=2) if is_linear(layer) else KVCache()
                for layer in self.layers[lo - self.lo:hi - self.lo]]

    def run_layers(self, h, cache, lo=None, hi=None):
        """Run global layers [lo, hi) (default: all of this shard's); `cache` has one entry per layer."""
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        assert self.lo <= lo <= hi <= self.hi, (lo, hi, self.lo, self.hi)
        if lo == hi:
            return h
        layers = self.layers[lo - self.lo:hi - self.lo]
        # Full attention takes a causal mask built from its KV cache's offset; linear layers take none
        # (their mask is only for left-padded batches, and peers run one sequence).
        kv = next((c for layer, c in zip(layers, cache) if not is_linear(layer)), None)
        mask = create_attention_mask(h, kv)
        for layer, c in zip(layers, cache):
            h = layer(h, None if is_linear(layer) else mask, c)
        return h

    def embed(self, ids):
        return self.embed_tokens(ids)

    def logits(self, h):
        return self.lm_head(self.norm(h))
