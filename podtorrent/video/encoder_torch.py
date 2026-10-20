"""PyTorch twin of encoder_mlx.py: H3 prompt encoder slices for Windows / CUDA peers.

Reuses shard_torch's dense Qwen3 layer, so the rounding matches MLX and a slice can sit anywhere
in a chain with Mac slices (for example a single Mac running [0, K) and the video machine [K, 50)).
"""
from pathlib import Path

import torch
from safetensors import safe_open

from podtorrent.shard_torch import DTYPE, Layer, default_device, linear

from .encoder_mlx import _local_key, text_config


class TorchEncoderShard:
    """Global layers [lo, hi) of the encoder, plus the token embedding if `embed`."""

    def __init__(self, model_dir: str | Path, lo: int, hi: int, embed=False, device=None):
        d = Path(model_dir)
        self.cfg = cfg = text_config(d)
        assert 0 <= lo <= hi <= cfg["num_hidden_layers"], (lo, hi, cfg["num_hidden_layers"])
        self.lo, self.hi, self.has_embed = lo, hi, embed
        self.device = device or default_device()
        gs = cfg.get("quantization", {}).get("group_size", 64)

        p = {}
        for f in sorted(d.glob("*.safetensors")):
            with safe_open(str(f), framework="pt") as sf:
                for k in sf.keys():
                    if (lk := _local_key(k, lo, hi, embed)) is not None and lk not in p:
                        t = sf.get_tensor(k)
                        if t.dtype == torch.uint32:
                            t = t.view(torch.int32)
                        p[lk] = t.to(self.device)

        def sub(prefix):
            return {k[len(prefix):]: v for k, v in p.items() if k.startswith(prefix)}

        self.layers = [Layer(sub(f"layers.{i - lo}."), cfg, gs) for i in range(lo, hi)]
        if embed:
            self.embed_tokens = linear(p, "embed_tokens", gs)

    @torch.inference_mode()
    def embed(self, ids):
        return self.embed_tokens.rows(torch.as_tensor(ids, device=self.device))

    @torch.inference_mode()
    def run_layers(self, h):
        """One causal pass of [1, T, hidden] through all of this slice's layers."""
        h = h.to(self.device, DTYPE)
        for layer in self.layers:
            h = layer(h, None)
        return h
