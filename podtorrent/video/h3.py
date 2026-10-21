"""MiniMax-H3 text-to-video as a ComfyUI API graph.

Mirrors ComfyUI's "Image to Video (MiniMax H3)" blueprint (v0.41.0) with no frames attached,
which is its text-to-video mode, and the 8-step Turbo LoRA switched on. Weights come from
Comfy-Org/MiniMax-H3 (public, no token).
"""

REPO = "Comfy-Org/MiniMax-H3"
COMFY_VERSION = "v0.41.0"

# (ComfyUI models folder, file name, size in bytes) — sizes from the Hub, for progress and disk checks.
FILES = [
    # fp8, not int8_convrot: the int8 file leaves ~half the starting noise in every render on
    # RTX 50-series cards (ComfyUI issue #17098), which decodes to a blocky mosaic.
    ("diffusion_models", "minimax_h3_fl2va_pruned_fp8_scaled.safetensors", 20_958_205_608),
    ("text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", 15_690_000_000),
    ("loras", "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", 1_960_000_000),
    ("vae", "minimax_h3_video_vae_fp16.safetensors", 5_210_000_000),
    ("vae", "minimax_h3_audio_vae_fp32.safetensors", 610_000_000),
]
MODELS_BYTES = sum(f[2] for f in FILES)

# Width and height must be multiples of 32; total pixels at most 1344x768.
PRESETS = {
    "draft": {"label": "Draft", "width": 832, "height": 480},
    "hd": {"label": "HD", "width": 1344, "height": 768},
    "portrait": {"label": "Portrait", "width": 480, "height": 832},
    "square": {"label": "Square", "width": 640, "height": 640},
}
FPS = 24
# "best" is ComfyUI's default (20 steps, no LoRA); "fast" adds the 8-step Turbo LoRA.
MODES = {"best": {"label": "Best", "steps": 20, "lora": False}, "fast": {"label": "Fast", "steps": 8, "lora": True}}
# Trained range is ~124-362 frames (about 5-15 s); shorter clips fall apart.
MIN_SECONDS, MAX_SECONDS = 5.0, 15.0


def frames_for(seconds: float) -> int:
    """Frame count on the model's 17k+5 grid (same expression as the blueprint)."""
    n = max(5, round(seconds * FPS))
    return n + (5 - n % 17) % 17


def graph(prompt: str, width: int, height: int, seconds: float, seed: int, prefix: str, mode: str = "best",
          embeds: str | None = None) -> dict:
    """ComfyUI /prompt payload ("API format"). Node ids are strings; links are [node_id, output].

    With `embeds` (a .npy of the encoder's [1, T, 5120] hidden states, from the swarm's encoder
    chain), the prompt isn't encoded here: EMBEDS_NODE loads the file and ComfyUI's text encoder
    is never loaded."""
    unet, clip, lora, vae, avae = (f[1] for f in FILES)
    m = MODES[mode]
    model = ["lora", 0] if m["lora"] else ["unet", 0]
    g = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "lora": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["unet", 0], "lora_name": lora, "strength_model": 1.0}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip, "type": "minimax", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "avae": {"class_type": "VAELoader", "inputs": {"vae_name": avae}},
        "cond": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["clip", 0], "vae": ["vae", 0], "prompt": prompt,
            "width": width, "height": height, "length": frames_for(seconds)}},
        "guider": {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": ["cond", 0]}},
        "sampler": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "sched": {"class_type": "BasicScheduler", "inputs": {"model": model, "scheduler": "simple", "steps": m["steps"], "denoise": 1.0}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "sample": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["sampler", 0],
            "sigmas": ["sched", 0], "latent_image": ["cond", 1]}},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]}},
        # Raw sampler output, kept for diagnosing bad renders (a few MB per clip).
        # The sampler's output bundles video and audio (NestedTensor), which SaveLatent can't write.
        "split": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["sample", 0]}},
        "savelat": {"class_type": "SaveLatent", "inputs": {"samples": ["split", 0], "filename_prefix": "latents/" + prefix}},
        "adecode": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["sample", 0], "vae": ["avae", 0]}},
        "video": {"class_type": "CreateVideo", "inputs": {"images": ["decode", 0], "audio": ["adecode", 0], "fps": float(FPS)}},
        "save": {"class_type": "SaveVideo", "inputs": {"video": ["video", 0], "filename_prefix": prefix,
                                                     # DynamicCombo: nested choices are "<parent>.<child>" keys.
                                                     "format": "mp4", "format.codec": "auto"}},
    }
    if not m["lora"]:
        del g["lora"]
    if embeds:
        del g["clip"]
        g["cond"] = {"class_type": "PodTorrentH3Embeds", "inputs": {
            "path": embeds, "width": width, "height": height, "length": frames_for(seconds)}}
    return g


# Written into ComfyUI's custom_nodes at startup. Builds what MiniMaxH3ImageToVideo builds for a
# text-only prompt (ComfyUI v0.41.0): the hidden states with all-text token tags (1 per token),
# plus the empty AV latent.
EMBEDS_NODE = """# Written by PodTorrent at startup; see podtorrent/video/h3.py.
import numpy as np
import torch
from comfy_extras.nodes_minimax_h3 import _empty_av_latent


class PodTorrentH3Embeds:
    CATEGORY = "podtorrent"
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "load"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "path": ("STRING", {"default": ""}),
            "width": ("INT", {"default": 832, "min": 32, "max": 8192, "step": 32}),
            "height": ("INT", {"default": 480, "min": 32, "max": 8192, "step": 32}),
            "length": ("INT", {"default": 124, "min": 5, "max": 3600}),
        }}

    def load(self, path, width, height, length):
        h = torch.from_numpy(np.load(path)).float()
        if h.ndim != 3 or h.shape[0] != 1 or h.shape[2] != 5120:
            raise ValueError(f"prompt embeddings must be [1, T, 5120], got {list(h.shape)}")
        tags = torch.ones(h.shape[1], dtype=torch.long)
        latent, _ = _empty_av_latent(width, height, length)
        return ([[h, {"pooled_output": None, "minimax_token_tags": tags}]], latent)


NODE_CLASS_MAPPINGS = {"PodTorrentH3Embeds": PodTorrentH3Embeds}
"""


# Which stage the user sees while ComfyUI runs each node.
STAGE = {"unet": "loading", "lora": "loading", "clip": "encoding", "cond": "encoding", "vae": "loading", "avae": "loading",
         "sample": "generating", "split": "decoding", "savelat": "decoding", "decode": "decoding", "adecode": "decoding", "video": "saving", "save": "saving"}
