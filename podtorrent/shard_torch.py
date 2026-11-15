"""PyTorch twin of shard.py: a Qwen3-MoE or Qwen3.5-MoE layer range that loads the same MLX 4-bit slices.

Weights stay packed on the device and are unpacked on the fly, so a slice takes the same memory
as under MLX. Rounding mirrors MLX: math runs in float32 and every place MLX produces a bfloat16
tensor (linear outputs, norms, attention, the KV cache) is cast to bfloat16 here too, so hidden
states from a PyTorch peer can be handed to an MLX peer mid-chain and vice versa.

Two paths compute the same thing:
- the reference path below (plain PyTorch, any device, any number of positions);
- on a GPU with Triton, a decode path (one position at a time, the common case) built from the fused
  kernels in torch_kernels.py: 4-bit matrix-vector products that unpack weights as they read them, the
  routed experts batched in one launch, norms, RoPE and attention fused. Each session's decode step is
  then captured as a CUDA graph and replayed, so the CPU no longer launches kernels one by one.
PODTORRENT_TORCH_FAST=0 turns the decode path off; PODTORRENT_CUDA_GRAPHS=0 keeps it but without graphs.
"""
import json
import os
import re
import sys
from pathlib import Path

import torch
import torch.nn.functional as F
from safetensors import safe_open

from . import torch_kernels as tk
from .slicer import text_config
from .torch_kernels import dequantize

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


class QLinear:
    """A (possibly stacked, for experts) quantized linear layer: weight [..., out, in]."""

    def __init__(self, w, scales, biases, group_size):
        self.w, self.scales, self.biases, self.gs = w, scales, biases, group_size

    @property
    def q(self):
        return self.w, self.scales, self.biases, self.gs

    @property
    def bits(self):
        return self.w.shape[-1] * 32 // (self.scales.shape[-1] * self.gs)

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


def fast_ok(*lins) -> bool:
    """All quantized in a layout the fused kernels read."""
    return all(isinstance(lin, QLinear) and tk.qmv_supported(lin.w, lin.scales, lin.gs) for lin in lins)


