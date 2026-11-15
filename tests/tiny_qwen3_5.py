"""A tiny random-weight `qwen3_5_moe` checkpoint in the mlx-community layout, for tests.

Same structure as mlx-community/Qwen3.5-122B-A10B-4bit (gated DeltaNet layers with a full-attention
layer every 4th, gated attention with partial RoPE, 4-bit routed experts plus a gated shared expert,
`language_model.`-prefixed names, config under `text_config`), just small. Key heads are 128 wide like
the real model so MLX takes the same Metal kernel path. The router and shared-expert gates are 8-bit,
as current mlx_lm conversions make them, so mixed bit widths get exercised too.
"""
import json
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten, tree_map_with_path

TEXT = {
    "model_type": "qwen3_5_moe_text",
    "hidden_size": 256,
    "num_hidden_layers": 8,
    "num_attention_heads": 4,
    "num_key_value_heads": 2,
    "head_dim": 64,
    "rms_norm_eps": 1e-6,
    "vocab_size": 512,
    "max_position_embeddings": 4096,
    "full_attention_interval": 4,
    "attn_output_gate": True,
    "linear_conv_kernel_dim": 4,
    "linear_key_head_dim": 128,
    "linear_num_key_heads": 2,
    "linear_num_value_heads": 4,
    "linear_value_head_dim": 64,
    "num_experts": 8,
    "num_experts_per_tok": 2,
    "moe_intermediate_size": 128,
    "shared_expert_intermediate_size": 128,
    "mlp_only_layers": [],
    "tie_word_embeddings": False,
    "rope_parameters": {"mrope_interleaved": True, "mrope_section": [11, 11, 10], "rope_type": "default",
                        "rope_theta": 10000000, "partial_rotary_factor": 0.25},
}


def config(n_layers=8) -> dict:
    text = {**TEXT, "num_hidden_layers": n_layers,
            "layer_types": ["full_attention" if (i + 1) % 4 == 0 else "linear_attention" for i in range(n_layers)]}
    q = {"group_size": 64, "bits": 4, "mode": "affine"}
    return {"architectures": ["Qwen3_5MoeForConditionalGeneration"], "model_type": "qwen3_5_moe",
            "quantization": q, "quantization_config": q, "text_config": text, "tie_word_embeddings": False}


def build(out_dir: Path, n_layers=8, seed=0, quantize=True):
    """Write config.json + model.safetensors to out_dir; return the mlx_lm reference model.
    quantize=False keeps bfloat16 weights, for checks without MLX's quantized-matmul rounding."""
    from mlx_lm.models.qwen3_5_moe import Model, ModelArgs

    mx.random.seed(seed)
    cfg = config(n_layers)
    model = Model(ModelArgs.from_dict(cfg))

    # Default init leaves norms at 1 and dt_bias at 1; perturb everything so each weight matters.
    def init(path, p):
        if path.endswith("A_log"):
            return mx.log(mx.random.uniform(1, 16, p.shape))           # stays float32, as in the checkpoint
        if p.ndim == 1:
            return (1.0 + 0.1 * mx.random.normal(p.shape)).astype(mx.bfloat16)
        return (mx.random.normal(p.shape) * p.shape[-1] ** -0.5).astype(mx.bfloat16)
    model.update(tree_map_with_path(init, model.parameters()))
    # Embeddings big enough that the residual stream isn't all noise from the first layer.
    model.language_model.model.embed_tokens.weight = mx.random.normal(
        model.language_model.model.embed_tokens.weight.shape).astype(mx.bfloat16)

    def pred(path, m):
        if not hasattr(m, "to_quantized"):
            return False
        if path.endswith("mlp.gate") or path.endswith("shared_expert_gate"):
            return {"group_size": 64, "bits": 8}
        return {"group_size": 64, "bits": 4}
    if quantize:
        nn.quantize(model, class_predicate=pred)
    else:
        del cfg["quantization"], cfg["quantization_config"]
    model.eval()
    weights = dict(tree_flatten(model.parameters()))
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(out_dir / "model.safetensors"), weights, metadata={"format": "mlx"})
    total = sum(v.nbytes for v in weights.values())
    (out_dir / "model.safetensors.index.json").write_text(json.dumps(
        {"metadata": {"total_size": total}, "weight_map": {k: "model.safetensors" for k in weights}}))
    (out_dir / "config.json").write_text(json.dumps(cfg))
    return model
