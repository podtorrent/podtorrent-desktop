"""The compute backend: MLX on Apple Silicon, PyTorch everywhere else (CUDA if there is a GPU).

Both run the same MLX 4-bit slices and hand fp16 hidden states over the wire, so peers on
either backend join the same chains (see tests/parity.py). The rest of the code uses only
this module's names, never mlx or torch directly.

PODTORRENT_BACKEND=torch forces PyTorch on a Mac (for parity tests); PODTORRENT_DEVICE picks
the torch device (default: cuda if available, else cpu).
"""
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

from . import gpu_probe

GB = 2**30
# CUDA 12.8 PyTorch (cu128) needs this NVIDIA driver or newer.
MIN_NVIDIA_DRIVER = 570
APPLE_SILICON = sys.platform == "darwin" and platform.machine() == "arm64"
NAME = os.environ.get("PODTORRENT_BACKEND") or ("mlx" if APPLE_SILICON else "torch")


def _cap(budget: float) -> float:
    """PODTORRENT_MEM_BUDGET_GB caps the model budget, e.g. to keep room for other apps."""
    cap = os.environ.get("PODTORRENT_MEM_BUDGET_GB")
    return min(budget, float(cap)) if cap else budget


def _cpu_name() -> str:
    try:
        if sys.platform == "darwin":
            return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                  text=True, timeout=2).stdout.strip()
        if sys.platform == "win32":
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except Exception:  # noqa: BLE001
        pass
    return platform.processor()


def load_tokenizer(model_dir):
    if NAME == "mlx":
        from mlx_lm.utils import load_tokenizer as load
        return load(Path(model_dir))
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(str(model_dir))


if NAME == "mlx":
    import mlx.core as mx

    from .shard import Shard

    CHIP = _cpu_name()

    def to_wire(h) -> bytes:
        return np.array(h.astype(mx.float16)).tobytes()

    def from_wire(buf: bytes, shape):
        return mx.array(np.frombuffer(buf, dtype=np.float16).reshape(shape)).astype(mx.bfloat16)

    def token_ids(seq):
        """[1, T] token ids for Shard.embed."""
        return mx.array(list(seq))[None]

    def materialize(h):
        """Finish computing h (MLX is lazy), so timings and locks cover the real work."""
        mx.eval(h)
        return h

    def argmax_last(logits) -> int:
        tok = mx.argmax(logits[0, -1])
        mx.eval(tok)
        return int(tok.item())

    def clear_cache():
        mx.clear_cache()

    def mem_total_gb() -> float:
        return mx.device_info()["memory_size"] / GB

    def mem_budget_gb() -> float:
        """What Metal will comfortably hold: macOS's recommended GPU working set (about 75% of RAM)."""
        return _cap(mx.device_info()["max_recommended_working_set_size"] / GB)

    def mem_active_gb() -> float:
        return mx.get_active_memory() / GB

    def mem_peak_gb() -> float:
        return mx.get_peak_memory() / GB

