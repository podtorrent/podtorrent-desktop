"""Worker node: gRPC pipeline server (layer range loaded on demand), status page, host registration."""
import asyncio
import json
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
        self.last_compute_ms = 0.0
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
            out = self.shard.run_layers(h, cache)
            mx.eval(out)
            ms = (time.perf_counter() - t) * 1000
            self.served += 1
            self.last_compute_ms = ms
            yield pb.ForwardResponse(request_id=req.request_id, hidden=to_wire(out),
                                     shape=list(out.shape), compute_ms=ms)

    def Heartbeat(self, request, context):
        return pb.HeartbeatReply(sent_ns=request.sent_ns)

    def Info(self, request, context):
        return pb.NodeInfo(
            name=self.name, layer_lo=self.lo, layer_hi=self.hi,
            mem_active_gb=mx.get_active_memory() / GB, mem_peak_gb=mx.get_peak_memory() / GB,
            mem_total_gb=mx.device_info()["memory_size"] / GB,
            loaded=self.shard is not None, requests_served=self.served)

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
            "loaded": svc.shard is not None, "served": svc.served,
            "last_compute_ms": svc.last_compute_ms,
            "mem_active_gb": mx.get_active_memory() / GB, "mem_peak_gb": mx.get_peak_memory() / GB,
            "mem_total_gb": mx.device_info()["memory_size"] / GB}


WORKER_PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>PodTorrent worker</title>
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--bar:#e5e7eb;--acc:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#9ca3af;--bar:#2a2a2a;--acc:#60a5fa}}
body{background:var(--bg);color:var(--fg);font:15px system-ui;max-width:520px;margin:32px auto;padding:0 16px}
.bar{height:8px;background:var(--bar);border-radius:4px;overflow:hidden;margin:4px 0 12px}.bar i{display:block;height:100%;background:var(--acc)}
dt{color:var(--mut);font-size:12px}dd{margin:0 0 10px;font-variant-numeric:tabular-nums}</style>
<h2>PodTorrent worker</h2><p style="color:var(--mut)">Read-only status. Control it from the host dashboard.</p>
<dl id=d></dl><script>
const f=(b)=>(b/2**30).toFixed(2)+' GiB';
async function tick(){try{const s=await (await fetch('/status')).json();
const pct=s.total?100*s.done/s.total:(s.phase==='ready'?100:0);
d.innerHTML=`<dt>Node</dt><dd>${s.name}</dd><dt>State</dt><dd>${s.phase}${s.message?' – '+s.message:''}</dd>
<dt>Layers</dt><dd>${s.loaded?`${s.layer_lo}–${s.layer_hi-1}`:'none loaded'}</dd>
<dt>Download / load</dt><div class=bar><i style="width:${pct}%"></i></div>
<dt>Memory</dt><dd>${s.mem_active_gb.toFixed(2)} / ${s.mem_total_gb.toFixed(0)} GiB (peak ${s.mem_peak_gb.toFixed(2)})</dd>
<dt>Forward calls served</dt><dd>${s.served} (last ${s.last_compute_ms.toFixed(1)} ms)</dd>`}catch(e){}}
tick();setInterval(tick,1000)</script>"""


def run_join(host_addr: str, model_dir: str, name: str, grpc_port: int, status_port: int,
             advertise: str | None):
    svc = WorkerService(name, Path(model_dir))
    server = start_grpc(svc, grpc_port)  # keep a reference: a GC'd server stops
    host_ip = host_addr.split(":")[0]
    ip = advertise or local_ip_towards(host_ip)
    payload = {"name": name, "grpc_addr": f"{ip}:{grpc_port}", "status_url": f"http://{ip}:{status_port}"}

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

    app = web.Application()
    app.add_routes([web.get("/", page), web.get("/status", status)])
    print(f"worker status page: http://{ip}:{status_port}", flush=True)
    web.run_app(app, port=status_port, print=None)
