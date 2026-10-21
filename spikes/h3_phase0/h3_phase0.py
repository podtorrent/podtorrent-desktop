"""Phase 0 feasibility spike: can this Windows/CUDA machine render MiniMax-H3?

Standalone: no PodTorrent imports. See docs/VIDEO_PLAN.md, phase 0.

    uv run --with-requirements requirements.txt h3_phase0.py --prompt "..." [options]

Writes <out>/<run-id>/{video.mp4, audio.wav, report.json}. report.json holds
the numbers the plan needs: peak VRAM / RAM, seconds per step, total time,
transformer config, encoder output shape and latent shape.

The H3 diffusers API is not documented beyond `DiffusionPipeline`, so call
kwargs are filtered against the pipeline's signature and everything we
couldn't pass or measure is listed in report["skipped"].
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import platform
import threading
import time
from pathlib import Path

import psutil
import torch

DEFAULT_REPO = "MiniMaxAI/MiniMax-H3"
# Text-to-video runs through the FL2VA checkpoint (model card).
DEFAULT_VARIANT = "FL2VA"


class RamSampler(threading.Thread):
    """Samples this process's RSS to catch the peak (offload spikes RAM)."""

    def __init__(self, interval: float = 0.25):
        super().__init__(daemon=True)
        self.proc = psutil.Process()
        self.interval = interval
        self.peak = 0
        self._halt = threading.Event()

    def run(self):
        while not self._halt.is_set():
            self.peak = max(self.peak, self.proc.memory_info().rss)
            time.sleep(self.interval)

    def stop(self) -> int:
        self._halt.set()
        self.join()
        return self.peak


def first_attr(obj, *names):
    """First attribute that exists and isn't None (tensors can't go through `or`)."""
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return None


def gb(n: float) -> float:
    return round(n / 1024**3, 2)


def shape_of(x):
    if isinstance(x, torch.Tensor):
        return list(x.shape)
    if isinstance(x, (list, tuple)) and x and isinstance(x[0], torch.Tensor):
        return [list(t.shape) for t in x]
    return None


def resolve_model_dir(repo: str, variant: str | None, token: str | None) -> str:
    """Download only the variant's subfolder (plus shared files) if asked."""
    if os.path.isdir(repo):
        return os.path.join(repo, variant) if variant else repo
    from huggingface_hub import snapshot_download

    patterns = [f"{variant}/*"] if variant else None
    local = snapshot_download(repo, allow_patterns=patterns, token=token)
    return os.path.join(local, variant) if variant else local


def load_pipeline(args, report):
    from diffusers import DiffusionPipeline

    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}[args.dtype]
    path = resolve_model_dir(args.model, args.variant, os.environ.get("HF_TOKEN"))
    report["model_path"] = path

    t0 = time.perf_counter()
    if args.offload == "none":
        pipe = DiffusionPipeline.from_pretrained(path, torch_dtype=dtype, device_map="cuda")
    else:
        pipe = DiffusionPipeline.from_pretrained(path, torch_dtype=dtype)
        if args.offload == "model":
            pipe.enable_model_cpu_offload()
        else:
            pipe.enable_sequential_cpu_offload()
    report["load_seconds"] = round(time.perf_counter() - t0, 1)
    report["pipeline_class"] = type(pipe).__name__
    report["components"] = {k: type(v).__name__ for k, v in pipe.components.items() if v is not None}

    vae = first_attr(pipe, "vae", "visual_vae")
    for fn in ("enable_tiling", "enable_slicing"):
        if args.vae_tiling and vae is not None and hasattr(vae, fn):
            getattr(vae, fn)()

    tr = getattr(pipe, "transformer", None)
    if tr is not None and hasattr(tr, "config"):
        cfg = dict(tr.config)
        report["transformer_config"] = {k: v for k, v in cfg.items() if not k.startswith("_")}
        report["transformer_params_b"] = round(sum(p.numel() for p in tr.parameters()) / 1e9, 2)
    return pipe


def measure_prompt_embeds(pipe, prompt, report):
    """Shape of what the Macs would send. Name of the method is a guess."""
    fn = getattr(pipe, "encode_prompt", None)
    if fn is None:
        report["skipped"].append("encode_prompt not found; encoder output shape unknown")
        return
    try:
        with torch.no_grad():
            out = fn(prompt) if "prompt" in inspect.signature(fn).parameters else fn(prompt=prompt)
        outs = out if isinstance(out, (tuple, list)) else [out]
        report["prompt_embeds"] = [
            {"shape": shape_of(o), "dtype": str(o.dtype), "mb": round(o.numel() * o.element_size() / 1e6, 2)}
            for o in outs
            if isinstance(o, torch.Tensor)
        ]
    except Exception as e:  # noqa: BLE001 - spike: record and move on
        report["skipped"].append(f"encode_prompt failed: {e!r}")


def build_call_kwargs(pipe, args, report, on_step):
    sig = inspect.signature(pipe.__call__).parameters
    report["call_signature"] = list(sig)
    want = {
        "prompt": args.prompt,
        "height": args.height,
        "width": args.width,
        "num_frames": args.seconds * args.fps + 1,
        "duration": args.seconds,
        "fps": args.fps,
        "num_inference_steps": args.steps,
        "generator": torch.Generator("cpu").manual_seed(args.seed),
        "callback_on_step_end": on_step,
        "callback_on_step_end_tensor_inputs": ["latents"],
    }
    kwargs = {}
    for k, v in want.items():
        if k in sig:
            kwargs[k] = v
        elif v is not None and k not in ("duration", "fps", "num_frames"):
            report["skipped"].append(f"pipeline has no '{k}' argument")
    if not any(k in kwargs for k in ("num_frames", "duration")):
        report["skipped"].append("no length argument; clip length is the pipeline default")
    return kwargs


