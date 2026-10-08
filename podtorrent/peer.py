"""Peer runtime: one process per Mac, no host or worker roles.

A peer serves any number of layer slices, of any number of models, to anyone in the swarm
(Forward / Load over QUIC), and can request completions itself: it loads a model's tokenizer,
embeddings and head, plans a route through the reachable peers' slices (this Mac included), and
runs each token through every hop.

The local HTTP API (127.0.0.1 only) keeps the old host's shape so the desktop UI works unchanged:
`/ws` events, `/api/start`, `/api/chat`, `/api/shutdown`, plus `/api/serve`, `/api/unserve`,
`/api/models` and `/api/complete`. Requests without a `model` use the peer's default model."""
import asyncio
import json
import os
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Callable

import mlx.core as mx
from aiohttp import WSMsgType, web
from mlx_lm.utils import load_tokenizer

from . import pipeline_pb2 as pb
from .cli import default_dir
from .common import CHIP, GB, cors, from_wire, mem_free_gb, mem_total_gb, to_wire
from .net.identity import home, load_identity
from .net.quic import M_FORWARD, M_LOAD, PeerNet, Stream, _frame, _read_frame
from .net.rendezvous import SwarmClient
from .route import Hop, Offer, coverage, plan
from .shard import Shard
from .slicer import download_slice, estimate_slice_bytes, fetch_meta

STATIC = Path(__file__).parent / "static"
NAME = os.environ.get("PODTORRENT_NAME") or os.uname().nodename.split(".")[0]
MLX = threading.Lock()   # one MLX computation at a time in this process
CACHE_IDLE_S = 300
HOP_TIMEOUT_S = 120
MAX_REROUTES = 3
DECODE_HOP_TIMEOUT_S = 10  # one token's hop; a dead peer sends no close, so don't wait for the QUIC idle timeout
LOAD_TIMEOUT_S = 3600
SUPPORTED = {"qwen3_moe"}  # architectures Shard can run
MEM_HEADROOM_GB = 1.0      # keep this much of the GPU budget free after loading a slice
HEAD_ROLES = ["tokenizer", "embeddings", "lm_head"]


def config_path() -> Path:
    return home() / "config.json"


def read_config() -> dict:
    try:
        return json.loads(config_path().read_text())
    except (OSError, ValueError):
        return {}


def write_config(c: dict):
    config_path().parent.mkdir(parents=True, exist_ok=True)
    config_path().write_text(json.dumps(c, indent=2))


def configured_slices() -> list[dict]:
    """`serve` from config.json: a list of {model, lo, hi} (phase 3 stored a single dict)."""
    v = read_config().get("serve") or []
    return [v] if isinstance(v, dict) else list(v)


def save_slices(update: Callable[[list[dict]], list[dict]]):
    c = read_config()
    c["serve"] = update(configured_slices())
    write_config(c)


def gb(model_dir: Path, lo: int, hi: int) -> float:
    return estimate_slice_bytes(model_dir, lo, hi) / GB


# ---------------------------------------------------------------- serving


class Served:
    """One served slice: `model` layers [lo, hi) and its download / load state."""

    def __init__(self, model: str, lo: int, hi: int, n_layers: int):
        self.model, self.lo, self.hi, self.n_layers = model, lo, hi, n_layers
        self.shard: Shard | None = None
        self.phase, self.done, self.total, self.message = "checking", 0, 0, ""

    def record(self) -> dict:
        return {"model": self.model, "lo": self.lo, "hi": self.hi, "loaded": self.shard is not None,
                "n_layers": self.n_layers, "phase": self.phase}


