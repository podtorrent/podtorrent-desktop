"""Fused decode kernels for the PyTorch backend (shard_torch.py), with plain-PyTorch twins.

Every op here has two implementations with the same signature and the same rounding points:
- a Triton kernel, used on a GPU when Triton is installed and compiles (checked once, on first use);
- a PyTorch version (`*_torch`), used everywhere else (CPU, Windows builds without Triton, a failing
  Triton) and as the reference in tests.

The quantized matrix-vector kernels read MLX's affine format as stored (uint32 words holding 32/bits
values, lowest bits first; one bfloat16 scale and offset per `group_size` values), so weights keep their
4-bit size in memory and are never repacked or dequantized to a full matrix. They are meant for a few
rows at a time (decode); prefill with many rows goes through the PyTorch versions.

Rounding mirrors shard_torch's reference math, which mirrors MLX: float32 accumulation, a bfloat16
result wherever MLX produces a bfloat16 tensor.
"""
import os
import sys

import torch
import torch.nn.functional as F

DTYPE = torch.bfloat16

try:
    import triton
    import triton.language as tl
except Exception:  # noqa: BLE001  (missing, or broken against this torch)
    triton = None


# ---------------------------------------------------------------------------------------------------
# Reference math in PyTorch.

def dequantize(w, scales, biases, group_size):
    """MLX affine format: each uint32 holds 32/bits values, lowest bits first;
    every `group_size` values share one scale and one offset. Returns float32 [..., in]."""
    bits = w.shape[-1] * 32 // (scales.shape[-1] * group_size)
    if 32 % bits:
        raise ValueError(f"{bits}-bit weights are not supported")
    per = 32 // bits
    if bits == 4 and sys.byteorder == "little":
        # Byte j of a little-endian word holds values 2j (low nibble) and 2j+1: unpack in uint8, a quarter of
        # the memory traffic of int32 shifts. q*scale is exact in float32, so the fused multiply-add gives the
        # same floats.
        wb = w.view(torch.uint8)
        q = torch.stack([wb & 15, wb >> 4], -1).view(*w.shape[:-1], -1, group_size)
        out = torch.addcmul(biases.float().unsqueeze(-1), q.float(), scales.float().unsqueeze(-1))
        return out.view(*w.shape[:-1], w.shape[-1] * per)
    shifts = torch.arange(0, 32, bits, device=w.device, dtype=torch.int32)
    q = (w.unsqueeze(-1) >> shifts) & ((1 << bits) - 1)            # [..., words, per]
    q = q.reshape(*w.shape[:-1], -1, group_size).float()           # [..., groups, gs]
    out = q * scales.float().unsqueeze(-1) + biases.float().unsqueeze(-1)
    return out.reshape(*w.shape[:-1], w.shape[-1] * per)


def qmv_torch(x, w, s, b, gs, eids=None, xdiv=1):
    """out[r] = x[r // xdiv] @ W[eids[r]].T (or W.T without eids), as bfloat16. x: [R0, K]."""
    rows = x.shape[0] * xdiv if eids is None else eids.shape[0]
    xr = x.float().repeat_interleave(xdiv, 0) if xdiv > 1 else x.float()
    if eids is None:
        return (xr @ dequantize(w, s, b, gs).transpose(-1, -2)).to(DTYPE)
    wd = dequantize(w[eids], s[eids], b[eids], gs)                 # [R, N, K]
    return torch.bmm(xr[:rows, None, :], wd.transpose(-1, -2))[:, 0].to(DTYPE)


def swiglu_torch(g, u):
    """silu(gate) * up from bfloat16 linear outputs, product in float32, as MLX's SwiGLU."""
    return (F.silu(g.float()) * u.float()).to(DTYPE)


def qmv_swiglu_torch(x, wg, wu, gs, eids=None, xdiv=1):
    """swiglu(x @ Wg.T, x @ Wu.T), both projections rounded to bfloat16 first. wg/wu: (w, s, b)."""
    return swiglu_torch(qmv_torch(x, *wg, gs, eids, xdiv), qmv_torch(x, *wu, gs, eids, xdiv))


def qmv_moe_down_torch(h, w, s, b, gs, eids, scores, topk, residual=None):
    """The routed experts' down projection, weighted and summed per token.
    h: [T*topk, K] (slot r = token r // topk), eids/scores: [T*topk]. Each expert output is rounded to
    bfloat16, times its bfloat16 score rounded again, summed in float32, rounded; plus residual if given."""
    out = qmv_torch(h, w, s, b, gs, eids)                          # [R, N] bf16
    y = (out * scores[:, None]).float().reshape(-1, topk, out.shape[-1]).sum(1).to(DTYPE)
    return y if residual is None else residual + y


def rms_norm_torch(x, w, eps):
    xf = x.float()
    y = xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps)
    return (y if w is None else y * w.float()).to(DTYPE)


