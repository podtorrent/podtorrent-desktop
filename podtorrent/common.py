"""Small helpers shared by the peer runtime and the CLI."""
from aiohttp import web

from .backend import (CHIP, GB, from_wire, mem_budget_gb, mem_free_gb, mem_total_gb,  # noqa: F401
                      to_wire)

TAURI_ORIGINS = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")


def _allowed_origin(origin: str) -> bool:
    if origin in TAURI_ORIGINS:
        return True
    return origin.startswith(("http://localhost:", "http://127.0.0.1:"))


LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "[::1]")


@web.middleware
async def cors(request, handler):
    """Let the desktop app's own UI (and local dev previews) read API responses, and refuse everyone else's
    browser: any open web page can send requests to 127.0.0.1, and a rebound DNS name can read the replies."""
    origin = request.headers.get("Origin", "")
    host = request.host.rsplit(":", 1)[0] if not request.host.endswith("]") else request.host
    if host not in LOOPBACK_HOSTS or (origin and not _allowed_origin(origin)):
        return web.Response(status=403, text="forbidden: requests must come from this machine's PodTorrent app")
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