else:
    import torch

    from .shard_torch import DTYPE, TorchShard, default_device

    DEVICE = os.environ.get("PODTORRENT_DEVICE") or default_device()
    CUDA = DEVICE.startswith("cuda")
    CHIP = torch.cuda.get_device_name(torch.device(DEVICE)) if CUDA else _cpu_name()
    if CUDA and torch.version.hip and CHIP.strip() in ("", "AMD Radeon Graphics"):
        CHIP = f"{_cpu_name()} (Radeon)"  # ROCm names an APU's GPU generically; the CPU name says what machine this is
    if not CUDA and not os.environ.get("PODTORRENT_DEVICE") and shutil.which("nvidia-smi"):
        # An NVIDIA GPU that PyTorch can't use: almost always a driver too old for CUDA 12.8.
        print(f"PodTorrent: NVIDIA GPU found but CUDA is unavailable; running on the CPU. "
              f"Update the NVIDIA driver to {MIN_NVIDIA_DRIVER} or newer.", file=sys.stderr)
    # CUDA context, kernels and allocator slack aren't in memory_allocated(); keep this much spare.
    CUDA_OVERHEAD_GB = 1.5

    def Shard(model_dir, lo, hi, embed=False, head=False):  # noqa: N802 (same name as shard.Shard)
        return TorchShard(model_dir, lo, hi, embed=embed, head=head, device=DEVICE)

    def to_wire(h) -> bytes:
        return h.detach().to("cpu", torch.float16).numpy().tobytes()

    def from_wire(buf: bytes, shape):
        a = np.frombuffer(buf, dtype=np.float16).reshape(shape).copy()
        return torch.from_numpy(a).to(DEVICE, DTYPE)

    def token_ids(seq):
        return torch.tensor([list(seq)], dtype=torch.long, device=DEVICE)

    def materialize(h):
        if CUDA:
            torch.cuda.synchronize(DEVICE)
        return h

    def argmax_last(logits) -> int:
        return int(torch.argmax(logits[0, -1]).item())

    def clear_cache():
        if CUDA:
            torch.cuda.empty_cache()

    def _ram():
        import psutil
        return psutil.virtual_memory()

    def _gpu_reported_gb() -> float:
        return torch.cuda.get_device_properties(torch.device(DEVICE)).total_memory / GB

    def _try_alloc(gb: float) -> bool:
        try:
            torch.empty(int(gb * GB), dtype=torch.uint8, device=DEVICE)
            return True
        except Exception:  # noqa: BLE001 (out of memory, or the driver refusing the size)
            return False
        finally:
            torch.cuda.empty_cache()

    def _gpu_total_gb() -> float:
        """GPU memory. Integrated GPUs (AMD APUs on ROCm) share system RAM and the driver reports
        only the BIOS-reserved slice, so there we measure what the device can actually allocate."""
        reported = _gpu_reported_gb()
        if not torch.version.hip:
            return reported
        ceiling = _ram().total * gpu_probe.RAM_SHARE / GB
        if ceiling <= reported + gpu_probe.TOLERANCE_GB:
            return reported
        key = f"{CHIP}|{torch.__version__}|{round(_ram().total / GB)}|{reported:.1f}"
        return gpu_probe.probe_cached(key, lambda: gpu_probe.find_limit(_try_alloc, reported, ceiling))

    _GPU_TOTAL_GB = _gpu_total_gb() if CUDA else 0.0
    # Shared memory: the GPU's free memory is system RAM's, which the driver's own figure doesn't show.
    UNIFIED = CUDA and _GPU_TOTAL_GB > _gpu_reported_gb() + gpu_probe.TOLERANCE_GB

    def mem_total_gb() -> float:
        """Memory of the device that holds the weights: GPU memory with CUDA, else system RAM."""
        if CUDA:
            return _GPU_TOTAL_GB
        return _ram().total / GB

    def mem_budget_gb() -> float:
        """GPU: total minus CUDA overhead. CPU: like macOS's working set, about 75% of RAM."""
        if CUDA:
            return _cap(max(mem_total_gb() - CUDA_OVERHEAD_GB, 0.0))
        return _cap(_ram().total * 0.75 / GB)

    def mem_active_gb() -> float:
        if CUDA:
            return torch.cuda.memory_allocated(torch.device(DEVICE)) / GB
        import psutil
        return psutil.Process().memory_info().rss / GB

    def mem_peak_gb() -> float:
        if CUDA:
            return torch.cuda.max_memory_allocated(torch.device(DEVICE)) / GB
        return mem_active_gb()

    def system_ram_gb() -> float:
        return _ram().total / GB


def mem_free_gb() -> float:
    """Room left for more slices on this machine. With CUDA, other programs on the same GPU
    (games, Unreal) count too: never report more than the GPU actually has free."""
    free = max(mem_budget_gb() - mem_active_gb(), 0.0)
    if NAME == "torch" and CUDA:
        if UNIFIED:
            gpu_free = _ram().available
        else:
            gpu_free, _ = torch.cuda.mem_get_info(torch.device(DEVICE))
        free = min(free, max(gpu_free / GB - CUDA_OVERHEAD_GB, 0.0))
    return free
