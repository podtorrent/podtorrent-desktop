"""PyTorch twin of shard.py: a Qwen3-MoE or Qwen3.5-MoE layer range that loads the same MLX 4-bit slices.

Weights stay packed on the device and are unpacked on the fly, so a slice takes the same memory
as under MLX. Rounding mirrors MLX: math runs in float32 and every place MLX produces a bfloat16
tensor (linear outputs, norms, attention, the KV cache) is cast to bfloat16 here too, so hidden
states from a PyTorch peer can be handed to an MLX peer mid-chain and vice versa.
"""
import json
import re
import sys
from pathlib import Path

import torch
import torch.nn.functional as F
from safetensors import safe_open

from .slicer import text_config

DTYPE = torch.bfloat16  # what MLX keeps activations in
PREFIX_RE = re.compile(r"^language_model\.")


def gpu_works() -> bool:
    """Run one small kernel. A GPU can report itself available and still fail at the first real call
    (ROCm PyTorch built without this chip's architecture says "invalid device function")."""
    try:
        a = torch.randn(64, 64, device="cuda", dtype=DTYPE)
        torch.cuda.synchronize()
        return bool(torch.isfinite((a @ a).float().sum()).item())
    except Exception as e:  # noqa: BLE001
        print(f"PodTorrent: the GPU failed a test calculation ({e}); running on the CPU.", file=sys.stderr)
        return False


def default_device() -> str:
    if torch.cuda.is_available() and gpu_works():
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
        w = self.w if idx is None else self.w[idx]
        return (x.float() @ w.float().transpose(-1, -2)).to(DTYPE)

    def rows(self, ids):
        return self.w[ids].to(DTYPE)


def linear(p, name, gs):
    if f"{name}.scales" not in p:
        return Dense(p[f"{name}.weight"])
    return QLinear(p[f"{name}.weight"], p[f"{name}.scales"], p[f"{name}.biases"], gs)


def rms_norm(x, w, eps):
    xf = x.float()
    return (xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps) * w.float()).to(DTYPE)


def rms_norm_plain(x, eps):
    """mx.fast.rms_norm(x, None, eps): no weight."""
    xf = x.float()
    return (xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps)).to(DTYPE)


