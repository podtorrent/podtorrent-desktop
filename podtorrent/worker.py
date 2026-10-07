"""Worker node: gRPC pipeline server (layer range loaded on demand), status page, host registration."""
import asyncio
import json
import os
import queue
import socket
import threading
import time
from concurrent import futures
from pathlib import Path

import grpc
import httpx
import mlx.core as mx
import numpy as np
from aiohttp import web

from . import pipeline_pb2 as pb
from . import pipeline_pb2_grpc as rpc
from .shard import Shard
from .slicer import download_slice

GB = 2**30
GRPC_OPTS = [("grpc.max_receive_message_length", 256 * 2**20),
             ("grpc.max_send_message_length", 256 * 2**20)]


TAURI_ORIGINS = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")


def _allowed_origin(origin: str) -> bool:
    if origin in TAURI_ORIGINS:
        return True
    return origin.startswith(("http://localhost:", "http://127.0.0.1:"))


@web.middleware
async def cors(request, handler):
    """Let the desktop app's own UI (and local dev previews) read API responses. Read access only:
    the endpoints, their behavior and the ports are unchanged."""
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
    import subprocess
    try:
        return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                              text=True, timeout=2).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def to_wire(h: mx.array) -> bytes:
    return np.array(h.astype(mx.float16)).tobytes()


def from_wire(buf: bytes, shape) -> mx.array:
    return mx.array(np.frombuffer(buf, dtype=np.float16).reshape(shape)).astype(mx.bfloat16)


class WorkerService(rpc.PipelineServicer):
    def __init__(self, name: str, model_dir: Path):
        self.name, self.model_dir = name, Path(model_dir)
        self.shard: Shard | None = None
        self.lo = self.hi = 0
        self.phase, self.done, self.total, self.message = "idle", 0, 0, ""
        self.caches: dict[str, list] = {}
        self.served = 0
        self.tokens = 0
        self.busy = False
        self.last_compute_ms = 0.0
        self.last_forward_ts = 0.0
        self.started_ts = time.time()
        self._lock = threading.Lock()

    def Forward(self, request_iterator, context):
        for req in request_iterator:
            if req.release:
                self.caches.pop(req.request_id, None)
                continue
            if self.shard is None:
                context.abort(grpc.StatusCode.FAILED_PRECONDITION, "no layers loaded")
            cache = self.caches.setdefault(req.request_id, self.shard.make_cache())
            h = from_wire(req.hidden, list(req.shape))
            t = time.perf_counter()
            self.busy = True
            try:
                out = self.shard.run_layers(h, cache)
                mx.eval(out)
            finally:
                self.busy = False
            ms = (time.perf_counter() - t) * 1000
            self.served += 1
            self.tokens += int(req.shape[1]) if len(req.shape) > 1 else 1
            self.last_compute_ms = ms
            self.last_forward_ts = time.time()
            yield pb.ForwardResponse(request_id=req.request_id, hidden=to_wire(out),
                                     shape=list(out.shape), compute_ms=ms)

    def Heartbeat(self, request, context):
        return pb.HeartbeatReply(sent_ns=request.sent_ns)

    def Info(self, request, context):
        return pb.NodeInfo(
            name=self.name, layer_lo=self.lo, layer_hi=self.hi,
            mem_active_gb=mx.get_active_memory() / GB, mem_peak_gb=mx.get_peak_memory() / GB,
            mem_total_gb=mx.device_info()["memory_size"] / GB,
            loaded=self.shard is not None, requests_served=self.served,
            tokens_processed=self.tokens, active_requests=len(self.caches), busy=self.busy)

    def Load(self, request, context):
        q: queue.Queue = queue.Queue()
        lo, hi = request.layer_lo, request.layer_hi

        def emit(phase, done=0, total=0, msg=""):
            self.phase, self.done, self.total, self.message = phase, done, total, msg
            q.put(pb.LoadProgress(phase=phase, done=done, total=total, message=msg))

        def work():
            try:
                with self._lock:
                    download_slice(request.repo, self.model_dir, lo, hi, name=f"layers-{lo}-{hi}",
                                   on_progress=lambda d, t: emit("downloading", d, t))
                    emit("loading")
                    self.shard = None
                    self.caches.clear()
                    mx.clear_cache()
                    self.shard = Shard(self.model_dir, lo, hi)
                    self.lo, self.hi = lo, hi
                    emit("ready")
            except Exception as e:  # noqa: BLE001 - reported to the host
                emit("error", msg=str(e))
            q.put(None)

        threading.Thread(target=work, daemon=True).start()
        while (item := q.get()) is not None:
            yield item


