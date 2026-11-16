"""Random-weight 4-bit checkpoints in the mlx-community layouts, written with PyTorch only (no MLX), for
GPU tests and scripts/bench_torch.py on machines without the real model.

Codes are uniform random 4-bit values; scales give each weight a standard deviation of about 1/sqrt(in)
and offsets centre it, like a trained layer's. Timing and kernel-vs-reference checks don't need real weights.
"""
import json
import math
from pathlib import Path

import torch

DTYPE = torch.bfloat16

QWEN3_5_122B = {   # text_config of mlx-community/Qwen3.5-122B-A10B-4bit (layer shapes only)
    "model_type": "qwen3_5_moe_text", "hidden_size": 3072, "num_attention_heads": 32, "num_key_value_heads": 2,
    "head_dim": 256, "rms_norm_eps": 1e-6, "vocab_size": 248320, "full_attention_interval": 4,
    "attn_output_gate": True, "linear_conv_kernel_dim": 4, "linear_key_head_dim": 128, "linear_num_key_heads": 16,
    "linear_num_value_heads": 64, "linear_value_head_dim": 128, "num_experts": 256, "num_experts_per_tok": 8,
    "moe_intermediate_size": 1024, "shared_expert_intermediate_size": 1024, "norm_topk_prob": True,
    "rope_parameters": {"rope_theta": 10000000, "partial_rotary_factor": 0.25, "rope_type": "default"},
}

QWEN3_5_SMALL = {**QWEN3_5_122B, "hidden_size": 256, "num_attention_heads": 4, "head_dim": 64,
                 "linear_num_key_heads": 2, "linear_num_value_heads": 4, "linear_value_head_dim": 64,
                 "num_experts": 16, "num_experts_per_tok": 4, "moe_intermediate_size": 128,
                 "shared_expert_intermediate_size": 128, "vocab_size": 512}

QWEN3_MOE_SMALL = {   # mlx-community/Qwen3-30B-A3B-4bit's structure, small
    "model_type": "qwen3_moe", "hidden_size": 256, "num_attention_heads": 8, "num_key_value_heads": 2,
    "head_dim": 64, "rms_norm_eps": 1e-6, "vocab_size": 512, "rope_theta": 1000000.0, "num_experts": 16,
    "num_experts_per_tok": 4, "moe_intermediate_size": 128, "norm_topk_prob": True, "tie_word_embeddings": False,
}


def make(out: Path, n_layers: int, text: dict, gs=64, seed=0, head=False):
    """Write config.json + one safetensors file per layer (+ head.safetensors) to out."""
    from safetensors.torch import save_file
    out.mkdir(parents=True, exist_ok=True)
    q = {"group_size": gs, "bits": 4}
    text = {**text, "num_hidden_layers": n_layers}
    qwen35 = text["model_type"] == "qwen3_5_moe_text"
    cfg = {"model_type": "qwen3_5_moe", "text_config": text} if qwen35 else dict(text)
    (out / "config.json").write_text(json.dumps({**cfg, "quantization": q, "quantization_config": q}))
    pre0 = "language_model." if qwen35 else ""
    g = torch.Generator().manual_seed(seed)
    H, E, I = text["hidden_size"], text["num_experts"], text["moe_intermediate_size"]
    nh, nkv, hd = text["num_attention_heads"], text["num_key_value_heads"], text["head_dim"]

    def quant(t, name, *shape):
        *lead, n, k = shape
        t[f"{name}.weight"] = torch.randint(-2**31, 2**31 - 1, (*lead, n, k // 8), generator=g, dtype=torch.int32)
        s = (0.5 + torch.rand(*lead, n, k // gs, generator=g)) / (4.6 * math.sqrt(k))
        t[f"{name}.scales"] = s.to(DTYPE)
        t[f"{name}.biases"] = (-7.5 * s).to(DTYPE)

    def norm(n):
        return (1 + 0.1 * torch.randn(n, generator=g)).to(DTYPE)

    for i in range(n_layers):
        t, pre = {}, f"{pre0}model.layers.{i}."
        t[pre + "input_layernorm.weight"] = norm(H)
        t[pre + "post_attention_layernorm.weight"] = norm(H)
        if qwen35 and (i + 1) % text["full_attention_interval"]:
            nk, nv, dk, dv = (text[k] for k in ("linear_num_key_heads", "linear_num_value_heads",
                                                "linear_key_head_dim", "linear_value_head_dim"))
            a, c = pre + "linear_attn.", 2 * nk * dk + nv * dv
            quant(t, a + "in_proj_qkv", c, H)
            quant(t, a + "in_proj_z", nv * dv, H)
            quant(t, a + "in_proj_b", nv, H)
            quant(t, a + "in_proj_a", nv, H)
            quant(t, a + "out_proj", H, nv * dv)
            t[a + "conv1d.weight"] = (0.3 * torch.randn(c, text["linear_conv_kernel_dim"], 1, generator=g)).to(DTYPE)
            t[a + "A_log"] = torch.log(1 + 15 * torch.rand(nv, generator=g))
            t[a + "dt_bias"] = torch.randn(nv, generator=g).to(DTYPE)
            t[a + "norm.weight"] = norm(dv)
        else:
            a = pre + "self_attn."
            quant(t, a + "q_proj", (2 if qwen35 else 1) * nh * hd, H)
            quant(t, a + "k_proj", nkv * hd, H)
            quant(t, a + "v_proj", nkv * hd, H)
            quant(t, a + "o_proj", H, nh * hd)
            t[a + "q_norm.weight"] = norm(hd)
            t[a + "k_norm.weight"] = norm(hd)
        m = pre + "mlp."
        quant(t, m + "gate", E, H)
        quant(t, m + "switch_mlp.gate_proj", E, I, H)
        quant(t, m + "switch_mlp.up_proj", E, I, H)
        quant(t, m + "switch_mlp.down_proj", E, H, I)
        if qwen35:
            si = text["shared_expert_intermediate_size"]
            quant(t, m + "shared_expert.gate_proj", si, H)
            quant(t, m + "shared_expert.up_proj", si, H)
            quant(t, m + "shared_expert.down_proj", H, si)
            quant(t, m + "shared_expert_gate", 1, H)
        save_file(t, str(out / f"layer-{i}.safetensors"))
    if head:
        t = {f"{pre0}model.norm.weight": norm(H)}
        quant(t, f"{pre0}lm_head", text["vocab_size"], H)
        save_file(t, str(out / "head.safetensors"))
    return out