def rope(x, offset, base, dims=None):
    """Non-traditional RoPE (rotate the two halves), as nn.RoPE(dims, traditional=False). x: [B, H, L, D].
    With dims < D (Qwen3.5's partial rotary) only the first `dims` features turn; the rest pass through."""
    d = dims or x.shape[-1]
    inv = base ** (-torch.arange(0, d, 2, device=x.device, dtype=torch.float32) / d)
    pos = torch.arange(offset, offset + x.shape[-2], device=x.device, dtype=torch.float32)
    ang = pos[:, None] * inv[None]
    cos, sin = ang.cos(), ang.sin()
    xf = x[..., :d].float()
    x1, x2 = xf[..., : d // 2], xf[..., d // 2:]
    out = torch.cat([x1 * cos - x2 * sin, x1 * sin + x2 * cos], -1).to(DTYPE)
    return out if d == x.shape[-1] else torch.cat([out, x[..., d:]], -1)


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


class LinearCache:
    """A gated-DeltaNet layer's state between calls: the conv input's last kernel-1 positions and the
    delta-rule state [B, Hv, Dv, Dk] (float32, as MLX keeps it). Fixed size, however long the session."""

    def __init__(self):
        self.conv = self.state = None
        self.offset = 0


def silu_bf16(x):
    return F.silu(x.float()).to(DTYPE)


class GatedDeltaNet:
    """Qwen3.5's linear attention (mlx_lm qwen3_5.GatedDeltaNet): a causal depthwise conv over q/k/v, then
    the gated delta rule, run one position at a time like MLX's kernel."""

    def __init__(self, p, cfg, gs):
        def q(name):
            return linear(p, name, gs)

        self.nk, self.nv = cfg["linear_num_key_heads"], cfg["linear_num_value_heads"]
        self.dk, self.dv = cfg["linear_key_head_dim"], cfg["linear_value_head_dim"]
        self.key_dim, self.value_dim = self.nk * self.dk, self.nv * self.dv
        self.kernel = cfg["linear_conv_kernel_dim"]
        self.eps = cfg["rms_norm_eps"]
        self.in_proj_qkv, self.in_proj_z = q("in_proj_qkv"), q("in_proj_z")
        self.in_proj_b, self.in_proj_a = q("in_proj_b"), q("in_proj_a")
        self.out_proj = q("out_proj")
        self.conv_w = p["conv1d.weight"].float()[..., 0]          # MLX layout [C, K, 1] -> [C, K]
        self.A = -torch.exp(p["A_log"].float())                    # float32 in the checkpoint
        self.dt_bias = p["dt_bias"]
        self.norm = p["norm.weight"]

    def __call__(self, x, cache):
        B, S, _ = x.shape
        qkv = self.in_proj_qkv(x)
        z = self.in_proj_z(x).view(B, S, self.nv, self.dv)
        b, a = self.in_proj_b(x), self.in_proj_a(x)

        conv_state = cache.conv if cache is not None and cache.conv is not None else \
            torch.zeros(B, self.kernel - 1, qkv.shape[-1], dtype=DTYPE, device=x.device)
        conv_in = torch.cat([conv_state, qkv], 1)                  # [B, K-1+S, C]
        if cache is not None:
            cache.conv = conv_in[:, -(self.kernel - 1):].contiguous()
        conv = (conv_in.float().unfold(1, self.kernel, 1) * self.conv_w).sum(-1)   # [B, S, C]
        conv = silu_bf16(conv.to(DTYPE))
        qs, ks, vs = conv.split([self.key_dim, self.key_dim, self.value_dim], -1)
        qs, ks = qs.reshape(B, S, self.nk, self.dk), ks.reshape(B, S, self.nk, self.dk)
        vs = vs.reshape(B, S, self.nv, self.dv)

        # normalize_qk: L2-normalize, with Dk**-0.5 folded in (twice into q: the readout scale).
        inv = self.dk ** -0.5
        qs = (rms_norm_plain(qs, self.eps * inv ** 2).float() * inv ** 2).to(DTYPE)
        ks = (rms_norm_plain(ks, self.eps * inv ** 2).float() * inv).to(DTYPE)

        beta = torch.sigmoid(b.float()).to(DTYPE).float()           # [B, S, Hv]
        sp = F.softplus((a + self.dt_bias).float()).to(DTYPE).float()
        g = torch.exp(self.A * sp)                                  # [B, S, Hv] float32

        rep = self.nv // self.nk                                    # value head h reads key head h // rep
        qf = qs.float().repeat_interleave(rep, 2)
        kf = ks.float().repeat_interleave(rep, 2)
        vf = vs.float()
        state = cache.state if cache is not None and cache.state is not None else \
            torch.zeros(B, self.nv, self.dv, self.dk, dtype=torch.float32, device=x.device)
        ys = []
        for t in range(S):
            state = state * g[:, t, :, None, None]
            kt = kf[:, t]                                           # [B, Hv, Dk]
            mem = torch.einsum("bhvk,bhk->bhv", state, kt)
            delta = (vf[:, t] - mem) * beta[:, t, :, None]
            state = state + delta[..., None] * kt[:, :, None, :]
            ys.append(torch.einsum("bhvk,bhk->bhv", state, qf[:, t]))
        y = torch.stack(ys, 1).to(DTYPE)                            # [B, S, Hv, Dv]
        if cache is not None:
            cache.state = state
            cache.offset += S

        # RMSNormGated: rms_norm(y) * silu(z), the product in float32.
        y = rms_norm(y, self.norm, self.eps)
        y = (F.silu(z.float()) * y.float()).to(DTYPE)
        return self.out_proj(y.reshape(B, S, -1))


class Layer:
    def __init__(self, p, cfg, gs):
        def q(name):
            return linear(p, name, gs)

        self.cfg = cfg
        self.eps = cfg["rms_norm_eps"]
        self.in_norm = p["input_layernorm.weight"]
        self.post_norm = p["post_attention_layernorm.weight"]
        # Qwen3.5: gated DeltaNet layers, with a full-attention layer every full_attention_interval-th.
        self.linear = "linear_attn.A_log" in p
        if self.linear:
            self.linear_attn = GatedDeltaNet({k[len("linear_attn."):]: v for k, v in p.items()
                                              if k.startswith("linear_attn.")}, cfg, gs)
        else:
            rp = cfg.get("rope_parameters") or {}
            self.n_heads, self.n_kv = cfg["num_attention_heads"], cfg["num_key_value_heads"]
            self.head_dim = cfg.get("head_dim") or cfg["hidden_size"] // self.n_heads
            # Qwen3.5 keeps these in rope_parameters (mlx_lm reads them from there first).
            self.theta = rp.get("rope_theta") or cfg["rope_theta"]
            self.rope_dims = int(self.head_dim * (rp.get("partial_rotary_factor") or cfg.get("partial_rotary_factor", 1.0)))
            self.q_proj, self.k_proj = q("self_attn.q_proj"), q("self_attn.k_proj")
            self.v_proj, self.o_proj = q("self_attn.v_proj"), q("self_attn.o_proj")
            self.q_norm, self.k_norm = p["self_attn.q_norm.weight"], p["self_attn.k_norm.weight"]
            # Qwen3.5's q_proj is twice as wide: per head, the queries then a sigmoid gate on the output.
            self.out_gate = self.q_proj.w.shape[-2] == 2 * self.n_heads * self.head_dim
        self.moe = "mlp.gate.weight" in p
        if self.moe:
            self.gate = q("mlp.gate")
            self.e_gate, self.e_up = q("mlp.switch_mlp.gate_proj"), q("mlp.switch_mlp.up_proj")
            self.e_down = q("mlp.switch_mlp.down_proj")
            self.top_k, self.norm_topk = cfg["num_experts_per_tok"], cfg.get("norm_topk_prob", True)
            self.shared = "mlp.shared_expert.gate_proj.weight" in p   # Qwen3.5: one always-on expert
            if self.shared:
                self.s_gate, self.s_up = q("mlp.shared_expert.gate_proj"), q("mlp.shared_expert.up_proj")
                self.s_down, self.s_scale = q("mlp.shared_expert.down_proj"), q("mlp.shared_expert_gate")
        else:
            self.gate_proj, self.up_proj = q("mlp.gate_proj"), q("mlp.up_proj")
            self.down_proj = q("mlp.down_proj")

    def attention(self, x, cache):
        B, L, _ = x.shape
        qs = self.q_proj(x).view(B, L, self.n_heads, -1)
        if self.out_gate:
            qs, gate = qs.split(self.head_dim, -1)
            gate = gate.reshape(B, L, -1)
        qs = rms_norm(qs, self.q_norm, self.eps).transpose(1, 2)
        ks = rms_norm(self.k_proj(x).view(B, L, self.n_kv, -1), self.k_norm, self.eps).transpose(1, 2)
        vs = self.v_proj(x).view(B, L, self.n_kv, -1).transpose(1, 2)
        offset = cache.offset if cache is not None else 0
        qs, ks = rope(qs, offset, self.theta, self.rope_dims), rope(ks, offset, self.theta, self.rope_dims)
        if cache is not None:
            ks, vs = cache.update_and_fetch(ks, vs)
        mask = None
        if L > 1:  # causal, shifted by what's already cached
            S = ks.shape[2]
            mask = torch.arange(S, device=x.device)[None] <= torch.arange(S - L, S, device=x.device)[:, None]
        o = F.scaled_dot_product_attention(qs.float(), ks.float(), vs.float(), attn_mask=mask,
                                           scale=self.head_dim ** -0.5, enable_gqa=True)
        o = o.to(DTYPE).transpose(1, 2).reshape(B, L, -1)
        if self.out_gate:
            o = (o * torch.sigmoid(gate.float()).to(DTYPE)).to(DTYPE)
        return self.o_proj(o)

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
        y = y.to(DTYPE)
        if self.shared:
            sy = self.s_down((F.silu(self.s_gate(x).float()) * self.s_up(x).float()).to(DTYPE))
            y = y + (torch.sigmoid(self.s_scale(x).float()).to(DTYPE) * sy).to(DTYPE)
        return y.reshape(shape)

    def __call__(self, x, cache):
        xn = rms_norm(x, self.in_norm, self.eps)
        h = x + (self.linear_attn(xn, cache) if self.linear else self.attention(xn, cache))
        return h + self.mlp(rms_norm(h, self.post_norm, self.eps))


class TorchShard:
    """Same interface as shard.Shard, on torch tensors: global layers [lo, hi) plus optional
    embeddings / final norm + lm_head."""

    def __init__(self, model_dir: str | Path, lo: int, hi: int, embed=False, head=False, device=None):
        d = Path(model_dir)
        top = json.loads((d / "config.json").read_text())
        self.cfg = cfg = text_config(top)
        self.lo, self.hi, self.has_embed, self.has_head = lo, hi, embed, head
        self.device = device or default_device()
        gs = (top.get("quantization") or {}).get("group_size")

        def wanted(k):
            if k.startswith("model.layers."):
                return lo <= int(k.split(".")[2]) < hi
            if k.startswith("model.embed_tokens."):
                return embed
            return head and k.startswith(("model.norm.", "lm_head."))

        p = {}
        for f in sorted(d.glob("*.safetensors")):
            with safe_open(str(f), framework="pt") as sf:
                for name in sf.keys():
                    k = PREFIX_RE.sub("", name)  # Qwen3.5: "language_model.model.layers.N.…"
                    if wanted(k) and k not in p:
                        t = sf.get_tensor(name)
                        if t.dtype == torch.uint32:
                            t = t.view(torch.int32)  # shifts and masks are only defined for signed ints
                        p[k] = t.to(self.device)

        def sub(prefix):
            return {k[len(prefix):]: v for k, v in p.items() if k.startswith(prefix)}

        self.layers = [Layer(sub(f"model.layers.{i}."), cfg, gs) for i in range(lo, hi)]
        if embed:
            self.embed_tokens = linear(p, "model.embed_tokens", gs)
        if head:
            self.norm = p["model.norm.weight"]
            self.lm_head = linear(p, "lm_head", gs)

    def make_cache(self, lo=None, hi=None):
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        return [LinearCache() if layer.linear else KVCache() for layer in self.layers[lo - self.lo:hi - self.lo]]

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
