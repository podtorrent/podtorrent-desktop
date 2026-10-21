"""The parts of the H3 prompt encoder that don't need MLX: layer count, repo, config, checkpoint
keys, tokenizer and slice downloads. Windows and Linux machines import these without MLX installed;
encoder_mlx.py and encoder_torch.py build the layers themselves."""
import json
import re
from pathlib import Path

H3_LAYERS = 50  # H3 reads the output of this layer (of Qwen3-VL-32B's 64)

_LAYER = re.compile(r"(?:^|\.)layers\.(\d+)\.(.+)$")


def text_config(model_dir: str | Path) -> dict:
    cfg = json.loads((Path(model_dir) / "config.json").read_text())
    tc = dict(cfg.get("text_config", cfg))
    # Text-only M-RoPE is plain RoPE (see above); drop the M-RoPE section so mlx_lm builds that.
    tc.pop("rope_scaling", None)
    rp = tc.pop("rope_parameters", None) or {}
    tc.setdefault("rope_theta", rp.get("rope_theta", 5_000_000))
    tc.setdefault("tie_word_embeddings", cfg.get("tie_word_embeddings", False))
    if "quantization" in cfg:
        tc["quantization"] = cfg["quantization"]
    return tc


def _local_key(k: str, lo: int, hi: int, embed: bool) -> str | None:
    """Map a checkpoint key to this slice's key, or None if the slice doesn't hold it."""
    if "visual" in k or "vision_tower" in k or k.startswith("lm_head"):
        return None
    if m := _LAYER.search(k):
        i = int(m.group(1))
        return f"layers.{i - lo}.{m.group(2)}" if lo <= i < hi else None
    if embed and "embed_tokens." in k:
        return "embed_tokens." + k.split("embed_tokens.", 1)[1]
    return None


def tokenize(model_dir: str | Path, prompt: str) -> list[int]:
    """Token ids exactly as ComfyUI's MiniMaxH3Tokenizer makes them for a text-only prompt."""
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(str(model_dir))
    ids = tok.encode(prompt, add_special_tokens=False)
    return ids or [151643]  # ComfyUI sends one pad token for an empty prompt


H3_ENCODER_REPO = "mlx-community/Qwen3-VL-32B-Instruct-4bit"


def download_slice(out_dir: str | Path, lo: int, hi: int, repo: str = H3_ENCODER_REPO, on_progress=None) -> Path:
    """Fetch only layers [lo, hi) of the encoder (plus the embedding if lo == 0) by range requests,
    so no machine downloads the whole 32B. Several slices can share one out_dir."""
    from podtorrent.slicer import download_slice as fetch
    return fetch(repo, out_dir, lo, hi, host=lo == 0, on_progress=on_progress, name=f"enc-{lo}-{hi}")