class Slices:
    """Every slice this Mac serves to the swarm, keyed by (model, lo, hi)."""

    def __init__(self, model_dir: Callable[[str], Path]):
        self.model_dir = model_dir
        self.items: dict[tuple[str, int, int], Served] = {}
        self.caches: dict[str, tuple[list, float]] = {}   # "session:model:lo:hi" -> (KV cache, last used)
        self.served = self.tokens = 0
        self.busy = False
        self.last_compute_ms = 0.0
        self.last_forward_ts = 0.0
        self._load_lock = threading.Lock()

    def slices(self) -> list[dict]:
        return [s.record() for s in sorted(self.items.values(), key=lambda s: (s.model, s.lo, s.hi))]

    def loaded(self, model: str | None = None) -> list[Served]:
        return [s for s in list(self.items.values()) if s.shard is not None and model in (None, s.model)]

    def find(self, model: str, lo: int, hi: int) -> Served | None:
        """A loaded slice of `model` that covers [lo, hi), the narrowest first."""
        fits = [s for s in self.loaded(model) if s.lo <= lo <= hi <= s.hi]
        return min(fits, key=lambda s: s.hi - s.lo) if fits else None

    @property
    def phase(self) -> str:
        """The busiest state across slices, for the UI's single progress readout."""
        phases = [s.phase for s in self.items.values()]
        for p in ("error", "downloading", "loading", "checking", "ready"):
            if p in phases:
                return p
        return "idle"

    def pieces(self, model: str, lo: int, hi: int) -> list[tuple[Served, int, int]]:
        """Split [lo, hi) over this Mac's loaded slices of `model` (a route merges adjacent ones into
        one hop), taking the slice that reaches furthest at each step."""
        out, at, mine = [], lo, self.loaded(model)
        while at < hi:
            s = max((s for s in mine if s.lo <= at < s.hi), key=lambda s: s.hi, default=None)
            if s is None:
                raise ValueError(f"not serving {model} layers [{at},{hi})")
            out.append((s, at, min(s.hi, hi)))
            at = min(s.hi, hi)
        return out

    def run(self, session: str, model: str, lo: int, hi: int, h: mx.array) -> tuple[mx.array, float]:
        with MLX:
            t = time.perf_counter()
            self.busy = True
            try:
                for s, a, b in self.pieces(model, lo, hi):
                    key = f"{session}:{model}:{a}:{b}"
                    entry = self.caches.get(key)
                    cache = entry[0] if entry else s.shard.make_cache(a, b)
                    self.caches[key] = (cache, time.time())
                    h = s.shard.run_layers(h, cache, a, b)
                mx.eval(h)
            finally:
                self.busy = False
        ms = (time.perf_counter() - t) * 1000
        self.served += 1
        self.tokens += int(h.shape[1])
        self.last_compute_ms, self.last_forward_ts = ms, time.time()
        return h, ms

    def forward(self, req: pb.ForwardRequest) -> pb.ForwardResponse:
        model = req.model or next((s.model for s in self.loaded()), "")
        try:
            out, ms = self.run(req.session_id, model, req.layer_lo, req.layer_hi,
                               from_wire(req.hidden, list(req.shape)))
        except ValueError as e:
            return pb.ForwardResponse(session_id=req.session_id, error=str(e))
        return pb.ForwardResponse(session_id=req.session_id, hidden=to_wire(out), shape=list(out.shape),
                                  compute_ms=ms)

    def release(self, session: str):
        for k in [k for k in self.caches if k.startswith(session + ":")]:
            self.caches.pop(k, None)

    def evict_idle(self):
        now = time.time()
        for k in [k for k, (_, ts) in self.caches.items() if now - ts > CACHE_IDLE_S]:
            self.caches.pop(k, None)

    def load(self, model: str, lo: int, hi: int, progress=lambda phase, done=0, total=0, msg="": None) -> Served:
        """Download and load `model` layers [lo, hi) next to whatever is already served. Slices of the
        same model that the new one contains are dropped once it's ready. Raises MemoryError up front
        when the slice won't fit in this Mac's GPU budget."""
        with self._load_lock:
            have = self.find(model, lo, hi)
            if have is not None:
                progress("ready", 1, 1)
                return have
            d = self.model_dir(model)
            progress("checking")
            cfg = fetch_meta(model, d)
            if cfg.get("model_type") not in SUPPORTED:
                raise ValueError(f"{model} is a {cfg.get('model_type')} model; PodTorrent runs {', '.join(SUPPORTED)}")
            n = cfg["num_hidden_layers"]
            if not 0 <= lo < hi <= n:
                raise ValueError(f"layers [{lo},{hi}) out of range: {model} has {n} layers")
            replaced = [s for s in self.loaded(model) if lo <= s.lo and s.hi <= hi]
            need = gb(d, lo, hi)
            free = mem_free_gb() + sum(gb(d, s.lo, s.hi) for s in replaced)
            if need + MEM_HEADROOM_GB > free:
                raise MemoryError(f"{model.split('/')[-1]} layers [{lo},{hi}) need ~{need:.1f} GB, "
                                  f"but this Mac has {free:.1f} GB free for models")
            s = self.items[(model, lo, hi)] = Served(model, lo, hi, n)

            def emit(phase, done=0, total=0, msg=""):
                s.phase, s.done, s.total, s.message = phase, done, total, msg
                progress(phase, done, total, msg)

            try:
                download_slice(model, d, lo, hi, name=f"layers-{lo}-{hi}",
                               on_progress=lambda dn, t: emit("downloading", dn, t))
                emit("loading")
                with MLX:
                    for r in replaced:
                        r.shard = None
                        self.items.pop((r.model, r.lo, r.hi), None)
                    mx.clear_cache()
                    s.shard = Shard(d, lo, hi)
                emit("ready", 1, 1)
                return s
            except Exception:
                self.items.pop((model, lo, hi), None)
                raise

    def unserve(self, model: str, lo: int | None = None, hi: int | None = None) -> list[Served]:
        """Stop serving `model` layers [lo, hi) exactly, or every slice of `model` without a range."""
        with MLX:
            gone = [s for s in list(self.items.values())
                    if s.model == model and (lo is None or (s.lo, s.hi) == (lo, hi))]
            for s in gone:
                s.shard = None
                self.items.pop((s.model, s.lo, s.hi), None)
            # Sessions through layers nobody here serves any more get an error on their next token and re-route.
            for k in list(self.caches):
                _, m, a, b = k.rsplit(":", 3)
                if m == model and not any(s.shard is not None and s.lo <= int(a) and int(b) <= s.hi
                                          for s in self.items.values() if s.model == m):
                    self.caches.pop(k, None)
            if gone:
                mx.clear_cache()
        return gone

    def info(self) -> pb.NodeInfo:
        first = next(iter(self.loaded()), None)
        return pb.NodeInfo(
            name=NAME, layer_lo=first.lo if first else 0, layer_hi=first.hi if first else 0,
            loaded=first is not None,
            mem_active_gb=mx.get_active_memory() / GB, mem_peak_gb=mx.get_peak_memory() / GB,
            mem_total_gb=mem_total_gb(), mem_free_gb=mem_free_gb(), requests_served=self.served,
            tokens_processed=self.tokens, active_requests=len(self.caches), busy=self.busy,
            slices=[pb.Slice(model=r["model"], lo=r["lo"], hi=r["hi"], loaded=r["loaded"], n_layers=r["n_layers"])
                    for r in self.slices()])