def save_outputs(result, run_dir: Path, fps: int, report):
    from diffusers.utils import export_to_video

    frames = first_attr(result, "frames", "videos")
    if frames is not None:
        clip = frames[0] if isinstance(frames, (list, tuple)) or getattr(frames, "ndim", 0) == 5 else frames
        export_to_video(clip, str(run_dir / "video.mp4"), fps=fps)
        report["video"] = str(run_dir / "video.mp4")
    else:
        report["skipped"].append(f"no frames on output ({type(result).__name__}); fields: {list(vars(result))}")

    audio = first_attr(result, "audio", "audios")
    if audio is not None:
        import soundfile as sf

        a = audio[0] if isinstance(audio, (list, tuple)) else audio
        a = a.float().cpu().numpy() if isinstance(a, torch.Tensor) else a
        if a.ndim == 3:
            a = a[0]
        if a.ndim == 2 and a.shape[0] <= 2:  # (channels, samples) -> (samples, channels)
            a = a.T
        sf.write(run_dir / "audio.wav", a, 32000)
        report["audio"] = str(run_dir / "audio.wav")
    else:
        report["skipped"].append("no audio on output")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prompt", default="A red fox trotting through fresh snow at sunrise, soft wind, birdsong")
    ap.add_argument("--model", default=DEFAULT_REPO, help="HF repo id or local dir (community quantized repos too)")
    ap.add_argument("--variant", default=DEFAULT_VARIANT, help="subfolder with model_index.json; '' for repo root")
    ap.add_argument("--dtype", choices=["bf16", "fp16"], default="bf16")
    ap.add_argument("--offload", choices=["none", "model", "sequential"], default="model",
                    help="model = whole components to GPU on demand; sequential = layer by layer (lowest VRAM, slowest)")
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--width", type=int, default=848)
    ap.add_argument("--seconds", type=int, default=4)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--steps", type=int, default=None, help="default: pipeline's own (checkpoints are CFG-distilled)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-vae-tiling", dest="vae_tiling", action="store_false")
    ap.add_argument("--skip-embeds", action="store_true", help="don't probe encode_prompt (saves a pass)")
    ap.add_argument("--out", default="h3_runs")
    args = ap.parse_args()
    args.variant = args.variant or None

    if not torch.cuda.is_available():
        raise SystemExit("CUDA not available. Install the cu128 torch wheel (see requirements.txt).")

    run_id = time.strftime("%Y%m%d-%H%M%S") + f"-{args.height}p-{args.offload}"
    run_dir = Path(args.out) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    props = torch.cuda.get_device_properties(0)
    report = {
        "args": {k: v for k, v in vars(args).items()},
        "machine": {
            "os": platform.platform(),
            "cpu_cores": psutil.cpu_count(logical=False),
            "ram_gb": gb(psutil.virtual_memory().total),
            "gpu": props.name,
            "vram_gb": gb(props.total_memory),
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
        },
        "skipped": [],
        "status": "started",
    }
    try:
        import diffusers

        report["machine"]["diffusers"] = diffusers.__version__
    except Exception:  # noqa: BLE001
        pass

    ram = RamSampler()
    ram.start()
    step_times: list[float] = []
    last = [0.0]

    def on_step(pipe, i, t, kw):
        now = time.perf_counter()
        step_times.append(now - last[0])
        last[0] = now
        if i == 0 and "latents" in kw:
            report["latent_shape"] = shape_of(kw["latents"])
        print(f"  step {i + 1}: {step_times[-1]:.1f}s  vram peak {gb(torch.cuda.max_memory_allocated())} GB", flush=True)
        return kw

    try:
        print("Loading pipeline...", flush=True)
        pipe = load_pipeline(args, report)
        print(f"Loaded {report['pipeline_class']} in {report['load_seconds']}s", flush=True)

        if not args.skip_embeds:
            measure_prompt_embeds(pipe, args.prompt, report)

        kwargs = build_call_kwargs(pipe, args, report, on_step)
        torch.cuda.reset_peak_memory_stats()
        print(f"Generating {args.width}x{args.height}, {args.seconds}s...", flush=True)
        t0 = last[0] = time.perf_counter()
        with torch.inference_mode():
            result = pipe(**kwargs)
        report["generate_seconds"] = round(time.perf_counter() - t0, 1)

        save_outputs(result, run_dir, args.fps, report)
        report["status"] = "ok"
    except torch.cuda.OutOfMemoryError as e:
        report["status"] = "oom"
        report["error"] = str(e).splitlines()[0]
    except Exception as e:  # noqa: BLE001 - spike: always write the report
        report["status"] = "error"
        report["error"] = repr(e)
        raise
    finally:
        report["peak_vram_gb"] = gb(torch.cuda.max_memory_allocated())
        report["peak_vram_reserved_gb"] = gb(torch.cuda.max_memory_reserved())
        report["peak_ram_gb"] = gb(ram.stop())
        if step_times:
            report["steps_run"] = len(step_times)
            report["sec_per_step"] = round(sum(step_times) / len(step_times), 2)
            report["step_seconds"] = [round(s, 2) for s in step_times]
        (run_dir / "report.json").write_text(json.dumps(report, indent=2, default=str))
        print(f"\nstatus: {report['status']}  report: {run_dir / 'report.json'}")
        for k in ("generate_seconds", "sec_per_step", "peak_vram_gb", "peak_ram_gb", "latent_shape"):
            if k in report:
                print(f"  {k}: {report[k]}")
        for s in report["skipped"]:
            print(f"  skipped: {s}")


if __name__ == "__main__":
    main()
