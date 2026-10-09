"""A shard of a Qwen3-MoE model: a contiguous layer range plus optional embed / head."""
import json
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx_lm.models.base import create_attention_mask
from mlx_lm.models.cache import KVCache
from mlx_lm.models.qwen3_moe import ModelArgs, Qwen3MoeDecoderLayer


class Shard(nn.Module):
    def __init__(self, model_dir: str | Path, lo: int, hi: int, embed=False, head=False):
        super().__init__()
        d = Path(model_dir)
        cfg = json.loads((d / "config.json").read_text())
        self.args = ModelArgs.from_dict(cfg)
        self.lo, self.hi, self.has_embed, self.has_head = lo, hi, embed, head
        a = self.args
        if embed:
            self.embed_tokens = nn.Embedding(a.vocab_size, a.hidden_size)
        self.layers = [Qwen3MoeDecoderLayer(a, i) for i in range(lo, hi)]
        if head:
            self.norm = nn.RMSNorm(a.hidden_size, eps=a.rms_norm_eps)
            self.lm_head = nn.Linear(a.hidden_size, a.vocab_size, bias=False)

        weights = {}
        for f in sorted(d.glob("*.safetensors")):
            weights.update(mx.load(str(f)))
        # Rename global layer indices to local ones; drop the "model." prefix.
        local = {}
        for k, v in weights.items():
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
                continue
            local[k] = v
        q = cfg["quantization"]

        def pred(path, m):
            if not hasattr(m, "to_quantized"):
                return False
            s = local.get(f"{path}.scales")
            if s is None:
                return False
            bits = local[f"{path}.weight"].shape[-1] * 32 // (s.shape[-1] * q["group_size"])
            return {"group_size": q["group_size"], "bits": bits}

        nn.quantize(self, class_predicate=pred)
        self.load_weights(list(local.items()), strict=True)
        mx.eval(self.parameters())

    def make_cache(self, lo=None, hi=None):
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        return [KVCache() for _ in range(lo, hi)]

    def run_layers(self, h, cache, lo=None, hi=None):
        """Run global layers [lo, hi) (default: all of this shard's); `cache` has one entry per layer."""
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        assert self.lo <= lo <= hi <= self.hi, (lo, hi, self.lo, self.hi)
        if lo == hi:
            return h
        mask = create_attention_mask(h, cache[0])
        for layer, c in zip(self.layers[lo - self.lo:hi - self.lo], cache):
            h = layer(h, mask, c)
        return h

    def embed(self, ids):
        return self.embed_tokens(ids)

    def logits(self, h):
        return self.lm_head(self.norm(h))