# ---------------------------------------------------------------- the peer


class HopFailed(Exception):
    def __init__(self, hop: Hop, reason: str):
        super().__init__(reason)
        self.hop, self.reason = hop, reason


class PeerApp:
    def __init__(self, repo: str, model_dir: Path, n_layers: int | None):
        self.repo = repo   # the default model: the UI's playground and requests without a `model`
        self._dirs = {repo: Path(model_dir)}
        self._n_layers: dict[str, int] = {repo: n_layers} if n_layers else {}
        self.ident = load_identity()
        self.me = self.ident.peer_id
        self.slices = Slices(self.model_dir)
        self.net = PeerNet(self.ident, info=self.slices.info)
        self.net.handlers[M_FORWARD] = self._serve_forward
        self.net.handlers[M_LOAD] = self._serve_load
        self.swarm: SwarmClient | None = None
        self.heads: dict[str, tuple[Shard, object]] = {}   # model -> (embeddings + head, tokenizer)
        self._head_lock = threading.Lock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: dict[web.WebSocketResponse, str] = {}
        self.state: dict[str, dict] = {}
        self.active = 0
        self.active_lock = threading.Lock()
        self.starting = False
        self.stats = {"tokens": 0, "prompt_tokens": 0, "generated_tokens": 0, "requests": 0}
        self._route_key = ""
        self._known: set[str] = set()
        self.peers: list[dict] = []   # swarm records, each with this Mac's `link` to it

    def model_dir(self, model: str) -> Path:
        return self._dirs.get(model) or default_dir(model)

    def layers_of(self, model: str) -> int | None:
        """The model's layer count: from its local config, else from any peer serving it."""
        if model in self._n_layers:
            return self._n_layers[model]
        try:
            n = json.loads((self.model_dir(model) / "config.json").read_text())["num_hidden_layers"]
        except (OSError, ValueError, KeyError):
            n = next((s["n_layers"] for p in self.peers for s in self.peer_slices(p)
                      if s.get("model") == model and s.get("n_layers")), None)
            if n is None:
                return None
        self._n_layers[model] = n
        return n

    @property
    def n_layers(self) -> int:
        return self.layers_of(self.repo) or 48

    # ---- events (same shapes the old host emitted) ----
    def emit(self, type_: str, key: str | None = None, owner: str | None = None, **data):
        ev = {"type": type_, "ts": time.time(), **data}
        if key:
            self.state[key] = ev
        if self.loop:
            self.loop.call_soon_threadsafe(self._broadcast, ev, owner)

    def _broadcast(self, ev, owner=None):
        msg = json.dumps(ev)
        if owner:
            mine = json.dumps({**ev, "mine": True})
            msg = json.dumps({k: v for k, v in ev.items() if k not in ("text", "token")})
        for ws, cid in list(self.clients.items()):
            asyncio.ensure_future(ws.send_str(mine if owner and cid == owner else msg))

    async def ws(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        for ev in list(self.state.values()):
            await ws.send_str(json.dumps(ev))
        self.clients[ws] = request.query.get("key", "")
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
        self.clients.pop(ws, None)
        return ws

    def self_events(self):
        s = self.slices
        self.emit("memory", key=f"mem:{NAME}", node=NAME, active_gb=mx.get_active_memory() / GB,
                  peak_gb=mx.get_peak_memory() / GB, total_gb=mem_total_gb())
        self.emit("node_stats", key=f"stats:{NAME}", node=NAME, busy=self.active > 0 or s.busy,
                  active_requests=self.active + len(s.caches), tokens=self.stats["tokens"] + s.tokens,
                  requests=self.stats["requests"] + s.served, **{k: v for k, v in self.stats.items() if k not in ("tokens", "requests")})

    # ---- swarm ----
    def swarm_record(self) -> dict:
        return {"name": NAME, "chip": CHIP, "mem_total_gb": round(mem_total_gb(), 1),
                "mem_free_gb": round(mem_free_gb() * 2) / 2,  # half-GB steps, so idle drift doesn't republish
                "slices": [{k: v for k, v in r.items() if k != "phase"} for r in self.slices.slices()],
                "has_head": {m: True for m in self.heads}}

    def on_swarm(self, peers: list[dict], status: str):
        self.peers = peers
        self.emit("swarm", key="swarm", status=status, self_id=self.me, peers=peers)
        seen = set()
        for p in peers:
            pid, link = p["peer_id"], p.get("link") or {}
            if pid == self.me or not link:
                continue
            name = p.get("name") or pid[:8]
            info = link.get("info") or {}
            if link.get("state") == "direct":
                seen.add(pid)
                if pid not in self._known:
                    self._known.add(pid)
                    self.emit("node_joined", key=f"node:{name}", node=name, address=link.get("addr", ""),
                              role="peer", chip=p.get("chip"), mem_total_gb=p.get("mem_total_gb"))
                loaded = any(s.get("loaded") for s in self.peer_slices(p))
                self.emit("node_status", key=f"status:{name}", node=name, status="ready" if loaded else "joined",
                          rtt_ms=link.get("rtt_ms"), heartbeat_ts=time.time())
                if info:
                    self.emit("memory", key=f"mem:{name}", node=name, active_gb=info.get("mem_active_gb"),
                              peak_gb=info.get("mem_peak_gb"), total_gb=info.get("mem_total_gb"))
                    self.emit("node_stats", key=f"stats:{name}", node=name, busy=info.get("busy"),
                              active_requests=info.get("active_requests"), tokens=info.get("tokens_processed"),
                              requests=info.get("requests_served"))
        for pid in self._known - seen:
            self._known.discard(pid)
            rec = next((p for p in peers if p["peer_id"] == pid), None)
            name = (rec or {}).get("name") or pid[:8]
            self.emit("node_status", key=f"status:{name}", node=name, status="lost", rtt_ms=None,
                      heartbeat_ts=time.time())
        self.route_events()
        self.emit("models", key="models", models=self.models())

    @staticmethod
    def peer_slices(p: dict) -> list[dict]:
        info = (p.get("link") or {}).get("info") or {}
        return info.get("slices") or p.get("slices") or []

    def offers(self, model: str, reachable: bool = True) -> list[Offer]:
        """Loaded slices of `model`: this Mac's, plus direct peers' (or every online peer's)."""
        out = [Offer(self.me, NAME, s.lo, s.hi, 0.0) for s in self.slices.loaded(model)]
        for p in self.peers:
            link = p.get("link") or {}
            if p["peer_id"] == self.me or (reachable and link.get("state") != "direct"):
                continue
            for s in self.peer_slices(p):
                if s.get("loaded") and s.get("model") == model:
                    out.append(Offer(p["peer_id"], p.get("name") or p["peer_id"][:8], s["lo"], s["hi"],
                                     link.get("rtt_ms") or 50.0))
        return out

    def route(self, model: str | None = None, exclude: set[str] = frozenset()) -> tuple[list[Hop], list[tuple[int, int]]]:
        model = model or self.repo
        n = self.layers_of(model)
        if n is None:
            return [], []
        return plan(n, self.offers(model), exclude)

    def models(self) -> list[dict]:
        """Coverage of every model anyone online serves: per-layer peer counts over reachable peers
        (and over all online peers), the gaps, and the route this Mac would use."""
        names = {s.model for s in self.slices.loaded()} | {self.repo}
        names |= {s["model"] for p in self.peers for s in self.peer_slices(p) if s.get("loaded") and s.get("model")}
        out = []
        for m in sorted(names):
            n = self.layers_of(m)
            if n is None:
                continue
            hops, gaps = self.route(m)
            reach, online = coverage(n, self.offers(m)), coverage(n, self.offers(m, reachable=False))
            out.append({"model": m, "n_layers": n, "coverage": reach, "online_coverage": online,
                        "state": "available" if hops else "partial" if any(reach) else "offline",
                        "redundancy": min(reach) if reach else 0, "gaps": gaps,
                        "route": [[h.name, h.lo, h.hi] for h in hops],
                        "peers": sorted({o.name for o in self.offers(m)}), "default": m == self.repo})
        return out

    def route_events(self):
        hops, gaps = self.route()
        key = repr((hops, gaps, self.repo in self.heads))
        if key == self._route_key:
            return
        self._route_key = key
        if hops:
            assign = [{"node": h.name, "lo": h.lo, "hi": h.hi, "roles": HEAD_ROLES if h.peer_id == self.me else []}
                      for h in hops]
            if all(h.peer_id != self.me for h in hops):
                assign.insert(0, {"node": NAME, "lo": 0, "hi": 0, "roles": HEAD_ROLES})
            self.emit("layer_map", key="layer_map", total_layers=self.n_layers, assignments=assign)
            self.emit("ready", key="ready")
        else:
            self.state.pop("ready", None)
            if gaps:
                print("route: layers " + ", ".join(f"{a}–{b - 1}" for a, b in gaps) + " have no reachable peer",
                      flush=True)

    # ---- serving RPCs (QUIC) ----
    async def _serve_forward(self, conn, body, reader, writer):
        sessions = set()
        try:
            while True:
                req = pb.ForwardRequest.FromString(body)
                if req.release:
                    self.slices.release(req.session_id)
                else:
                    sessions.add(req.session_id)
                    resp = await asyncio.to_thread(self.slices.forward, req)
                    writer.write(_frame(resp.SerializeToString()))
                try:
                    body = await _read_frame(reader)
                except asyncio.IncompleteReadError:
                    break
        finally:
            for s in sessions:
                self.slices.release(s)

    async def _serve_load(self, conn, body, reader, writer):
        req = pb.LoadRequest.FromString(body)
        model = req.repo or self.repo
        q: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def progress(phase, done=0, total=0, msg=""):
            loop.call_soon_threadsafe(q.put_nowait, pb.LoadProgress(phase=phase, done=done, total=total, message=msg))

        print(f"load requested by {self.net._name(conn.peer_id)}: {model} layers [{req.layer_lo},{req.layer_hi})",
              flush=True)

        def load():
            try:
                self._load_local(model, req.layer_lo, req.layer_hi, progress)
            except Exception:  # noqa: BLE001 - _load_local already sent it as an error progress
                pass
        task = asyncio.create_task(asyncio.to_thread(load))
        while True:
            p = await q.get()
            writer.write(_frame(p.SerializeToString()))
            if p.phase in ("ready", "error"):
                break
        await asyncio.gather(task, return_exceptions=True)

    def _load_local(self, model, lo, hi, progress=lambda *a: None):
        def report(phase, done=0, total=0, msg=""):
            self.emit("load_progress", node=NAME, model=model, lo=lo, hi=hi, phase=phase, done=done, total=total,
                      message=msg)
            progress(phase, done, total, msg)

        if model == self.repo and not self.route()[0]:
            self.emit("layer_map", key="layer_map", total_layers=self.n_layers,
                      assignments=[{"node": NAME, "lo": lo, "hi": hi, "roles": []}])
        self._announce()  # the new slice shows up as "checking" / "downloading"
        try:
            s = self.slices.load(model, lo, hi, report)
        except Exception as e:
            report("error", msg=str(e))
            self._announce()
            raise
        save_slices(lambda cur: [c for c in cur if not (c.get("model") == model and lo <= c["lo"] and c["hi"] <= hi)]
                    + [{"model": model, "lo": s.lo, "hi": s.hi}])
        self._announce()

    def _unserve_local(self, model, lo=None, hi=None) -> list[Served]:
        gone = self.slices.unserve(model, lo, hi)
        if gone:
            keys = {(s.model, s.lo, s.hi) for s in gone}
            save_slices(lambda cur: [c for c in cur if (c.get("model"), c["lo"], c["hi"]) not in keys])
            print("stopped serving " + ", ".join(f"{s.model} [{s.lo},{s.hi})" for s in gone), flush=True)
        self._announce()
        return gone

    def _announce(self):
        """Tell the UI and the swarm that this Mac's slices changed."""
        self.self_events()
        self._route_key = ""
        self.route_events()
        self.emit("models", key="models", models=self.models())
        self.emit("slices", key="slices", slices=self.slices.slices(), mem_free_gb=mem_free_gb())
        if self.swarm and self.loop:
            asyncio.run_coroutine_threadsafe(self.swarm.publish(), self.loop)

    # ---- requesting ----
    def ensure_head(self, model: str | None = None) -> tuple[Shard, object]:
        """This Mac's tokenizer, embeddings and head for `model`, downloaded and loaded on first use."""
        model = model or self.repo
        with self._head_lock:
            if model in self.heads:
                return self.heads[model]
            d = self.model_dir(model)
            sizes = {}

            def prog(part):
                def f(d, t):
                    sizes[part] = (d, t)
                    self.emit("load_progress", node=NAME, phase="downloading",
                              done=sum(v[0] for v in sizes.values()), total=sum(v[1] for v in sizes.values()))
                return f
            download_slice(model, d, 0, 0, host=True, name="embed", on_progress=prog("embed"))
            download_slice(model, d, 0, 0, tail=True, name="head", on_progress=prog("head"))
            tok = load_tokenizer(d)
            with MLX:
                self.heads[model] = (Shard(d, 0, 0, embed=True, head=True), tok)
            if self.slices.phase in ("idle", "ready"):
                self.emit("load_progress", node=NAME, phase="ready", done=1, total=1)
            return self.heads[model]

    def _call(self, coro, timeout=HOP_TIMEOUT_S):
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        try:
            return fut.result(timeout)
        except BaseException:
            fut.cancel()
            raise

    async def _hop(self, streams: dict[int, Stream], k: int, hop: Hop, req: pb.ForwardRequest) -> pb.ForwardResponse:
        body = req.SerializeToString()
        if k not in streams:
            streams[k] = await self.net.conn_to(hop.peer_id).open(M_FORWARD, body)
        else:
            streams[k].send(body)
        return pb.ForwardResponse.FromString(await streams[k].recv())

    async def _close_streams(self, streams: dict[int, Stream], session: str):
        for s in streams.values():
            try:
                s.send(pb.ForwardRequest(session_id=session, release=True).SerializeToString())
            except Exception:  # noqa: BLE001
                pass
            s.close()

    def generate(self, ids: list[int], max_tokens: int, model: str | None = None):
        """Yields (token, text, timing) per generated token. Raises if the model isn't covered.
        If a remote hop fails, re-plans without that peer and replays prompt + output so far to
        rebuild the KV cache on the new route; tokens already yielded are kept."""
        model = model or self.repo
        failed: set[str] = set()
        hops, gaps = self.route(model)
        if not hops:
            raise RuntimeError(f"{model} not covered: " + (", ".join(f"layers {a}–{b - 1}" for a, b in gaps)
                                                             or "nobody online serves it") + " (no reachable peer)")
        embed_head, tok_ = self.ensure_head(model)
        session = uuid.uuid4().hex
        streams: dict[int, Stream] = {}
        seq = list(ids)
        x = mx.array(seq)[None]
        eos = set(getattr(tok_, "eos_token_ids", None) or {tok_.eos_token_id})
        produced, reroutes = 0, 0
        try:
            while produced < max_tokens:
                t0 = time.perf_counter()
                with MLX:
                    h = embed_head.embed(x)
                    mx.eval(h)
                pre = (time.perf_counter() - t0) * 1000
                stages, nbytes = [], 0
                try:
                    for k, hop in enumerate(hops):
                        if hop.peer_id == self.me:
                            try:
                                h, ms = self.slices.run(session, model, hop.lo, hop.hi, h)
                            except ValueError as e:  # unserved here mid-answer
                                raise HopFailed(hop, str(e)) from e
                            stages += [{"node": "network", "compute_ms": 0.0}, {"node": NAME, "compute_ms": ms}]
                            continue
                        payload = to_wire(h)
                        req = pb.ForwardRequest(session_id=session, hidden=payload, shape=list(h.shape),
                                                model=model, layer_lo=hop.lo, layer_hi=hop.hi)
                        t = time.perf_counter()
                        try:
                            resp = self._call(self._hop(streams, k, hop, req),
                                              HOP_TIMEOUT_S if h.shape[1] > 1 else DECODE_HOP_TIMEOUT_S)
                        except Exception as e:  # noqa: BLE001
                            raise HopFailed(hop, str(e) or type(e).__name__) from e
                        if resp.error:
                            raise HopFailed(hop, resp.error)
                        rtt = (time.perf_counter() - t) * 1000
                        h = from_wire(resp.hidden, list(resp.shape))
                        nbytes = max(nbytes, len(payload))
                        stages += [{"node": "network", "compute_ms": max(rtt - resp.compute_ms, 0.0)},
                                   {"node": hop.name, "compute_ms": resp.compute_ms}]
                except HopFailed as f:
                    failed.add(f.hop.peer_id)
                    reroutes += 1
                    new_hops, gaps = self.route(model, failed)
                    if not new_hops or reroutes > MAX_REROUTES:
                        raise RuntimeError(f"{f.hop.name} failed ({f.reason}) and no other route covers "
                                           + (", ".join(f"layers {a}–{b - 1}" for a, b in gaps) or "the model"))
                    print(f"route: {f.hop.name} failed ({f.reason}); re-routing via "
                          + " → ".join(f"{h_.name}[{h_.lo},{h_.hi})" for h_ in new_hops)
                          + f", replaying {len(seq)} tokens", flush=True)
                    self.emit("reroute", failed=f.hop.name, reason=f.reason,
                              route=[[h_.name, h_.lo, h_.hi] for h_ in new_hops], replay_tokens=len(seq))
                    self.slices.release(session)
                    old, streams = streams, {}
                    try:
                        self._call(self._close_streams(old, session), 5)
                    except Exception:  # noqa: BLE001
                        pass
                    hops, session = new_hops, uuid.uuid4().hex
                    x = mx.array(seq)[None]
                    continue
                t2 = time.perf_counter()
                with MLX:
                    tok = mx.argmax(embed_head.logits(h[:, -1:, :])[0, -1])
                    mx.eval(tok)
                post = (time.perf_counter() - t2) * 1000
                tok = int(tok.item())
                head = {"node": NAME, "compute_ms": pre + post, "pre_ms": pre, "post_ms": post}
                yield tok, tok_.decode([tok]), {"stages": [head, *stages], "bytes": nbytes,
                                                    "route": [[h_.name, h_.lo, h_.hi] for h_ in hops]}
                produced += 1
                if tok in eos:
                    break
                seq.append(tok)
                x = mx.array([[tok]])
        finally:
            self.slices.release(session)
            if streams:
                try:
                    self._call(self._close_streams(streams, session), 5)
                except Exception:  # noqa: BLE001
                    pass

    # ---- HTTP API ----
    async def start(self, request):
        """The UI's "Load model": serve [0, split) here, and ask a direct peer to serve the rest
        when nobody reachable covers it yet."""
        body = await request.json() if request.can_read_body else {}
        if self.starting:
            return web.json_response({"error": "already starting"}, status=409)
        n = self.n_layers
        k = int(body.get("split") or n // 2)
        if not 1 <= k < n:
            return web.json_response({"error": "split out of range"}, status=400)
        self.starting = True
        threading.Thread(target=self._start_all, args=(k,), daemon=True).start()
        return web.json_response({"ok": True, "split": k})

    def _start_all(self, k: int):
        try:
            n, errors, model = self.n_layers, [], self.repo
            mine = [(s.lo, s.hi) for s in self.slices.loaded(model)] or [(0, k)]
            threads = [threading.Thread(target=self._try, args=(errors, "this Mac", self._load_local, model, *r))
                       for r in mine if not self.slices.find(model, *r)]
            threads.append(threading.Thread(target=self._try, args=(errors, "this Mac", self.ensure_head, model)))
            # Layers nobody reachable serves (besides what this Mac is about to load): ask a peer.
            others = [o for o in self.offers(model) if o.peer_id != self.me] + [Offer(self.me, NAME, *r) for r in mine]
            _, gaps = plan(n, others)
            for lo, hi in gaps:
                pid = self.pick_helper({self.me}, self.slice_gb(model, lo, hi))
                if not pid:
                    errors.append(f"layers {lo}–{hi - 1} have no peer, and no other connected Mac has room to serve them")
                    continue
                threads.append(threading.Thread(target=self._try, args=(errors, self.net._name(pid),
                                                                         self.remote_load, pid, model, lo, hi)))
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if errors:
                self.emit("error", message="; ".join(errors))
                return
            for _ in range(20):  # the helper's Info refresh announces its new slice
                if self.route()[0]:
                    break
                time.sleep(0.5)
            self._route_key = ""
            self.route_events()
            if not self.route()[0]:
                self.emit("error", message="loaded, but the route still has gaps; is every peer reachable?")
        finally:
            self.starting = False

    @staticmethod
    def _try(errors, who, fn, *args):
        try:
            fn(*args)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{who}: {e}")

    def slice_gb(self, model: str, lo: int, hi: int) -> float:
        try:
            return gb(self.model_dir(model), lo, hi)
        except (OSError, ValueError, KeyError):
            return 0.0  # metadata not here; the helper checks for itself

    def pick_helper(self, exclude: set[str], need_gb: float = 0.0) -> str | None:
        """A direct peer with room for `need_gb`, preferring one serving nothing, then the lowest RTT."""
        cands = []
        for p in self.peers:
            link = p.get("link") or {}
            if p["peer_id"] in exclude or link.get("state") != "direct":
                continue
            free = (link.get("info") or {}).get("mem_free_gb", p.get("mem_free_gb"))
            if free is not None and free < need_gb + MEM_HEADROOM_GB:
                continue
            cands.append((bool(self.peer_slices(p)), link.get("rtt_ms") or 1e9, p["peer_id"]))
        return min(cands)[2] if cands else None

    def remote_load(self, pid: str, model: str, lo: int, hi: int):
        name = self.net._name(pid)

        async def go():
            s = await self.net.conn_to(pid).open(M_LOAD, pb.LoadRequest(repo=model, layer_lo=lo, layer_hi=hi)
                                                 .SerializeToString())
            s.close()
            while True:
                p = pb.LoadProgress.FromString(await asyncio.wait_for(s.recv(), LOAD_TIMEOUT_S))
                self.emit("load_progress", node=name, model=model, lo=lo, hi=hi, phase=p.phase, done=p.done,
                          total=p.total, message=p.message)
                if p.phase == "error":
                    raise RuntimeError(p.message)
                if p.phase == "ready":
                    break
            link = self.net.links.get(pid)
            if link:
                await self.net._refresh_info(link)

        if model == self.repo:
            self.emit("layer_map", key="layer_map", total_layers=self.n_layers,
                      assignments=[{"node": NAME, "lo": 0, "hi": 0, "roles": HEAD_ROLES},
                                   {"node": name, "lo": lo, "hi": hi, "roles": []}])
        self._call(go(), LOAD_TIMEOUT_S)

    def _slice_args(self, b: dict) -> tuple[str, int, int] | str:
        model = str(b.get("model") or self.repo)
        try:
            lo, hi = int(b["lo"]), int(b["hi"])
        except (KeyError, TypeError, ValueError):
            return "expected integer lo and hi"
        n = self.layers_of(model)
        if not 0 <= lo < hi or (n is not None and hi > n):
            return f"range [{lo},{hi}) out of bounds" + (f" for {n} layers" if n else "")
        return model, lo, hi

    async def serve(self, request):
        """Serve {model?, lo, hi} next to what's already served. With `peer` (a name or peer_id),
        ask that direct peer to serve it instead. Progress arrives as `load_progress` events."""
        b = await request.json()
        args = self._slice_args(b)
        if isinstance(args, str):
            return web.json_response({"error": args}, status=400)
        model, lo, hi = args
        if b.get("peer"):
            pid = next((p["peer_id"] for p in self.peers if b["peer"] in (p["peer_id"], p.get("name"))), None)
            if not pid or (self.net.links.get(pid) is None or self.net.links[pid].state != "direct"):
                return web.json_response({"error": f"no direct peer {b['peer']}"}, status=404)
            fn, who, fargs = self.remote_load, self.net._name(pid), (pid, model, lo, hi)
        else:
            fn, who, fargs = self._load_local, "serve", (model, lo, hi)
        errors: list[str] = []

        def go():
            self._try(errors, who, fn, *fargs)
            if errors:
                self.emit("error", message=errors[0])
        if b.get("wait"):
            await asyncio.to_thread(go)
            return web.json_response({"error": errors[0]} if errors else {"ok": True, "slices": self.slices.slices()},
                                     status=409 if errors else 200)
        threading.Thread(target=go, daemon=True).start()
        return web.json_response({"ok": True})

    async def unserve(self, request):
        """Stop serving {model?, lo, hi}, or every slice of `model` when no range is given."""
        b = await request.json()
        model = str(b.get("model") or self.repo)
        lo, hi = (int(b["lo"]), int(b["hi"])) if "lo" in b and "hi" in b else (None, None)
        gone = await asyncio.to_thread(self._unserve_local, model, lo, hi)
        if not gone:
            return web.json_response({"error": "not serving that"}, status=404)
        return web.json_response({"ok": True, "removed": [[s.model, s.lo, s.hi] for s in gone],
                                  "slices": self.slices.slices()})

    async def models_api(self, _):
        return web.json_response({"models": self.models(), "mem_free_gb": round(mem_free_gb(), 1),
                                  "slices": self.slices.slices()})

    async def chat(self, request):
        b = await request.json()
        who = str(b.get("key") or "")[:64]
        if not who:
            return web.json_response({"error": "missing chat key"}, status=400)
        model = str(b.get("model") or self.repo)
        if not self.route(model)[0]:
            return web.json_response({"error": f"{model} not covered yet"}, status=409)
        with self.active_lock:
            self.active += 1
        self.emit("chat_session", key="chat_session", busy=True, started=time.time())
        threading.Thread(target=self._chat, args=(b["prompt"], int(b.get("max_tokens", 256)), who, model),
                         daemon=True).start()
        return web.json_response({"ok": True})

    def _chat(self, prompt, max_tokens, who, model):
        try:
            _, tok_ = self.ensure_head(model)
            text = tok_.apply_chat_template([{"role": "user", "content": prompt}], add_generation_prompt=True,
                                            tokenize=False, enable_thinking=False)
            ids = tok_.encode(text)
            self.stats["requests"] += 1
            self.stats["prompt_tokens"] += len(ids)
            self.stats["tokens"] += len(ids)
            t0, first, count = time.perf_counter(), None, 0
            for i, (tok, piece, timing) in enumerate(self.generate(ids, max_tokens, model)):
                if first is None:
                    first = (time.perf_counter() - t0) * 1000
                count += 1
                self.stats["generated_tokens"] += 1
                if count > 1:
                    self.stats["tokens"] += 1
                if count % 8 == 0:
                    self.self_events()
                self.emit("token", owner=who, index=i, text=piece, token=tok)
                self.emit("token_timing", owner=who, index=i, prefill=(i == 0), model=model, **timing)
            total = time.perf_counter() - t0
            self.emit("done", owner=who, tokens=count, ttft_ms=first,
                      tok_s=(count - 1) / max(total - (first or 0) / 1000, 1e-6), total_ms=total * 1000,
                      prompt_tokens=len(ids), model=model)
        except Exception as e:  # noqa: BLE001
            self.emit("error", owner=who, message=f"generation failed: {e}")
        finally:
            with self.active_lock:
                self.active -= 1
            self.self_events()
            self.emit("chat_session", key="chat_session", busy=self.active > 0,
                      started=time.time() if self.active else None)

    async def complete(self, request):
        """Blocking completion for scripts and tests: {"ids": [...]} or {"prompt": "..."}, greedy.
        Optional `model` (default: this peer's default model)."""
        b = await request.json()
        model = str(b.get("model") or self.repo)

        def run():
            _, tok_ = self.ensure_head(model)
            ids = b.get("ids") or tok_.encode(b["prompt"])
            out = list(self.generate(ids, int(b.get("max_tokens", 32)), model))
            return {"model": model, "tokens": [t for t, _, _ in out], "text": "".join(p for _, p, _ in out),
                    "timings": [tm for _, _, tm in out]}
        try:
            return web.json_response(await asyncio.to_thread(run))
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": str(e)}, status=409)

    async def status(self, _):
        hops, gaps = self.route()
        s = self.slices
        busy = next((x for x in s.items.values() if x.phase == s.phase), None)
        return web.json_response({
            "name": NAME, "peer_id": self.me, "repo": self.repo, "n_layers": self.n_layers,
            "slices": s.slices(), "phase": s.phase, "done": busy.done if busy else 0,
            "total": busy.total if busy else 0, "message": busy.message if busy else "",
            "mem_free_gb": round(mem_free_gb(), 1), "heads": sorted(self.heads),
            "head_loaded": self.repo in self.heads, "route": [[h.name, h.lo, h.hi] for h in hops], "gaps": gaps,
            "links": {self.net._name(k): {kk: v[kk] for kk in ("state", "rtt_ms", "via", "addr", "error")}
                      for k, v in self.net.snapshot().items()},
            "served": s.served, "tokens": s.tokens, "active_requests": len(s.caches)})

    async def shutdown(self, _):
        asyncio.get_running_loop().call_later(0.3, os._exit, 0)
        return web.json_response({"ok": True})

    async def index(self, _):
        return web.FileResponse(STATIC / "index.html")

    async def housekeeping(self):
        while True:
            await asyncio.sleep(2)
            self.slices.evict_idle()
            self.self_events()


def run_peer(repo: str, model_dir, n_layers: int | None, port: int, serve: list[tuple[str | None, int, int]] | None,
             open_browser: bool = False):
    """`serve`: slices to load at start as (model or None for `repo`, lo, hi); default: the saved config."""
    app_state = PeerApp(repo, Path(model_dir), n_layers)
    if serve:
        serve = [(m or repo, lo, hi) for m, lo, hi in serve]
    else:
        serve = [(c.get("model") or repo, int(c["lo"]), int(c["hi"])) for c in configured_slices()]
    app = web.Application(middlewares=[cors], client_max_size=16 << 20)
    app.add_routes([web.get("/", app_state.index), web.get("/ws", app_state.ws), web.get("/status", app_state.status),
                    web.get("/api/models", app_state.models_api),
                    web.post("/api/start", app_state.start), web.post("/api/serve", app_state.serve),
                    web.post("/api/unserve", app_state.unserve),
                    web.post("/api/chat", app_state.chat), web.post("/api/complete", app_state.complete),
                    web.post("/api/shutdown", app_state.shutdown)])

    def load_all():  # one at a time: each slice's memory check sees the ones before it
        for m, lo, hi in serve:
            app_state._try([], "serve", app_state._load_local, m, lo, hi)

    async def on_start(a):
        app_state.loop = asyncio.get_running_loop()
        await app_state.net.start()
        app_state.swarm = SwarmClient(app_state.ident, app_state.swarm_record, app_state.on_swarm, net=app_state.net)
        app_state.emit("node_joined", key=f"node:{NAME}", node=NAME, address=f"udp/{app_state.net.port}", role="host")
        app_state.emit("host_info", key="host_info", addresses=[], port=port, repo=repo,
                       n_layers=app_state.n_layers, chip=CHIP, name=NAME, peer_id=app_state.me)
        app_state.self_events()
        app_state.emit("chat_session", key="chat_session", busy=False, started=None)
        a["swarm"] = asyncio.create_task(app_state.swarm.run())
        a["hk"] = asyncio.create_task(app_state.housekeeping())
        if serve:
            threading.Thread(target=load_all, daemon=True).start()

    app.on_startup.append(on_start)
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    print(f"peer {NAME} ({app_state.me[:8]}): local API on http://127.0.0.1:{port}", flush=True)
    web.run_app(app, host="127.0.0.1", port=port, print=None)