def fuse_rows(lins):
    """Stack quantized layers that read the same input into one [sum(out), in] weight, so a decode step
    reads them in one kernel. Each layer keeps working on its own rows: its tensors become views of the
    stacked ones (no extra memory once the originals are freed). Returns the stacked QLinear, or None."""
    if not fast_ok(*lins) or len({(lin.gs, lin.bits, lin.w.shape[-1], lin.scales.dtype) for lin in lins}) != 1:
        return None
    if any(lin.w.dim() != 2 for lin in lins):
        return None
    w = torch.cat([lin.w for lin in lins])
    sc = torch.cat([lin.scales for lin in lins])
    b = torch.cat([lin.biases for lin in lins])
    at = 0
    for lin in lins:
        n = lin.w.shape[0]
        lin.w, lin.scales, lin.biases = w[at:at + n], sc[at:at + n], b[at:at + n]
        at += n
    return QLinear(w, sc, b, lins[0].gs)


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
    """Keys and values [1, n_kv, capacity, head_dim], grown in steps so a decode step writes in place."""
    STEP = 256

    def __init__(self):
        self.k = self.v = None
        self.offset = 0

    @property
    def keys(self):
        return None if self.k is None else self.k[:, :, :self.offset]

    @property
    def values(self):
        return None if self.v is None else self.v[:, :, :self.offset]

    def reserve(self, n, n_kv, head_dim, device) -> bool:
        """Room for n more positions. True if the buffers moved (a captured decode graph is then stale)."""
        need = self.offset + n
        cap = 0 if self.k is None else self.k.shape[2]
        if need <= cap:
            return False
        new = -(-max(need, min(2 * cap, cap + 4096)) // self.STEP) * self.STEP
        k = torch.empty(1, n_kv, new, head_dim, dtype=DTYPE, device=device)
        v = torch.empty_like(k)
        if self.offset:
            k[:, :, :self.offset] = self.k[:, :, :self.offset]
            v[:, :, :self.offset] = self.v[:, :, :self.offset]
        self.k, self.v = k, v
        return True

    def update_and_fetch(self, k, v):
        L = k.shape[2]
        self.reserve(L, k.shape[1], k.shape[3], k.device)
        self.k[:, :, self.offset:self.offset + L] = k
        self.v[:, :, self.offset:self.offset + L] = v
        self.offset += L
        return self.keys, self.values


class LinearCache:
    """A gated-DeltaNet layer's state between calls: the conv input's last kernel-1 positions and the
    delta-rule state [B, Hv, Dv, Dk] (float32, as MLX keeps it). Fixed size, however long the session."""

    def __init__(self):
        self.conv = self.state = None
        self.offset = 0


class CacheList(list):
    """One cache per layer of a hop, plus what the GPU decode path keeps per session: the position as a
    device tensor (kernels and CUDA graphs read it from there) and the captured decode graph."""

    def __init__(self, items, device=None):
        super().__init__(items)
        self.pos_t = None if device is None else torch.zeros(1, dtype=torch.int32, device=device)
        self.graph = None
        self.graph_failed = False
        self.eager_steps = 0


class DecodeGraph:
    def __init__(self, key, graph, inp, out):
        self.key, self.graph, self.inp, self.out = key, graph, inp, out


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
        self.conv_w = p["conv1d.weight"].float()[..., 0].contiguous()   # MLX layout [C, K, 1] -> [C, K]
        self.A = -torch.exp(p["A_log"].float())                    # float32 in the checkpoint
        self.dt_bias = p["dt_bias"]
        self.norm = p["norm.weight"]
        self.in_proj = fuse_rows([self.in_proj_qkv, self.in_proj_z, self.in_proj_b, self.in_proj_a])
        pow2 = all(d & (d - 1) == 0 for d in (self.dk, self.dv))
        self.fast = self.in_proj is not None and fast_ok(self.out_proj) and pow2 and self.nv % self.nk == 0

    def ensure_state(self, cache, device):
        if cache.conv is None:
            cache.conv = torch.zeros(1, self.kernel - 1, 2 * self.key_dim + self.value_dim, dtype=DTYPE,
                                     device=device)
        if cache.state is None:
            cache.state = torch.zeros(1, self.nv, self.dv, self.dk, dtype=torch.float32, device=device)
        cache.conv, cache.state = cache.conv.contiguous(), cache.state.contiguous()

    def decode(self, xn, cache):
        """One position, fused kernels; cache tensors updated in place. xn: [1, hidden] bfloat16."""
        out = tk.qmv_triton(xn, *self.in_proj.q)[0]
        c = 2 * self.key_dim + self.value_dim
        qkv, z = out[:c], out[c:c + self.value_dim]
        b, a = out[c + self.value_dim:c + self.value_dim + self.nv], out[c + self.value_dim + self.nv:]
        conv = tk.conv_step_triton(qkv, cache.conv[0], self.conv_w)
        y = tk.delta_rule_triton(conv[None], b[None], a[None], self.A, self.dt_bias, cache.state[0], self.eps,
                                 self.key_dim, self.dk, self.dv, self.nv // self.nk)
        return tk.qmv(tk.gated_norm_triton(y[0], z.view(self.nv, self.dv), self.norm, self.eps), self.out_proj.q)

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
        state = cache.state if cache is not None and cache.state is not None else \
            torch.zeros(B, self.nv, self.dv, self.dk, dtype=torch.float32, device=x.device)
        if B == 1 and self.fast and tk.use_triton(x):
            # The recurrence below in one kernel launch, the state kept on chip across positions.
            state = state.clone()
            y = tk.delta_rule_triton(conv[0].contiguous(), b[0].contiguous(), a[0].contiguous(), self.A,
                                     self.dt_bias, state[0], self.eps, self.key_dim, self.dk, self.dv,
                                     self.nv // self.nk)[None]
            return self._finish(y, z, state, cache, S, B)
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
        ys = []
        for t in range(S):
            state = state * g[:, t, :, None, None]
            kt = kf[:, t]                                           # [B, Hv, Dk]
            mem = torch.einsum("bhvk,bhk->bhv", state, kt)
            delta = (vf[:, t] - mem) * beta[:, t, :, None]
            state = state + delta[..., None] * kt[:, :, None, :]
            ys.append(torch.einsum("bhvk,bhk->bhv", state, qf[:, t]))
        y = torch.stack(ys, 1).to(DTYPE)                            # [B, S, Hv, Dv]
        return self._finish(y, z, state, cache, S, B)

    def _finish(self, y, z, state, cache, S, B):
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
            self.qkv = fuse_rows([self.q_proj, self.k_proj, self.v_proj])
            d = self.rope_dims
            self.inv_freq = self.theta ** (-torch.arange(0, d, 2, device=self.q_norm.device, dtype=torch.float32) / d)
            hd = self.head_dim
            self.attn_fast = (self.qkv is not None and fast_ok(self.o_proj) and hd & (hd - 1) == 0
                              and d % 2 == 0 and self.n_heads % self.n_kv == 0)
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
        if self.moe:
            mlp_fast = fast_ok(self.gate, self.e_gate, self.e_up, self.e_down) and \
                (not self.shared or fast_ok(self.s_gate, self.s_up, self.s_down, self.s_scale))
        else:
            mlp_fast = fast_ok(self.gate_proj, self.up_proj, self.down_proj)
        attn_fast = self.linear_attn.fast if self.linear else self.attn_fast
        self.fast = mlp_fast and attn_fast and self.in_norm.shape[-1] <= 16384

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
        # Router scores are rounded to bfloat16, so exact ties between the 8th and 9th expert are
        # common. MLX's argpartition tends to keep the higher expert index; torch.topk keeps the
        # lower. router_torch sorts the reversed scores stably, so ties prefer the higher index too.
        inds, scores = tk.router_torch(self.gate(x), self.top_k, self.norm_topk)
        # With the Triton kernel each slot reads its expert's 4-bit rows once: cheaper than unpacking every
        # chosen expert to float32 until there are many more slots than experts.
        limit = 4 * self.e_gate.w.shape[0] if tk.use_triton(x) else 64
        if inds.numel() <= limit and fast_ok(self.e_gate, self.e_up, self.e_down):
            # A few tokens (decode): gather just the chosen experts and run them in one batch, no host sync.
            eids, sc = inds.reshape(-1), scores.reshape(-1)
            h = tk.qmv_swiglu(x, self.e_gate.q, self.e_up.q, eids, xdiv=self.top_k)
            y = tk.qmv_moe_down(h, self.e_down.q, eids, sc, self.top_k)
        else:
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

    def attention_decode(self, xn, cache, pos_t):
        qkv = tk.qmv_triton(xn, *self.qkv.q)
        q = tk.qk_norm_rope_triton(qkv, self.q_norm, self.k_norm, self.eps, self.inv_freq, self.rope_dims, pos_t,
                                   cache.k, cache.v, self.n_heads, self.n_kv, self.head_dim, self.out_gate)
        gate = qkv[0, self.head_dim:] if self.out_gate else None
        o = tk.attn_decode_triton(q, cache.k, cache.v, pos_t, self.head_dim ** -0.5, gate, 2 * self.head_dim)
        return tk.qmv(o, self.o_proj.q)

    def mlp_decode(self, hn, h):
        """h + mlp(hn) for decode rows, fused kernels."""
        if not self.moe:
            return h + tk.qmv(tk.qmv_swiglu(hn, self.gate_proj.q, self.up_proj.q), self.down_proj.q)
        eids, scores = tk.router(tk.qmv(hn, self.gate.q), self.top_k, self.norm_topk)
        hh = tk.qmv_swiglu(hn, self.e_gate.q, self.e_up.q, eids, xdiv=self.top_k)
        if not self.shared:
            return tk.qmv_moe_down(hh, self.e_down.q, eids, scores, self.top_k, residual=h)
        y = tk.qmv_moe_down(hh, self.e_down.q, eids, scores, self.top_k)
        sy = tk.qmv(tk.qmv_swiglu(hn, self.s_gate.q, self.s_up.q), self.s_down.q)
        return tk.shared_combine_triton(h, y, tk.qmv(hn, self.s_scale.q), sy)

    def decode(self, x, cache, pos_t):
        """One position through the layer with the fused kernels. x: [1, 1, hidden]. Doesn't advance
        cache offsets (the caller does, once per step), so the same calls can be captured in a CUDA graph."""
        H = x.shape[-1]
        x2 = x.reshape(1, H)
        _, xn = tk.add_rms_norm_triton(x2, None, self.in_norm, self.eps)
        a = self.linear_attn.decode(xn, cache) if self.linear else self.attention_decode(xn, cache, pos_t)
        h, hn = tk.add_rms_norm_triton(x2, a, self.post_norm, self.eps)
        return self.mlp_decode(hn, h).view(1, 1, H)

    def reserve(self, cache, n, device) -> bool:
        if self.linear:
            had = cache.conv is not None and cache.state is not None
            self.linear_attn.ensure_state(cache, device)
            return not had
        return cache.reserve(n, self.n_kv, self.head_dim, device)

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
            # Popped, so each layer's original tensors are freed as soon as it has stacked its own.
            return {k[len(prefix):]: p.pop(k) for k in [k for k in p if k.startswith(prefix)]}

        self.layers = [Layer(sub(f"model.layers.{i}."), cfg, gs) for i in range(lo, hi)]
        if embed:
            self.embed_tokens = linear(p, "model.embed_tokens", gs)
        if head:
            self.norm = p["model.norm.weight"]
            self.lm_head = linear(p, "lm_head", gs)
        self._warm_up()

    @torch.inference_mode()
    def _warm_up(self):
        """Compile every fused kernel now (Triton compiles on first use) and try a CUDA graph capture, on
        scratch caches, so a kernel this GPU can't build turns the fast path off here instead of failing
        mid-request with a cache half-updated. One layer of each kind; a few seconds on a cold kernel cache
        (~/.triton), well under one with a warm one."""
        dev = torch.device(self.device)
        if dev.type != "cuda" or not tk.FAST or not tk.triton_ok(dev):
            return
        try:
            kinds = {}
            for i, layer in enumerate(self.layers):
                if layer.fast:
                    kinds.setdefault(layer.linear, self.lo + i)
            H = self.cfg["hidden_size"]
            g = torch.Generator().manual_seed(0)
            for i in kinds.values():
                c = self.make_cache(i, i + 1)
                for n in (3, 1, 1, 1):   # prefill, eager decode step, capture + replay, replay
                    self.run_layers((torch.randn(1, n, H, generator=g) * 0.1).to(dev, DTYPE), c, i, i + 1)
                if GRAPHS and c.graph is None:   # kernels fine, capture not: keep the kernels, drop graphs
                    set_graphs(False)
            if self.has_head:
                self.logits((torch.randn(1, 1, H, generator=g) * 0.1).to(dev, DTYPE))
            torch.cuda.synchronize(dev)
        except Exception as e:  # noqa: BLE001
            tk.disable(dev, f"{type(e).__name__}: {str(e)[:300]}")

    def make_cache(self, lo=None, hi=None):
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        return CacheList([LinearCache() if layer.linear else KVCache()
                          for layer in self.layers[lo - self.lo:hi - self.lo]], self.device)

    @torch.inference_mode()
    def run_layers(self, h, cache, lo=None, hi=None):
        """Run global layers [lo, hi) (default: all of this shard's); `cache` has one entry per layer."""
        lo, hi = self.lo if lo is None else lo, self.hi if hi is None else hi
        assert self.lo <= lo <= hi <= self.hi, (lo, hi, self.lo, self.hi)
        h = h.to(self.device, DTYPE)
        layers = self.layers[lo - self.lo:hi - self.lo]
        if h.shape[:2] == (1, 1) and layers and all(layer.fast for layer in layers) and tk.use_triton(h) \
                and len({c.offset for c in cache}) == 1:
            return self._decode(h, layers, cache, (lo, hi))
        if isinstance(cache, CacheList):
            cache.graph = None   # the reference path may replace cache tensors a captured graph points at
        for layer, c in zip(layers, cache):
            h = layer(h, c)
        return h

    def _decode(self, h, layers, cache, key):
        """One position through `layers` with the fused kernels; replayed from a CUDA graph per session
        from its second decode step on."""
        moved = False
        for layer, c in zip(layers, cache):
            moved |= layer.reserve(c, 1, self.device)
        pos = cache[0].offset
        own = isinstance(cache, CacheList) and cache.pos_t is not None
        pos_t = cache.pos_t if own else torch.full((1,), pos, dtype=torch.int32, device=self.device)
        if own:
            pos_t.fill_(pos)
        g = None
        if own and GRAPHS and tk.FAST and not cache.graph_failed:
            if moved or (cache.graph is not None and cache.graph.key != key):
                cache.graph = None
            if cache.graph is None and cache.eager_steps >= 1:   # kernels compiled by an eager step first
                cache.graph = self._capture(h, layers, cache, pos_t, key)
            g = cache.graph
        if g is not None:
            g.inp.copy_(h)
            g.graph.replay()
            out = g.out.clone()
        else:
            out = h
            for layer, c in zip(layers, cache):
                out = layer.decode(out, c, pos_t)
            if own:
                cache.eager_steps += 1
        for c in cache:
            c.offset += 1
        return out

    def _capture(self, h, layers, cache, pos_t, key):
        try:
            inp = h.clone()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, capture_error_mode="thread_local"):
                out = inp
                for layer, c in zip(layers, cache):
                    out = layer.decode(out, c, pos_t)
            return DecodeGraph(key, graph, inp, out)
        except Exception as e:  # noqa: BLE001
            print(f"PodTorrent: CUDA graph capture failed ({type(e).__name__}: {str(e)[:200]}); "
                  "running decode steps without it.", file=sys.stderr)
            cache.graph_failed = True
            return None

    @torch.inference_mode()
    def embed(self, ids):
        return self.embed_tokens.rows(torch.as_tensor(ids, device=self.device))

    @torch.inference_mode()
    def logits(self, h):
        h = rms_norm(h.to(self.device, DTYPE), self.norm, self.cfg["rms_norm_eps"])
        B, T, H = h.shape
        if B * T <= 4 and fast_ok(self.lm_head) and tk.use_triton(h):
            return tk.qmv(h.reshape(B * T, H), self.lm_head.q).view(B, T, -1)
        return self.lm_head(h)


GRAPHS = os.environ.get("PODTORRENT_CUDA_GRAPHS", "1") != "0"


def set_fast(on: bool):
    """Fused kernels and CUDA graphs on (default where they work) or off (reference path only)."""
    tk.set_fast(on)


def set_graphs(on: bool):
    global GRAPHS
    GRAPHS = bool(on)


def describe(device=None) -> str:
    dev = device or default_device()
    if not tk.FAST:
        return "off (PODTORRENT_TORCH_FAST=0)"
    if not tk.triton_ok(dev):
        return "PyTorch only (no working Triton on this device)"
    return f"Triton kernels on {dev}" + (", CUDA graphs" if GRAPHS else ", no CUDA graphs")
