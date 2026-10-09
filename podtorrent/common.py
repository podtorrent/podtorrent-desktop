"""Small helpers shared by the peer runtime and the CLI."""
import os
import subprocess

import mlx.core as mx
import numpy as np
from aiohttp import web

GB = 2**30
TAURI_ORIGINS = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")


def _allowed_origin(origin: str) -> bool:
    if origin in TAURI_ORIGINS:
        return True
    return origin.startswith(("http://localhost:", "http://127.0.0.1:"))


@web.middleware
async def cors(request, handler):
    """Let the desktop app's own UI (and local dev previews) read API responses."""
    origin = request.headers.get("Origin", "")
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    if _allowed_origin(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Vary"] = "Origin"
    return resp


def chip_name() -> str:
    """e.g. "Apple M2 Pro"; empty if unknown."""
    try:
        return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                              text=True, timeout=2).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


CHIP = chip_name()


def to_wire(h: mx.array) -> bytes:
    return np.array(h.astype(mx.float16)).tobytes()


def from_wire(buf: bytes, shape) -> mx.array:
    return mx.array(np.frombuffer(buf, dtype=np.float16).reshape(shape)).astype(mx.bfloat16)


def mem_total_gb() -> float:
    return mx.device_info()["memory_size"] / GB


def mem_budget_gb() -> float:
    """What Metal will comfortably hold: macOS's recommended GPU working set (about 75% of RAM).
    PODTORRENT_MEM_BUDGET_GB caps it, e.g. to keep room for other apps."""
    budget = mx.device_info()["max_recommended_working_set_size"] / GB
    cap = os.environ.get("PODTORRENT_MEM_BUDGET_GB")
    return min(budget, float(cap)) if cap else budget


def mem_free_gb() -> float:
    """Room left for more slices on this Mac."""
    return max(mem_budget_gb() - mx.get_active_memory() / GB, 0.0)
