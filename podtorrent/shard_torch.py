"""PyTorch twin of shard.py: a Qwen3-MoE layer range that loads the same MLX 4-bit slices.

Weights stay packed on the device and are unpacked on the fly, so a slice takes the same memory
as under MLX. Rounding mirrors MLX: math runs in float32 and every place MLX produces a bfloat16
tensor (linear outputs, norms, attention, the KV cache) is cast to bfloat16 here too, so hidden
states from a PyTorch peer can be handed to an MLX peer mid-chain and vice versa.
"""
import json
from pathlib import Path

import torch
import torch.nn.functional as F
from safetensors import safe_open

DTYPE = torch.bfloat16  # what MLX keeps activations in


def default_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def dequantize(w, scales, biases, group_size):
    """MLX affine format: each uint32 holds 32/bits values, lowest bits first;
    every `group_size` values share one scale and one offset. Returns float32 [..., in]."""
    bits = w.shape[-1] * 32 // (scales.shape[-1] * group_size)
    if 32 % bits:
        raise ValueError(f"{bits}-bit weights are not supported")
    per = 32 // bits
    shifts = torch.arange(0, 32, bits, device=w.device, dtype=torch.int32)
    q = (w.unsqueeze(-1) >> shifts) & ((1 << bits) - 1)            # [..., words, per]
    q = q.reshape(*w.shape[:-1], -1, group_size).float()           # [..., groups, gs]
    out = q * scales.float().unsqueeze(-1) + biases.float().unsqueeze(-1)
    return out.reshape(*w.shape[:-1], w.shape[-1] * per)


class QLinear:
    """A (possibly stacked, for experts) quantized linear layer: weight [..., out, in]."""

    def __init__(self, w, scales, biases, group_size):
        self.w, self.scales, self.biases, self.gs = w, scales, biases, group_size

    def weight(self, idx=None):
        if idx is None:
            return dequantize(self.w, self.scales, self.biases, self.gs)
        return dequantize(self.w[idx], self.scales[idx], self.biases[idx], self.gs)

    def __call__(self, x, idx=None):
        return (x.float() @ self.weight(idx).transpose(-1, -2)).to(DTYPE)

    def rows(self, ids):
        """Embedding lookup: dequantize only the requested rows."""
        return dequantize(self.w[ids], self.scales[ids], self.biases[ids], self.gs).to(DTYPE)


class Dense:
    """An unquantized linear layer (original Hugging Face checkpoints), same interface as QLinear."""

    def __init__(self, w):
        self.w = w

    def __call__(self, x, idx=None):
        return (x.float() @ self.w.float().T).to(DTYPE)

    def rows(self, ids):
        return self.w[ids].to(DTYPE)


def linear(p, name, gs):
    if f"{name}.scales" not in p:
        return Dense(p[f"{name}.weight"])
    return QLinear(p[f"{name}.weight"], p[f"{name}.scales"], p[f"{name}.biases"], gs)


def rms_norm(x, w, eps):
    xf = x.float()
    return (xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps) * w.float()).to(DTYPE)