def start_grpc(svc: WorkerService, port: int) -> grpc.Server:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8), options=GRPC_OPTS)
    rpc.add_PipelineServicer_to_server(svc, server)
    server.add_insecure_port(f"[::]:{port}")
    server.start()
    return server


def serve_static(model_dir, lo, hi, port=50051, name="worker"):
    """Used by tests: serve a pre-existing slice immediately."""
    svc = WorkerService(name, Path(model_dir))
    svc.shard, svc.lo, svc.hi = Shard(model_dir, lo, hi), lo, hi
    server = start_grpc(svc, port)
    print(f"worker {name} serving layers [{lo},{hi}) on :{port}", flush=True)
    server.wait_for_termination()


# ---- `podtorrent join` ----

def local_ip_towards(host: str) -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 9))
        return s.getsockname()[0]
    finally:
        s.close()


def worker_status(svc: WorkerService) -> dict:
    return {"name": svc.name, "phase": svc.phase, "done": svc.done, "total": svc.total,
            "message": svc.message, "layer_lo": svc.lo, "layer_hi": svc.hi,
            "loaded": svc.shard is not None, "served": svc.served, "tokens": svc.tokens,
            "active_requests": len(svc.caches), "busy": svc.busy,
            "last_compute_ms": svc.last_compute_ms, "last_forward_ts": svc.last_forward_ts,
            "uptime_s": time.time() - svc.started_ts, "chip": CHIP,
            "mem_active_gb": mx.get_active_memory() / GB, "mem_peak_gb": mx.get_peak_memory() / GB,
            "mem_total_gb": mx.device_info()["memory_size"] / GB}


WORKER_PAGE = (Path(__file__).parent / "static" / "worker.html").read_text()
CHIP = chip_name()


def run_join(host_addr: str, model_dir: str, name: str, grpc_port: int, status_port: int,
             advertise: str | None):
    svc = WorkerService(name, Path(model_dir))
    server = start_grpc(svc, grpc_port)  # keep a reference: a GC'd server stops
    host_ip = host_addr.split(":")[0]
    ip = advertise or local_ip_towards(host_ip)
    payload = {"name": name, "grpc_addr": f"{ip}:{grpc_port}", "status_url": f"http://{ip}:{status_port}",
               "chip": CHIP, "mem_total_gb": mx.device_info()["memory_size"] / GB}

    def register():
        while True:
            try:
                r = httpx.post(f"http://{host_addr}/api/join", json=payload, timeout=5)
                r.raise_for_status()
                print(f"joined host {host_addr} as {name} ({payload['grpc_addr']})", flush=True)
                return
            except Exception as e:  # noqa: BLE001
                print(f"waiting for host {host_addr}: {e}", flush=True)
                time.sleep(2)

    threading.Thread(target=register, daemon=True).start()

    async def status(_):
        return web.json_response(worker_status(svc))

    async def page(_):
        return web.Response(text=WORKER_PAGE, content_type="text/html")

    async def shutdown(_):
        asyncio.get_running_loop().call_later(0.3, os._exit, 0)
        return web.json_response({"ok": True})

    app = web.Application(middlewares=[cors])
    app.add_routes([web.get("/", page), web.get("/status", status), web.post("/api/shutdown", shutdown)])
    print(f"worker status page: http://{ip}:{status_port}", flush=True)
    web.run_app(app, port=status_port, print=None)