def router_torch(logits, top_k, norm_topk):
    """softmax -> bfloat16 -> top-k (ties prefer the higher expert index, like MLX's argpartition) ->
    optional renormalization. Returns (expert ids int64 [T, k], scores bf16 [T, k])."""
    gates = torch.softmax(logits.float(), dim=-1).to(DTYPE)
    n = gates.shape[-1]
    scores, rinds = torch.sort(gates.flip(-1), dim=-1, descending=True, stable=True)
    scores, inds = scores[..., :top_k], n - 1 - rinds[..., :top_k]
    if norm_topk:
        scores = scores / scores.sum(-1, keepdim=True)
    return inds, scores


# ---------------------------------------------------------------------------------------------------
# Triton kernels.

if triton is not None:
    @triton.jit
    def _qdot(x_ptr, w_ptr, s_ptr, b_ptr, offs_n, nmask, K,
              BITS: tl.constexpr, GS: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr):
        """float32 [BLOCK_N]: rows offs_n of a quantized matrix times the vector at x_ptr.
        Works on whole uint32 words: value j of word p is x index p*PER + j, in group p // (GS/PER)."""
        PER: tl.constexpr = 32 // BITS
        WPB: tl.constexpr = BLOCK_K // PER       # words per row per block
        WPG: tl.constexpr = GS // PER            # words per group
        MASK: tl.constexpr = (1 << BITS) - 1
        wk = K // PER
        gk = K // GS
        acc = tl.zeros([BLOCK_N, WPB], dtype=tl.float32)
        wrow = w_ptr + offs_n[:, None].to(tl.int64) * wk
        srow = offs_n[:, None].to(tl.int64) * gk
        pw = tl.arange(0, WPB)
        for k0 in range(0, K, BLOCK_K):
            w = tl.load(wrow + (k0 // PER + pw)[None, :], mask=nmask[:, None], other=0)
            goff = srow + ((k0 // PER + pw) // WPG)[None, :]
            sc = tl.load(s_ptr + goff, mask=nmask[:, None], other=0).to(tl.float32)
            bi = tl.load(b_ptr + goff, mask=nmask[:, None], other=0).to(tl.float32)
            qx = tl.zeros([BLOCK_N, WPB], dtype=tl.float32)
            xs = tl.zeros([WPB], dtype=tl.float32)
            for j in tl.static_range(PER):
                xj = tl.load(x_ptr + k0 + pw * PER + j).to(tl.float32)
                qj = ((w >> (j * BITS)) & MASK).to(tl.float32)
                qx += qj * xj[None, :]
                xs += xj
            # sum_k (q*s + b) * x  =  s * sum_k q*x  +  b * sum_k x
            acc += sc * qx + bi * xs[None, :]
        return tl.sum(acc, axis=1)

    @triton.jit
    def _qmv_kernel(x_ptr, x_stride, out_ptr, out_stride, eid_ptr, N, K,
                    w_ptr, s_ptr, b_ptr, w_es, s_es,
                    w2_ptr, s2_ptr, b2_ptr,
                    XDIV: tl.constexpr, HAS_E: tl.constexpr, SWIGLU: tl.constexpr,
                    BITS: tl.constexpr, GS: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr):
        pid_n = tl.program_id(0)
        r = tl.program_id(1)
        xp = x_ptr + (r // XDIV).to(tl.int64) * x_stride
        if HAS_E:
            e = tl.load(eid_ptr + r).to(tl.int64)
            w_ptr += e * w_es
            s_ptr += e * s_es
            b_ptr += e * s_es
            if SWIGLU:
                w2_ptr += e * w_es
                s2_ptr += e * s_es
                b2_ptr += e * s_es
        offs_n = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)
        nmask = offs_n < N
        acc = _qdot(xp, w_ptr, s_ptr, b_ptr, offs_n, nmask, K, BITS, GS, BLOCK_N, BLOCK_K)
        if SWIGLU:
            g = acc.to(tl.bfloat16).to(tl.float32)
            u = _qdot(xp, w2_ptr, s2_ptr, b2_ptr, offs_n, nmask, K, BITS, GS, BLOCK_N, BLOCK_K)
            u = u.to(tl.bfloat16).to(tl.float32)
            acc = g * tl.sigmoid(g) * u
        tl.store(out_ptr + r.to(tl.int64) * out_stride + offs_n, acc.to(tl.bfloat16), mask=nmask)

    @triton.jit
    def _moe_down_kernel(h_ptr, h_stride, out_ptr, out_stride, res_ptr, eid_ptr, sc_ptr, N, K,
                         w_ptr, s_ptr, b_ptr, w_es, s_es,
                         TOPK: tl.constexpr, HAS_RES: tl.constexpr,
                         BITS: tl.constexpr, GS: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr):
        pid_n = tl.program_id(0)
        t = tl.program_id(1)
        offs_n = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)
        nmask = offs_n < N
        y = tl.zeros([BLOCK_N], dtype=tl.float32)
        for j in range(TOPK):
            r = t * TOPK + j
            e = tl.load(eid_ptr + r).to(tl.int64)
            acc = _qdot(h_ptr + r.to(tl.int64) * h_stride, w_ptr + e * w_es, s_ptr + e * s_es,
                        b_ptr + e * s_es, offs_n, nmask, K, BITS, GS, BLOCK_N, BLOCK_K)
            sc = tl.load(sc_ptr + r).to(tl.float32)
            y += (acc.to(tl.bfloat16).to(tl.float32) * sc).to(tl.bfloat16).to(tl.float32)
        y = y.to(tl.bfloat16)
        if HAS_RES:
            res = tl.load(res_ptr + t.to(tl.int64) * out_stride + offs_n, mask=nmask, other=0)
            y = (res.to(tl.float32) + y.to(tl.float32)).to(tl.bfloat16)
        tl.store(out_ptr + t.to(tl.int64) * out_stride + offs_n, y, mask=nmask)


    @triton.jit
    def _add_rms_norm_kernel(x_ptr, a_ptr, h_ptr, w_ptr, out_ptr, D, eps,
                             HAS_A: tl.constexpr, HAS_W: tl.constexpr, BLOCK: tl.constexpr):
        """h = x + a (bfloat16), out = rms_norm(h) * w, one row per program."""
        r = tl.program_id(0).to(tl.int64)
        offs = tl.arange(0, BLOCK)
        m = offs < D
        x = tl.load(x_ptr + r * D + offs, mask=m, other=0.0)
        if HAS_A:
            a = tl.load(a_ptr + r * D + offs, mask=m, other=0.0)
            x = (x.to(tl.float32) + a.to(tl.float32)).to(tl.bfloat16)
            tl.store(h_ptr + r * D + offs, x, mask=m)
        xf = x.to(tl.float32)
        y = xf * tl.rsqrt(tl.sum(xf * xf, 0) / D + eps)
        if HAS_W:
            y = y * tl.load(w_ptr + offs, mask=m, other=0.0).to(tl.float32)
        tl.store(out_ptr + r * D + offs, y.to(tl.bfloat16), mask=m)

    @triton.jit
    def _qk_norm_rope_kernel(qkv_ptr, q_ptr, kc_ptr, vc_ptr, qn_ptr, kn_ptr, inv_ptr, pos_ptr, cap, eps,
                             NQ: tl.constexpr, NKV: tl.constexpr, QS: tl.constexpr, KOFF: tl.constexpr,
                             VOFF: tl.constexpr, D: tl.constexpr, RD: tl.constexpr):
        """One decode position. Programs [0, NQ): query heads -> rms_norm(q_norm) -> RoPE -> q_ptr.
        [NQ, NQ+NKV): key heads -> rms_norm(k_norm) -> RoPE -> key cache at pos. Then value heads -> value cache."""
        p = tl.program_id(0)
        pos = tl.load(pos_ptr)
        offs = tl.arange(0, D)
        if p >= NQ + NKV:
            j = p - NQ - NKV
            v = tl.load(qkv_ptr + VOFF + j * D + offs)
            tl.store(vc_ptr + (j * cap + pos).to(tl.int64) * D + offs, v)
        else:
            if p < NQ:
                src = qkv_ptr + p * QS
                wp = qn_ptr
                dst = q_ptr + p * D
            else:
                j = p - NQ
                src = qkv_ptr + KOFF + j * D
                wp = kn_ptr
                dst = kc_ptr + (j * cap + pos).to(tl.int64) * D
            HALF: tl.constexpr = RD // 2
            x = tl.load(src + offs).to(tl.float32)
            r = tl.rsqrt(tl.sum(x * x, 0) / D + eps)
            n = (x * r * tl.load(wp + offs).to(tl.float32)).to(tl.bfloat16).to(tl.float32)
            partner = tl.where(offs < HALF, offs + HALF, offs - HALF)
            partner = tl.where(offs < RD, partner, offs)
            xp = tl.load(src + partner).to(tl.float32)
            npn = (xp * r * tl.load(wp + partner).to(tl.float32)).to(tl.bfloat16).to(tl.float32)
            f = tl.where(offs < HALF, offs, offs - HALF)
            f = tl.where(offs < RD, f, 0)
            ang = pos.to(tl.float32) * tl.load(inv_ptr + f)
            c = tl.cos(ang)
            sn = tl.sin(ang)
            out = tl.where(offs < HALF, n * c - npn * sn, npn * sn + n * c)
            out = tl.where(offs < RD, out, n)
            tl.store(dst + offs, out.to(tl.bfloat16))

    @triton.jit
    def _attn_split_kernel(q_ptr, kc_ptr, vc_ptr, part_ptr, pos_ptr, cap, scale,
                           REP: tl.constexpr, D: tl.constexpr, NSPLIT: tl.constexpr, BLOCK_S: tl.constexpr):
        """Attention of one query position over the cache's first pos+1 positions (flash-decoding): query
        head program_id(0), a 1/NSPLIT share of the positions program_id(1). Writes the share's running max,
        softmax denominator and unnormalized output (float32) for _attn_combine_kernel."""
        h = tl.program_id(0)
        sp = tl.program_id(1)
        base = ((h // REP) * cap).to(tl.int64) * D
        n = tl.load(pos_ptr) + 1
        chunk = tl.cdiv(tl.cdiv(n, NSPLIT), BLOCK_S) * BLOCK_S
        start = sp * chunk
        end = tl.minimum(start + chunk, n)
        offs_d = tl.arange(0, D)
        q = tl.load(q_ptr + h * D + offs_d).to(tl.float32)
        m = tl.zeros([], dtype=tl.float32) - float("inf")
        den = tl.zeros([], dtype=tl.float32)
        acc = tl.zeros([D], dtype=tl.float32)
        for s0 in range(start, end, BLOCK_S):
            offs_s = s0 + tl.arange(0, BLOCK_S)
            sm = offs_s < end
            kv_off = base + offs_s[:, None].to(tl.int64) * D + offs_d[None, :]
            k = tl.load(kc_ptr + kv_off, mask=sm[:, None], other=0.0).to(tl.float32)
            sc = tl.where(sm, tl.sum(k * q[None, :], 1) * scale, float("-inf"))
            m_new = tl.maximum(m, tl.max(sc, 0))
            pr = tl.exp(sc - m_new)
            alpha = tl.exp(m - m_new)
            v = tl.load(vc_ptr + kv_off, mask=sm[:, None], other=0.0).to(tl.float32)
            den = den * alpha + tl.sum(pr, 0)
            acc = acc * alpha + tl.sum(pr[:, None] * v, 0)
            m = m_new
        out = part_ptr + (h * NSPLIT + sp) * (D + 2)
        tl.store(out + offs_d, acc)
        tl.store(out + D, m)
        tl.store(out + D + 1, den)

    @triton.jit
    def _attn_combine_kernel(part_ptr, o_ptr, g_ptr, D: tl.constexpr, NSPLIT: tl.constexpr,
                             GSTRIDE: tl.constexpr, HAS_GATE: tl.constexpr):
        """Merge a head's NSPLIT shares -> bfloat16 output; optional sigmoid output gate (Qwen3.5)."""
        h = tl.program_id(0)
        offs_d = tl.arange(0, D)
        sp = tl.arange(0, NSPLIT)
        row = part_ptr + (h * NSPLIT + sp) * (D + 2)
        m = tl.load(row + D)
        den = tl.load(row + D + 1)
        acc = tl.load(row[:, None] + offs_d[None, :])
        w = tl.where(m == float("-inf"), 0.0, tl.exp(m - tl.max(m, 0)))
        o = (tl.sum(acc * w[:, None], 0) / tl.sum(den * w, 0)).to(tl.bfloat16)
        if HAS_GATE:
            g = tl.load(g_ptr + h * GSTRIDE + offs_d).to(tl.float32)
            g = tl.sigmoid(g).to(tl.bfloat16).to(tl.float32)
            o = (o.to(tl.float32) * g).to(tl.bfloat16)
        tl.store(o_ptr + h * D + offs_d, o)

    @triton.jit
    def _router_kernel(lg_ptr, eid_ptr, sc_ptr, E, K: tl.constexpr, KP: tl.constexpr, NORM: tl.constexpr,
                       BLOCK_E: tl.constexpr):
        """softmax -> bfloat16 -> top K (ties to the higher index) -> optional renormalization, per token."""
        t = tl.program_id(0).to(tl.int64)
        offs = tl.arange(0, BLOCK_E)
        m = offs < E
        x = tl.load(lg_ptr + t * E + offs, mask=m, other=float("-inf")).to(tl.float32)
        ex = tl.where(m, tl.exp(x - tl.max(x, 0)), 0.0)
        p = (ex / tl.sum(ex, 0)).to(tl.bfloat16).to(tl.float32)
        p = tl.where(m, p, -1.0)
        slot = tl.arange(0, KP)
        sel = tl.zeros([KP], dtype=tl.float32)
        ids = tl.zeros([KP], dtype=tl.int32)
        for j in tl.static_range(K):
            best = tl.max(p, 0)
            idx = tl.max(tl.where(p == best, offs, -1), 0)
            sel = tl.where(slot == j, best, sel)
            ids = tl.where(slot == j, idx, ids)
            p = tl.where(offs == idx, -2.0, p)
        if NORM:
            tot = tl.sum(sel, 0).to(tl.bfloat16).to(tl.float32)
            sel = sel / tot
        tl.store(eid_ptr + t * K + slot, ids, mask=slot < K)
        tl.store(sc_ptr + t * K + slot, sel.to(tl.bfloat16), mask=slot < K)

    @triton.jit
    def _shared_combine_kernel(res_ptr, y_ptr, sg_ptr, sy_ptr, out_ptr, N, BLOCK: tl.constexpr):
        """res + (y + sigmoid(sg) * sy), with bfloat16 rounding after each step (Qwen3.5's shared expert)."""
        t = tl.program_id(1).to(tl.int64)
        offs = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        m = offs < N
        g = tl.sigmoid(tl.load(sg_ptr + t).to(tl.float32)).to(tl.bfloat16).to(tl.float32)
        sy = tl.load(sy_ptr + t * N + offs, mask=m, other=0.0).to(tl.float32)
        z = (g * sy).to(tl.bfloat16).to(tl.float32)
        y = (tl.load(y_ptr + t * N + offs, mask=m, other=0.0).to(tl.float32) + z).to(tl.bfloat16)
        r = tl.load(res_ptr + t * N + offs, mask=m, other=0.0).to(tl.float32)
        tl.store(out_ptr + t * N + offs, (r + y.to(tl.float32)).to(tl.bfloat16), mask=m)

    @triton.jit
    def _conv_step_kernel(x_ptr, st_ptr, w_ptr, out_ptr, C, KS: tl.constexpr, BLOCK: tl.constexpr):
        """Gated DeltaNet's causal depthwise conv for one new position, then SiLU. The state (the last KS-1
        inputs, [KS-1, C]) shifts in place."""
        offs = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        m = offs < C
        x = tl.load(x_ptr + offs, mask=m, other=0.0)
        acc = tl.zeros([BLOCK], dtype=tl.float32)
        for j in tl.static_range(KS - 1):
            sv = tl.load(st_ptr + j * C + offs, mask=m, other=0.0).to(tl.float32)
            acc += sv * tl.load(w_ptr + offs * KS + j, mask=m, other=0.0)
        acc += x.to(tl.float32) * tl.load(w_ptr + offs * KS + (KS - 1), mask=m, other=0.0)
        for j in tl.static_range(KS - 2):
            tl.store(st_ptr + j * C + offs, tl.load(st_ptr + (j + 1) * C + offs, mask=m, other=0.0), mask=m)
        tl.store(st_ptr + (KS - 2) * C + offs, x, mask=m)
        y = acc.to(tl.bfloat16).to(tl.float32)
        tl.store(out_ptr + offs, (y * tl.sigmoid(y)).to(tl.bfloat16), mask=m)

    @triton.jit
    def _delta_rule_kernel(conv_ptr, conv_stride, b_ptr, a_ptr, ba_stride, A_ptr, dtb_ptr, st_ptr, y_ptr, S,
                           eps_n, inv, inv2,
                           KEY_DIM: tl.constexpr, DK: tl.constexpr, DV: tl.constexpr, REP: tl.constexpr,
                           NV: tl.constexpr, BV: tl.constexpr):
        """The gated delta rule over S positions, one after another (like MLX's kernel). Value head
        program_id(0), state rows (value features) program_id(1)*BV.. of its [DV, DK] float32 state, which
        stays in registers across positions and is written back in place at the end."""
        hv = tl.program_id(0)
        kh = hv // REP
        offs_k = tl.arange(0, DK)
        offs_v = tl.program_id(1) * BV + tl.arange(0, BV)
        sp_off = (hv * DV).to(tl.int64) * DK + offs_v[:, None] * DK + offs_k[None, :]
        St = tl.load(st_ptr + sp_off)
        A = tl.load(A_ptr + hv)
        dtb = tl.load(dtb_ptr + hv).to(tl.float32)
        for t in range(S):
            row = conv_ptr + t.to(tl.int64) * conv_stride
            q = tl.load(row + kh * DK + offs_k).to(tl.float32)
            k = tl.load(row + KEY_DIM + kh * DK + offs_k).to(tl.float32)
            qn = (q * tl.rsqrt(tl.sum(q * q, 0) / DK + eps_n)).to(tl.bfloat16).to(tl.float32)
            qn = (qn * inv2).to(tl.bfloat16).to(tl.float32)
            kn = (k * tl.rsqrt(tl.sum(k * k, 0) / DK + eps_n)).to(tl.bfloat16).to(tl.float32)
            kn = (kn * inv).to(tl.bfloat16).to(tl.float32)
            v = tl.load(row + 2 * KEY_DIM + hv * DV + offs_v).to(tl.float32)
            beta = tl.sigmoid(tl.load(b_ptr + t * ba_stride + hv).to(tl.float32)).to(tl.bfloat16).to(tl.float32)
            a = (tl.load(a_ptr + t * ba_stride + hv).to(tl.float32) + dtb).to(tl.bfloat16).to(tl.float32)
            sp = tl.where(a > 20.0, a, tl.where(a < -15.0, tl.exp(a), tl.log(1.0 + tl.exp(a))))
            sp = sp.to(tl.bfloat16).to(tl.float32)
            St = St * tl.exp(A * sp)
            delta = (v - tl.sum(St * kn[None, :], 1)) * beta
            St = St + delta[:, None] * kn[None, :]
            y = tl.sum(St * qn[None, :], 1)
            tl.store(y_ptr + (t * NV + hv).to(tl.int64) * DV + offs_v, y.to(tl.bfloat16))
        tl.store(st_ptr + sp_off, St)

    @triton.jit
    def _gated_norm_kernel(y_ptr, z_ptr, w_ptr, out_ptr, eps, D: tl.constexpr):
        """RMSNormGated: rms_norm(y) * w -> bfloat16, times silu(z) in float32 -> bfloat16. One head per program."""
        h = tl.program_id(0)
        offs = tl.arange(0, D)
        y = tl.load(y_ptr + h * D + offs).to(tl.float32)
        y = (y * tl.rsqrt(tl.sum(y * y, 0) / D + eps) * tl.load(w_ptr + offs).to(tl.float32))
        y = y.to(tl.bfloat16).to(tl.float32)
        z = tl.load(z_ptr + h * D + offs).to(tl.float32)
        tl.store(out_ptr + h * D + offs, (z * tl.sigmoid(z) * y).to(tl.bfloat16))


def _bits(w, s, gs):
    return w.shape[-1] * 32 // (s.shape[-1] * gs)


def _block_k(K, gs, bits):
    """Largest block of the reduction dimension (<= 256 values) that is whole groups, whole words and
    divides K, or None."""
    per = 32 // bits
    for bk in (256, 128, 64, 32):
        if bk % gs == 0 and bk % per == 0 and K % bk == 0:
            return bk
    return None


# Measured on an AMD Strix Halo (gfx1151) and a Jetson AGX Orin (sm_87): small blocks, one warp each.
BLOCK_N = int(os.environ.get("PODTORRENT_QMV_BLOCK_N", "8"))
NUM_WARPS = int(os.environ.get("PODTORRENT_QMV_WARPS", "1"))


def qmv_triton(x, w, s, b, gs, eids=None, xdiv=1, wu=None):
    N, wk = w.shape[-2], w.shape[-1]
    bits = _bits(w, s, gs)
    K = wk * (32 // bits)
    rows = x.shape[0] * xdiv if eids is None else eids.shape[0]
    out = torch.empty(rows, N, dtype=DTYPE, device=x.device)
    w2, s2, b2 = wu if wu is not None else (w, s, b)
    grid = (triton.cdiv(N, BLOCK_N), rows)
    _qmv_kernel[grid](x, x.stride(0), out, out.stride(0), eids if eids is not None else out, N, K,
                      w, s, b, N * wk, N * s.shape[-1], w2, s2, b2,
                      XDIV=xdiv, HAS_E=eids is not None, SWIGLU=wu is not None,
                      BITS=bits, GS=gs, BLOCK_N=BLOCK_N, BLOCK_K=_block_k(K, gs, bits), num_warps=NUM_WARPS)
    return out


def qmv_moe_down_triton(h, w, s, b, gs, eids, scores, topk, residual=None):
    N, wk = w.shape[-2], w.shape[-1]
    bits = _bits(w, s, gs)
    K = wk * (32 // bits)
    T = eids.shape[0] // topk
    out = torch.empty(T, N, dtype=DTYPE, device=h.device)
    grid = (triton.cdiv(N, BLOCK_N), T)
    _moe_down_kernel[grid](h, h.stride(0), out, out.stride(0), residual if residual is not None else out,
                           eids, scores, N, K, w, s, b, N * wk, N * s.shape[-1],
                           TOPK=topk, HAS_RES=residual is not None,
                           BITS=bits, GS=gs, BLOCK_N=BLOCK_N, BLOCK_K=_block_k(K, gs, bits), num_warps=NUM_WARPS)
    return out



def _p2(n):
    return triton.next_power_of_2(n)


def add_rms_norm_triton(x, a, w, eps):
    """(x + a, rms_norm(x + a) * w) for a [rows, D] bfloat16 x; with a=None, (x, rms_norm(x) * w)."""
    D = x.shape[-1]
    rows = x.numel() // D
    out = torch.empty_like(x)
    h = torch.empty_like(x) if a is not None else x
    _add_rms_norm_kernel[(rows,)](x, a if a is not None else x, h, w if w is not None else x, out, D, eps,
                                  HAS_A=a is not None, HAS_W=w is not None, BLOCK=_p2(D),
                                  num_warps=4 if D >= 1024 else 1)
    return h, out


def qk_norm_rope_triton(qkv, q_norm, k_norm, eps, inv_freq, rope_dims, pos_t, kc, vc, n_heads, n_kv, D, gated):
    """Decode-step queries (normed, rotated) [n_heads, D]; normed rotated keys and values written into the
    caches [1, n_kv, cap, D] at the position in pos_t."""
    q = torch.empty(n_heads, D, dtype=DTYPE, device=qkv.device)
    qs = 2 * D if gated else D
    _qk_norm_rope_kernel[(n_heads + 2 * n_kv,)](
        qkv, q, kc, vc, q_norm, k_norm, inv_freq, pos_t, kc.shape[2], eps,
        NQ=n_heads, NKV=n_kv, QS=qs, KOFF=n_heads * qs, VOFF=n_heads * qs + n_kv * D, D=D, RD=rope_dims,
        num_warps=1 if D <= 128 else 2)
    return q


ATTN_SPLITS = 8


def attn_decode_triton(q, kc, vc, pos_t, scale, gate=None, gate_stride=0):
    """q [n_heads, D] over caches [1, n_kv, cap, D] up to position pos_t (inclusive) -> [1, n_heads*D]."""
    n_heads, D = q.shape
    rep = n_heads // kc.shape[1]
    part = torch.empty(n_heads, ATTN_SPLITS, D + 2, dtype=torch.float32, device=q.device)
    o = torch.empty(1, n_heads * D, dtype=DTYPE, device=q.device)
    _attn_split_kernel[(n_heads, ATTN_SPLITS)](q, kc, vc, part, pos_t, kc.shape[2], scale, REP=rep, D=D,
                                               NSPLIT=ATTN_SPLITS, BLOCK_S=32 if D <= 128 else 16, num_warps=4)
    _attn_combine_kernel[(n_heads,)](part, o, gate if gate is not None else q, D=D, NSPLIT=ATTN_SPLITS,
                                     GSTRIDE=gate_stride, HAS_GATE=gate is not None, num_warps=1)
    return o


def router_triton(logits, top_k, norm_topk):
    T, E = logits.shape
    eids = torch.empty(T * top_k, dtype=torch.int32, device=logits.device)
    scores = torch.empty(T * top_k, dtype=DTYPE, device=logits.device)
    _router_kernel[(T,)](logits, eids, scores, E, K=top_k, KP=_p2(top_k), NORM=bool(norm_topk),
                         BLOCK_E=_p2(E), num_warps=1 if E <= 256 else 4)
    return eids, scores


def shared_combine_triton(res, y, sg, sy):
    T, N = res.shape
    out = torch.empty_like(res)
    _shared_combine_kernel[(triton.cdiv(N, 1024), T)](res, y, sg, sy, out, N, BLOCK=1024, num_warps=4)
    return out


def conv_step_triton(x, state, w):
    """x [C] bfloat16 (this position's conv input), state [KS-1, C] bfloat16 (shifted in place), w [C, KS]
    float32 -> silu(conv) [C] bfloat16."""
    C = x.numel()
    out = torch.empty(C, dtype=DTYPE, device=x.device)
    _conv_step_kernel[(triton.cdiv(C, 512),)](x, state, w, out, C, KS=w.shape[1], BLOCK=512, num_warps=4)
    return out


def delta_rule_triton(conv, b, a, A, dt_bias, state, eps, key_dim, dk, dv, rep):
    """conv: [S, 2*key_dim + Hv*dv] bfloat16 (q, k, v after conv+silu); b, a: [S, Hv] bfloat16 (rows may be
    strided views); state [Hv, dv, dk] float32, updated in place. Returns y [S, Hv, dv] bfloat16."""
    S = conv.shape[0]
    hv = state.shape[0]
    y = torch.empty(S, hv, dv, dtype=DTYPE, device=conv.device)
    inv = dk ** -0.5
    bv = 32 if dv % 32 == 0 else dv
    assert b.stride(-1) == 1 and a.stride(-1) == 1 and b.stride(0) == a.stride(0) and conv.stride(-1) == 1
    _delta_rule_kernel[(hv, dv // bv)](conv, conv.stride(0), b, a, b.stride(0), A, dt_bias, state, y, S,
                                       eps * inv ** 2, inv, inv ** 2,
                                       KEY_DIM=key_dim, DK=dk, DV=dv, REP=rep, NV=hv, BV=bv, num_warps=4)
    return y


def gated_norm_triton(y, z, w, eps):
    """y, z: [rows, D] (contiguous) -> [1, rows*D]."""
    H, D = y.shape
    out = torch.empty(1, H * D, dtype=DTYPE, device=y.device)
    _gated_norm_kernel[(H,)](y, z, w, out, eps, D=D, num_warps=1 if D <= 128 else 2)
    return out

# ---------------------------------------------------------------------------------------------------
# Dispatch.

_triton_ok = {}  # device -> bool, decided on first use
FAST = os.environ.get("PODTORRENT_TORCH_FAST", "1") != "0"   # PODTORRENT_TORCH_FAST=0: PyTorch versions only


def set_fast(on: bool):
    """Use the Triton kernels where they work (default), or the PyTorch versions everywhere."""
    global FAST
    FAST = bool(on)


def triton_ok(device) -> bool:
    """Triton is installed, the device is a GPU, and a small kernel compiles and gives the right answer
    (Triton needs a C compiler and a GPU architecture it knows)."""
    dev = torch.device(device)
    if triton is None or dev.type != "cuda":
        return False
    key = str(dev)
    if key not in _triton_ok:
        try:
            g = torch.Generator(device="cpu").manual_seed(0)
            w, s, b = (t.to(dev) for t in quantize_ref(torch.randn(64, 256, generator=g), 64, 4))
            x = torch.randn(2, 256, generator=g).to(dev, DTYPE)
            got, want = qmv_triton(x, w, s, b, 64).float(), qmv_torch(x, w, s, b, 64).float()
            _triton_ok[key] = bool(((got - want).abs().max() <= 0.02 * want.abs().max()).item())
            if not _triton_ok[key]:
                print("PodTorrent: fused GPU kernels gave a wrong answer; using the slower path.", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"PodTorrent: fused GPU kernels unavailable ({type(e).__name__}: {str(e)[:300]}); "
                  "using the slower path.", file=sys.stderr)
            _triton_ok[key] = False
    return _triton_ok[key]


def disable(device, why):
    """Stop using the kernels on this device (one failed to compile or run)."""
    print(f"PodTorrent: fused GPU kernels disabled ({why}); using the slower path.", file=sys.stderr)
    _triton_ok[str(torch.device(device))] = False


def use_triton(t) -> bool:
    return FAST and t.is_cuda and triton_ok(t.device)


def qmv_supported(w, s, gs) -> bool:
    """The kernels handle 4- and 8-bit weights whose rows split into whole blocks."""
    bits = _bits(w, s, gs)
    return bits in (4, 8) and _block_k(w.shape[-1] * (32 // bits), gs, bits) is not None


def qmv(x, lin, eids=None, xdiv=1):
    """lin = (w, scales, biases, group_size)."""
    w, s, b, gs = lin
    if use_triton(x) and qmv_supported(w, s, gs):
        return qmv_triton(x, w, s, b, gs, eids, xdiv)
    return qmv_torch(x, w, s, b, gs, eids, xdiv)


def qmv_swiglu(x, lg, lu, eids=None, xdiv=1):
    wg, sg, bg, gs = lg
    wu, su, bu, gsu = lu
    if use_triton(x) and gs == gsu and qmv_supported(wg, sg, gs) and _bits(wg, sg, gs) == _bits(wu, su, gs):
        return qmv_triton(x, wg, sg, bg, gs, eids, xdiv, wu=(wu, su, bu))
    return qmv_swiglu_torch(x, (wg, sg, bg), (wu, su, bu), gs, eids, xdiv) if gs == gsu else \
        swiglu_torch(qmv_torch(x, wg, sg, bg, gs, eids, xdiv), qmv_torch(x, wu, su, bu, gsu, eids, xdiv))


def qmv_moe_down(h, lin, eids, scores, topk, residual=None):
    w, s, b, gs = lin
    if use_triton(h) and qmv_supported(w, s, gs):
        return qmv_moe_down_triton(h, w, s, b, gs, eids, scores, topk, residual)
    return qmv_moe_down_torch(h, w, s, b, gs, eids, scores, topk, residual)


def router(logits, top_k, norm_topk):
    """(expert ids [T*k], scores [T*k] bfloat16), slot r belonging to token r // k."""
    if use_triton(logits) and logits.shape[-1] <= 4096:
        return router_triton(logits.contiguous(), top_k, norm_topk)
    inds, scores = router_torch(logits, top_k, norm_topk)
    return inds.reshape(-1), scores.reshape(-1)


def quantize_ref(wf, gs, bits):
    """MLX-style affine quantization in PyTorch, for tests: returns (w int32, scales bf16, biases bf16)."""
    *lead, K = wf.shape
    g = wf.float().reshape(*lead, K // gs, gs)
    lo, hi = g.amin(-1), g.amax(-1)
    n = (1 << bits) - 1
    scale = ((hi - lo) / n).clamp_min(1e-8).to(DTYPE)
    bias = lo.to(DTYPE)
    q = ((g - bias.float()[..., None]) / scale.float()[..., None]).round().clamp(0, n).to(torch.int64)
    per = 32 // bits
    q = q.reshape(*lead, K // per, per)
    shifts = torch.arange(0, 32, bits, dtype=torch.int64)
    words = (q << shifts).sum(-1)
    words = torch.where(words >= 2**31, words - 2**32, words).to(torch.int32)
    return words, scale, bias