def rope(x, offset, base):
    """Non-traditional RoPE (rotate the two halves), as nn.RoPE(traditional=False). x: [B, H, L, D]."""
    d = x.shape[-1]
    inv = base ** (-torch.arange(0, d, 2, device=x.device, dtype=torch.float32) / d)
    pos = torch.arange(offset, offset + x.shape[-2], device=x.device, dtype=torch.float32)
    ang = pos[:, None] * inv[None]
    cos, sin = ang.cos(), ang.sin()
    xf = x.float()
    x1, x2 = xf[..., : d // 2], xf[..., d // 2:]
    return torch.cat([x1 * cos - x2 * sin, x1 * sin + x2 * cos], -1).to(DTYPE)


class KVCache:
    def __init__(self):
        self.keys = self.values = None
        self.offset = 0

    def update_and_fetch(self, k, v):
        if self.keys is None:
            self.keys, self.values = k, v
        else:
            self.keys = torch.cat([self.keys, k], dim=2)
            self.values = torch.cat([self.values, v], dim=2)
        self.offset += k.shape[2]
        return self.keys, self.values


class Layer:
    def __init__(self, p, cfg, gs):
        def q(name):
            return linear(p, name, gs)

        self.cfg = cfg
        self.n_heads, self.n_kv = cfg["num_attention_heads"], cfg["num_key_value_heads"]
        self.head_dim = cfg.get("head_dim") or cfg["hidden_size"] // self.n_heads
        self.eps, self.theta = cfg["rms_norm_eps"], cfg["rope_theta"]
        self.q_proj, self.k_proj = q("self_attn.q_proj"), q("self_attn.k_proj")
        self.v_proj, self.o_proj = q("self_attn.v_proj"), q("self_attn.o_proj")
        self.q_norm, self.k_norm = p["self_attn.q_norm.weight"], p["self_attn.k_norm.weight"]
        self.in_norm = p["input_layernorm.weight"]
        self.post_norm = p["post_attention_layernorm.weight"]
        self.moe = "mlp.gate.weight" in p
        if self.moe:
            self.gate = q("mlp.gate")
            self.e_gate, self.e_up = q("mlp.switch_mlp.gate_proj"), q("mlp.switch_mlp.up_proj")
            self.e_down = q("mlp.switch_mlp.down_proj")
            self.top_k, self.norm_topk = cfg["num_experts_per_tok"], cfg["norm_topk_prob"]
        else:
            self.gate_proj, self.up_proj = q("mlp.gate_proj"), q("mlp.up_proj")
            self.down_proj = q("mlp.down_proj")

    def attention(self, x, cache):
        B, L, _ = x.shape
        qs = rms_norm(self.q_proj(x).view(B, L, self.n_heads, -1), self.q_norm, self.eps).transpose(1, 2)
        ks = rms_norm(self.k_proj(x).view(B, L, self.n_kv, -1), self.k_norm, self.eps).transpose(1, 2)
        vs = self.v_proj(x).view(B, L, self.n_kv, -1).transpose(1, 2)
        offset = cache.offset if cache is not None else 0
        qs, ks = rope(qs, offset, self.theta), rope(ks, offset, self.theta)
        if cache is not None:
            ks, vs = cache.update_and_fetch(ks, vs)
        mask = None
        if L > 1:  # causal, shifted by what's already cached
            S = ks.shape[2]
            mask = torch.arange(S, device=x.device)[None] <= torch.arange(S - L, S, device=x.device)[:, None]
        o = F.scaled_dot_product_attention(qs.float(), ks.float(), vs.float(), attn_mask=mask,
                                           scale=self.head_dim ** -0.5, enable_gqa=True)
        return self.o_proj(o.to(DTYPE).transpose(1, 2).reshape(B, L, -1))

    def mlp(self, x):
        if not self.moe:
            return self.down_proj((F.silu(self.gate_proj(x).float()) * self.up_proj(x).float()).to(DTYPE))
        shape = x.shape
        x = x.reshape(-1, shape[-1])
        gates = torch.softmax(self.gate(x).float(), dim=-1).to(DTYPE)
        # Router scores are rounded to bfloat16, so exact ties between the 8th and 9th expert are
        # common. MLX's argpartition tends to keep the higher expert index; torch.topk keeps the
        # lower. Sorting the reversed scores stably makes ties prefer the higher index too.
        n = gates.shape[-1]
        scores, rinds = torch.sort(gates.flip(-1), dim=-1, descending=True, stable=True)
        scores, inds = scores[..., :self.top_k], n - 1 - rinds[..., :self.top_k]
        if self.norm_topk:
            scores = scores / scores.sum(-1, keepdim=True)
        y = torch.zeros(x.shape, dtype=torch.float32, device=x.device)
        for e in inds.unique().tolist():
            tok, slot = (inds == e).nonzero(as_tuple=True)
            xe = x[tok]
            h = (F.silu(self.e_gate(xe, e).float()) * self.e_up(xe, e).float()).to(DTYPE)
            out = self.e_down(h, e)
            y.index_add_(0, tok, (out * scores[tok, slot, None]).float())
        return y.to(DTYPE).reshape(shape)

    def __call__(self, x, cache):
        h = x + self.attention(rms_norm(x, self.in_norm, self.eps), cache)
        return h + self.mlp(rms_norm(h, self.post_norm, self.eps))


class TorchShard:
    """Same interface as shard.Shard, on torch tensors: global layers [lo, hi) plus optional
    embeddings / final norm + lm_head."""

    def __init__(self, model_dir: str | Path, lo: int, hi: int, embed=False, head=False, device=None):
        d = Path(model_dir)
        self.cfg = cfg = json.loads((d / "config.json").read_text())
        self.lo, self.hi, self.has_embed, self.has_head = lo, hi, embed, head
        self.device = device or default_device()
        gs = cfg["quantization"]["group_size"]

        def wanted(k):
            if k.startswith("model.layers."):
                return lo <= int(k.split(".")[2]) < hi
            if k.startswith("model.embed_tokens."):
                return embed
            return head and k.startswith(("model.norm.", "lm_head."))

        p = {}
        for f in sorted(d.glob("*.safetensors")):
            with safe_open(str(f), framework="pt") as sf:
                for k in sf.keys():
                    if wanted(k) and k not in p:
                        t = sf.get_tensor(k)
                        if t.dtype == torch.uint32:
                            t = t.view(torch.int32)  # shifts and masks are only defined for signed ints
                        p[k] = t.to(self.device)

        def sub(prefix):
            return {k[len(prefix):]: v for k, v in p.items() if k.startswith(prefix)}

        self.layers = [Layer(sub(f"model.layers.{i}."), cfg, gs) for i in range(lo, hi)]
        if embed:
            e = sub("model.embed_tokens.")
            self.embed_tokens = QLinear(e["weight"], e["scales"], e["biases"], gs)
        if head:
            self.norm = p["model.norm.weight"]
            h = sub("lm_head.")
            self.lm_head = QLinear(h["weight"], h["scales"], h["biases"], gs)

    def make_cache(self, lo=None, hi=None):
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        return [KVCache() for _ in range(lo, hi)]

    @torch.inference_mode()
    def run_layers(self, h, cache, lo=None, hi=None):
        """Run global layers [lo, hi) (default: all of this shard's); `cache` has one entry per layer."""
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        assert self.lo <= lo <= hi <= self.hi, (lo, hi, self.lo, self.hi)
        h = h.to(self.device, DTYPE)
        for layer, c in zip(self.layers[lo - self.lo:hi - self.lo], cache):
            h = layer(h, c)
        return h

    @torch.inference_mode()
    def embed(self, ids):
        return self.embed_tokens.rows(torch.as_tensor(ids, device=self.device))

    @torch.inference_mode()
    def logits(self, h):
        return self.lm_head(rms_norm(h.to(self.device, DTYPE), self.norm, self.cfg["rms_norm_eps"]))
