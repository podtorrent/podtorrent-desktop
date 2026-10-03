"""Host server: dashboard + WebSocket event API, node registry, loading and chat."""
import asyncio
import json
import threading
import time
import webbrowser
from pathlib import Path

import grpc
import mlx.core as mx
from aiohttp import WSMsgType, web
from mlx_lm.utils import load_tokenizer

from . import pipeline_pb2 as pb
from . import pipeline_pb2_grpc as rpc
from .host import Host
from .shard import Shard
from .slicer import download_slice
from .worker import GB, GRPC_OPTS

STATIC = Path(__file__).parent / "static"


def host_addresses():
    """IPv4 addresses a worker could dial, Tailscale (100.64/10) first."""
    import re
    import subprocess
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
    except Exception:  # noqa: BLE001
        return []
    ips = [i for i in re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", out) if not i.startswith(("127.", "169.254."))]
    ts = [i for i in ips if i.startswith("100.") and 64 <= int(i.split(".")[1]) <= 127]
    return ts + [i for i in ips if i not in ts]


class HostApp:
    def __init__(self, repo: str, model_dir: Path, n_layers: int, name: str = "host"):
        self.repo, self.model_dir, self.n_layers, self.name = repo, model_dir, n_layers, name
        self.clients: set[web.WebSocketResponse] = set()
        self.nodes: dict[str, dict] = {}
        self.state: dict[str, dict] = {}   # last event per replayable key
        self.engine: Host | None = None
        self.shard: Shard | None = None
        self.tok = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.chat_lock = threading.Lock()
        self.starting = False

    # ---- events ----
    def emit(self, type_: str, key: str | None = None, **data):
        ev = {"type": type_, "ts": time.time(), **data}
        if key:
            self.state[key] = ev
        if self.loop:
            self.loop.call_soon_threadsafe(self._broadcast, ev)

    def _broadcast(self, ev):
        msg = json.dumps(ev)
        for ws in list(self.clients):
            asyncio.ensure_future(ws.send_str(msg))

    async def ws(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        for ev in list(self.state.values()):  # replay current state
            await ws.send_str(json.dumps(ev))
        self.clients.add(ws)
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
        self.clients.discard(ws)
        return ws

    # ---- nodes ----
    def host_memory_event(self):
        self.emit("memory", key="mem:host", node=self.name,
                  active_gb=mx.get_active_memory() / GB, peak_gb=mx.get_peak_memory() / GB,
                  total_gb=mx.device_info()["memory_size"] / GB)

    async def join(self, request):
        b = await request.json()
        name = b["name"]
        ch = grpc.insecure_channel(b["grpc_addr"], options=GRPC_OPTS)
        self.nodes[name] = {"name": name, "addr": b["grpc_addr"], "status_url": b.get("status_url"),
                            "stub": rpc.PipelineStub(ch), "status": "joined", "lo": 0, "hi": 0}
        self.emit("node_joined", key=f"node:{name}", node=name, address=b["grpc_addr"],
                  status_url=b.get("status_url"), role="worker")
        return web.json_response({"ok": True})

    async def heartbeat_loop(self):
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(2)
            self.host_memory_event()
            for n in list(self.nodes.values()):
                await loop.run_in_executor(None, self._beat, n)

    def _beat(self, n):
        t = time.perf_counter()
        try:
            n["stub"].Heartbeat(pb.HeartbeatRequest(sent_ns=time.time_ns()), timeout=3)
            rtt = (time.perf_counter() - t) * 1000
            info = n["stub"].Info(pb.InfoRequest(), timeout=3)
            if n["status"] == "lost":
                n["status"] = "ready" if info.loaded else "joined"
            self.emit("node_status", key=f"status:{n['name']}", node=n["name"], status=n["status"],
                      rtt_ms=rtt, heartbeat_ts=time.time())
            self.emit("memory", key=f"mem:{n['name']}", node=n["name"], active_gb=info.mem_active_gb,
                      peak_gb=info.mem_peak_gb, total_gb=info.mem_total_gb)
        except grpc.RpcError:
            n["status"] = "lost"
            self.emit("node_status", key=f"status:{n['name']}", node=n["name"], status="lost",
                      rtt_ms=None, heartbeat_ts=time.time())

    # ---- loading ----
    async def start(self, request):
        body = await request.json() if request.can_read_body else {}
        workers = [n for n in self.nodes.values() if n["status"] != "lost"]
        if not workers:
            return web.json_response({"error": "no worker has joined yet"}, status=409)
        if self.starting:
            return web.json_response({"error": "already starting"}, status=409)
        k = int(body.get("split") or self.n_layers // 2)
        if not 1 <= k < self.n_layers:
            return web.json_response({"error": "split out of range"}, status=400)
        self.starting = True
        threading.Thread(target=self._start_all, args=(workers[0], k), daemon=True).start()
        return web.json_response({"ok": True, "split": k})

    def _start_all(self, worker, k):
        try:
            n = self.n_layers
            worker.update(lo=k, hi=n, status="loading")
            self.emit("layer_map", key="layer_map", total_layers=n, assignments=[
                {"node": self.name, "lo": 0, "hi": k, "roles": ["tokenizer", "embeddings", "lm_head"]},
                {"node": worker["name"], "lo": k, "hi": n, "roles": []}])
            errors = []
            threads = [threading.Thread(target=self._load_host, args=(k, errors)),
                       threading.Thread(target=self._load_worker, args=(worker, k, n, errors))]
            for t in threads: t.start()
            for t in threads: t.join()
            if errors:
                self.emit("error", message="; ".join(errors))
                return
            self.engine = Host(self.shard, self.tok, worker["addr"])
            worker["status"] = "ready"
            self.emit("node_status", key=f"status:{worker['name']}", node=worker["name"], status="ready",
                      rtt_ms=None, heartbeat_ts=time.time())
            self.emit("ready", key="ready")
        except Exception as e:  # noqa: BLE001
            self.emit("error", message=str(e))
        finally:
            self.starting = False

    def _load_host(self, k, errors):
        try:
            sizes = {}

            def prog(part):
                def f(d, t):
                    sizes[part] = (d, t)
                    self.emit("load_progress", node=self.name, phase="downloading",
                              done=sum(v[0] for v in sizes.values()), total=sum(v[1] for v in sizes.values()))
                return f
            download_slice(self.repo, self.model_dir, 0, k, host=True, name=f"host-0-{k}", on_progress=prog("body"))
            download_slice(self.repo, self.model_dir, 0, 0, tail=True, name="head", on_progress=prog("head"))
            self.emit("load_progress", node=self.name, phase="loading", done=0, total=0)
            self.tok = load_tokenizer(self.model_dir)
            self.shard = Shard(self.model_dir, 0, k, embed=True, head=True)
            self.emit("load_progress", node=self.name, phase="ready", done=1, total=1)
            self.host_memory_event()
        except Exception as e:  # noqa: BLE001
            errors.append(f"host: {e}")

    def _load_worker(self, worker, k, n, errors):
        try:
            for p in worker["stub"].Load(pb.LoadRequest(repo=self.repo, layer_lo=k, layer_hi=n)):
                self.emit("load_progress", node=worker["name"], phase=p.phase, done=p.done, total=p.total)
                if p.phase == "error":
                    errors.append(f"{worker['name']}: {p.message}")
        except grpc.RpcError as e:
            errors.append(f"{worker['name']}: {e.code()}")

    # ---- chat ----
    async def chat(self, request):
        b = await request.json()
        if self.engine is None:
            return web.json_response({"error": "model not started"}, status=409)
        if not self.chat_lock.acquire(blocking=False):
            return web.json_response({"error": "a generation is already running"}, status=409)
        threading.Thread(target=self._generate, args=(b["prompt"], int(b.get("max_tokens", 256))),
                         daemon=True).start()
        return web.json_response({"ok": True})

    def _generate(self, prompt, max_tokens):
        try:
            msgs = [{"role": "user", "content": prompt}]
            text = self.tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False,
                                                enable_thinking=False)
            ids = self.tok.encode(text)
            t0 = time.perf_counter()
            first = None
            count = 0
            for i, e in enumerate(self.engine.generate(ids, max_tokens)):
                if first is None:
                    first = (time.perf_counter() - t0) * 1000
                count += 1
                self.emit("token", index=i, text=e.text, token=e.token)
                self.emit("token_timing", index=i, prefill=(i == 0), bytes=e.bytes_sent,
                          stages=[{"node": self.name, "compute_ms": e.host_ms},
                                  {"node": "network", "compute_ms": e.network_ms},
                                  {"node": self.engine_worker_name(), "compute_ms": e.worker_ms}])
            total = time.perf_counter() - t0
            self.emit("done", tokens=count, ttft_ms=first, tok_s=(count - 1) / max(total - (first or 0) / 1000, 1e-6))
        except Exception as e:  # noqa: BLE001
            self.emit("error", message=f"generation failed: {e}")
        finally:
            self.chat_lock.release()

    def engine_worker_name(self):
        return next((n["name"] for n in self.nodes.values() if n["lo"] > 0), "worker")

    async def index(self, _):
        return web.FileResponse(STATIC / "index.html")


def run_host(repo, model_dir, n_layers, port, open_browser=True):
    app_state = HostApp(repo, Path(model_dir), n_layers)
    app = web.Application()
    app.add_routes([web.get("/", app_state.index), web.get("/ws", app_state.ws),
                    web.post("/api/join", app_state.join), web.post("/api/start", app_state.start),
                    web.post("/api/chat", app_state.chat)])

    async def on_start(a):
        app_state.loop = asyncio.get_running_loop()
        app_state.emit("node_joined", key="node:host", node="host", address=f"localhost:{port}", role="host")
        app_state.emit("host_info", key="host_info", addresses=host_addresses(), port=port)
        app_state.host_memory_event()
        a["hb"] = asyncio.create_task(app_state.heartbeat_loop())

    app.on_startup.append(on_start)
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    print(f"dashboard: http://localhost:{port}   workers: podtorrent join <this-ip>:{port}", flush=True)
    web.run_app(app, port=port, print=None)
