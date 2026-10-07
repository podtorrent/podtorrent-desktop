"""Peer runtime: one process per Mac, no host or worker roles.

A peer serves zero or one layer slice of the model to anyone in the swarm (Forward / Load over QUIC),
and can request completions itself: it loads the tokenizer, embeddings and head, plans a route
through the reachable peers' slices (this Mac included), and runs each token through every hop.

The local HTTP API (127.0.0.1 only) keeps the old host's shape so the desktop UI works unchanged:
`/ws` events, `/api/start`, `/api/chat`, `/api/shutdown`, plus `/api/serve` and `/api/complete`."""
import asyncio
import json
import os
import threading
import time
import uuid
import webbrowser
from pathlib import Path

import mlx.core as mx
from aiohttp import WSMsgType, web
from mlx_lm.utils import load_tokenizer

from . import pipeline_pb2 as pb
from .common import CHIP, GB, cors, from_wire, mem_total_gb, to_wire
from .net.identity import home, load_identity
from .net.quic import M_FORWARD, M_LOAD, PeerNet, Stream, _frame, _read_frame
from .net.rendezvous import SwarmClient
from .route import Hop, Offer, plan
from .shard import Shard
from .slicer import download_slice

STATIC = Path(__file__).parent / "static"
NAME = os.environ.get("PODTORRENT_NAME") or os.uname().nodename.split(".")[0]
MLX = threading.Lock()   # one MLX computation at a time in this process
CACHE_IDLE_S = 300
HOP_TIMEOUT_S = 120
MAX_REROUTES = 3
DECODE_HOP_TIMEOUT_S = 10  # one token's hop; a dead peer sends no close, so don't wait for the QUIC idle timeout
LOAD_TIMEOUT_S = 3600


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


# ---------------------------------------------------------------- serving


class Slices:
    """The layer slice this Mac serves to the swarm (one per peer in phase 3)."""

    def __init__(self, repo: str, model_dir: Path):
        self.repo, self.model_dir = repo, Path(model_dir)
        self.shard: Shard | None = None
        self.lo = self.hi = 0
        self.phase, self.done, self.total, self.message = "idle", 0, 0, ""
        self.caches: dict[str, tuple[list, float]] = {}   # "session:lo:hi" -> (KV cache, last used)
        self.served = self.tokens = 0
        self.busy = False
        self.last_compute_ms = 0.0
        self.last_forward_ts = 0.0
        self._load_lock = threading.Lock()

    def slices(self) -> list[dict]:
        return [{"model": self.repo, "lo": self.lo, "hi": self.hi, "loaded": self.shard is not None}] if self.hi else []

    def run(self, key: str, lo: int, hi: int, h: mx.array) -> tuple[mx.array, float]:
        shard = self.shard
        if shard is None or not shard.lo <= lo <= hi <= shard.hi:
            raise ValueError(f"not serving layers [{lo},{hi})")
        with MLX:
            entry = self.caches.get(key)
            cache = entry[0] if entry else shard.make_cache(lo, hi)
            self.caches[key] = (cache, time.time())
            t = time.perf_counter()
            self.busy = True
            try:
                out = shard.run_layers(h, cache, lo, hi)
                mx.eval(out)
            finally:
                self.busy = False
        ms = (time.perf_counter() - t) * 1000
        self.served += 1
        self.tokens += int(h.shape[1])
        self.last_compute_ms, self.last_forward_ts = ms, time.time()
        return out, ms

    def forward(self, req: pb.ForwardRequest) -> pb.ForwardResponse:
        if req.model and req.model != self.repo:
            return pb.ForwardResponse(session_id=req.session_id, error=f"not serving {req.model}")
        try:
            out, ms = self.run(f"{req.session_id}:{req.layer_lo}:{req.layer_hi}", req.layer_lo, req.layer_hi,
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

    def load(self, lo: int, hi: int, progress=lambda phase, done=0, total=0, msg="": None):
        def emit(phase, done=0, total=0, msg=""):
            self.phase, self.done, self.total, self.message = phase, done, total, msg
            progress(phase, done, total, msg)

        with self._load_lock:
            if self.shard is not None and (self.lo, self.hi) == (lo, hi):
                emit("ready", 1, 1)
                return
            try:
                self.lo, self.hi = lo, hi
                download_slice(self.repo, self.model_dir, lo, hi, name=f"layers-{lo}-{hi}",
                               on_progress=lambda d, t: emit("downloading", d, t))
                emit("loading")
                with MLX:
                    self.shard = None
                    self.caches.clear()
                    mx.clear_cache()
                    self.shard = Shard(self.model_dir, lo, hi)
                emit("ready", 1, 1)
            except Exception as e:  # noqa: BLE001 - reported to whoever asked
                self.shard, self.lo, self.hi = None, 0, 0
                emit("error", msg=str(e))
                raise

    def info(self) -> pb.NodeInfo:
        return pb.NodeInfo(
            name=NAME, layer_lo=self.lo, layer_hi=self.hi, loaded=self.shard is not None,
            mem_active_gb=mx.get_active_memory() / GB, mem_peak_gb=mx.get_peak_memory() / GB,
            mem_total_gb=mem_total_gb(), requests_served=self.served, tokens_processed=self.tokens,
            active_requests=len(self.caches), busy=self.busy,
            slices=[pb.Slice(**s) for s in self.slices()])


# ---------------------------------------------------------------- the peer


class HopFailed(Exception):
    def __init__(self, hop: Hop, reason: str):
        super().__init__(reason)
        self.hop, self.reason = hop, reason


class PeerApp:
    def __init__(self, repo: str, model_dir: Path, n_layers: int | None):
        self.repo, self.model_dir = repo, Path(model_dir)
        self._n_layers = n_layers
        self.ident = load_identity()
        self.me = self.ident.peer_id
        self.slices = Slices(repo, model_dir)
        self.net = PeerNet(self.ident, info=self.slices.info)
        self.net.handlers[M_FORWARD] = self._serve_forward
        self.net.handlers[M_LOAD] = self._serve_load
        self.swarm: SwarmClient | None = None
        self.head: Shard | None = None
        self.tok = None
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

    @property
    def n_layers(self) -> int:
        if self._n_layers:
            return self._n_layers
        try:
            self._n_layers = json.loads((self.model_dir / "config.json").read_text())["num_hidden_layers"]
        except (OSError, ValueError, KeyError):
            return 48
        return self._n_layers

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
                "slices": self.slices.slices(), "has_head": {self.repo: self.head is not None}}

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

    @staticmethod
    def peer_slices(p: dict) -> list[dict]:
        info = (p.get("link") or {}).get("info") or {}
        return info.get("slices") or p.get("slices") or []

    def offers(self) -> list[Offer]:
        out = []
        if self.slices.shard is not None:
            out.append(Offer(self.me, NAME, self.slices.lo, self.slices.hi, 0.0))
        for p in self.peers:
            link = p.get("link") or {}
            if p["peer_id"] == self.me or link.get("state") != "direct":
                continue
            for s in self.peer_slices(p):
                if s.get("loaded") and s.get("model") == self.repo:
                    out.append(Offer(p["peer_id"], p.get("name") or p["peer_id"][:8], s["lo"], s["hi"],
                                     link.get("rtt_ms") or 50.0))
        return out

    def route(self, exclude: set[str] = frozenset()) -> tuple[list[Hop], list[tuple[int, int]]]:
        return plan(self.n_layers, self.offers(), exclude)

    def route_events(self):
        hops, gaps = self.route()
        key = repr((hops, gaps, self.head is not None))
        if key == self._route_key:
            return
        self._route_key = key
        if hops:
            head_roles = ["tokenizer", "embeddings", "lm_head"]
            assign = [{"node": h.name, "lo": h.lo, "hi": h.hi, "roles": head_roles if h.peer_id == self.me else []}
                      for h in hops]
            if all(h.peer_id != self.me for h in hops):
                assign.insert(0, {"node": NAME, "lo": 0, "hi": 0, "roles": head_roles})
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
        if req.repo and req.repo != self.repo:
            writer.write(_frame(pb.LoadProgress(phase="error", message=f"this peer runs {self.repo}").SerializeToString()))
            return
        q: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def progress(phase, done=0, total=0, msg=""):
            loop.call_soon_threadsafe(q.put_nowait, pb.LoadProgress(phase=phase, done=done, total=total, message=msg))

        print(f"load requested by {self.net._name(conn.peer_id)}: layers [{req.layer_lo},{req.layer_hi})", flush=True)
        task = asyncio.create_task(asyncio.to_thread(self._load_local, req.layer_lo, req.layer_hi, progress))
        while True:
            p = await q.get()
            writer.write(_frame(p.SerializeToString()))
            if p.phase in ("ready", "error"):
                break
        await asyncio.gather(task, return_exceptions=True)

    def _load_local(self, lo, hi, progress=lambda *a: None):
        def report(phase, done=0, total=0, msg=""):
            self.emit("load_progress", node=NAME, phase=phase, done=done, total=total, message=msg)
            progress(phase, done, total, msg)

        self.emit("layer_map", key="layer_map", total_layers=self.n_layers,
                  assignments=[{"node": NAME, "lo": lo, "hi": hi, "roles": []}])
        self.slices.load(lo, hi, report)
        write_config({**read_config(), "serve": {"model": self.repo, "lo": lo, "hi": hi}})
        self.self_events()
        if self.swarm:
            asyncio.run_coroutine_threadsafe(self.swarm.publish(), self.loop)

    # ---- requesting ----
    def ensure_head(self):
        with self._head_lock:
            if self.head is not None:
                return
            sizes = {}

            def prog(part):
                def f(d, t):
                    sizes[part] = (d, t)
                    self.emit("load_progress", node=NAME, phase="downloading",
                              done=sum(v[0] for v in sizes.values()), total=sum(v[1] for v in sizes.values()))
                return f
            download_slice(self.repo, self.model_dir, 0, 0, host=True, name="embed", on_progress=prog("embed"))
            download_slice(self.repo, self.model_dir, 0, 0, tail=True, name="head", on_progress=prog("head"))
            self.tok = load_tokenizer(self.model_dir)
            with MLX:
                self.head = Shard(self.model_dir, 0, 0, embed=True, head=True)
            if self.slices.phase in ("idle", "ready"):
                self.emit("load_progress", node=NAME, phase="ready", done=1, total=1)

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

    def generate(self, ids: list[int], max_tokens: int):
        """Yields (token, text, timing) per generated token. Raises if the model isn't covered.
        If a remote hop fails, re-plans without that peer and replays prompt + output so far to
        rebuild the KV cache on the new route; tokens already yielded are kept."""
        failed: set[str] = set()
        hops, gaps = self.route()
        if not hops:
            raise RuntimeError("model not covered: layers " + ", ".join(f"{a}–{b - 1}" for a, b in gaps)
                               + " have no reachable peer")
        self.ensure_head()
        session = uuid.uuid4().hex
        streams: dict[int, Stream] = {}
        seq = list(ids)
        x = mx.array(seq)[None]
        eos = set(getattr(self.tok, "eos_token_ids", None) or {self.tok.eos_token_id})
        produced, reroutes = 0, 0
        try:
            while produced < max_tokens:
                t0 = time.perf_counter()
                with MLX:
                    h = self.head.embed(x)
                    mx.eval(h)
                pre = (time.perf_counter() - t0) * 1000
                stages, nbytes = [], 0
                try:
                    for k, hop in enumerate(hops):
                        if hop.peer_id == self.me:
                            h, ms = self.slices.run(f"{session}:{hop.lo}:{hop.hi}", hop.lo, hop.hi, h)
                            stages += [{"node": "network", "compute_ms": 0.0}, {"node": NAME, "compute_ms": ms}]
                            continue
                        payload = to_wire(h)
                        req = pb.ForwardRequest(session_id=session, hidden=payload, shape=list(h.shape),
                                                model=self.repo, layer_lo=hop.lo, layer_hi=hop.hi)
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
                    new_hops, gaps = self.route(failed)
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
                    tok = mx.argmax(self.head.logits(h[:, -1:, :])[0, -1])
                    mx.eval(tok)
                post = (time.perf_counter() - t2) * 1000
                tok = int(tok.item())
                head = {"node": NAME, "compute_ms": pre + post, "pre_ms": pre, "post_ms": post}
                yield tok, self.tok.decode([tok]), {"stages": [head, *stages], "bytes": nbytes,
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
            n, errors = self.n_layers, []
            mine = (self.slices.lo, self.slices.hi) if self.slices.shard is not None else None
            if not mine:
                mine = (0, k)
            threads = [threading.Thread(target=self._try, args=(errors, "this Mac", self._load_local, *mine)),
                       threading.Thread(target=self._try, args=(errors, "this Mac", self.ensure_head))]
            # Layers nobody reachable serves (besides what this Mac is about to load): ask a peer.
            others = [o for o in self.offers() if o.peer_id != self.me] + [Offer(self.me, NAME, *mine)]
            _, gaps = plan(n, others)
            for lo, hi in gaps:
                pid = self.pick_helper(exclude={self.me})
                if not pid:
                    errors.append(f"layers {lo}–{hi - 1} have no peer, and no other Mac is connected to serve them")
                    continue
                threads.append(threading.Thread(target=self._try, args=(errors, self.net._name(pid),
                                                                         self.remote_load, pid, lo, hi)))
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

    def pick_helper(self, exclude: set[str]) -> str | None:
        """A direct peer serving nothing (else any direct peer), preferring the lowest RTT."""
        cands = []
        for p in self.peers:
            link = p.get("link") or {}
            if p["peer_id"] in exclude or link.get("state") != "direct":
                continue
            cands.append((bool(self.peer_slices(p)), link.get("rtt_ms") or 1e9, p["peer_id"]))
        return min(cands)[2] if cands else None

    def remote_load(self, pid: str, lo: int, hi: int):
        name = self.net._name(pid)

        async def go():
            s = await self.net.conn_to(pid).open(M_LOAD, pb.LoadRequest(repo=self.repo, layer_lo=lo, layer_hi=hi)
                                                 .SerializeToString())
            s.close()
            while True:
                p = pb.LoadProgress.FromString(await asyncio.wait_for(s.recv(), LOAD_TIMEOUT_S))
                self.emit("load_progress", node=name, phase=p.phase, done=p.done, total=p.total, message=p.message)
                if p.phase == "error":
                    raise RuntimeError(p.message)
                if p.phase == "ready":
                    break
            link = self.net.links.get(pid)
            if link:
                await self.net._refresh_info(link)

        self.emit("layer_map", key="layer_map", total_layers=self.n_layers,
                  assignments=[{"node": NAME, "lo": 0, "hi": 0, "roles": ["tokenizer", "embeddings", "lm_head"]},
                               {"node": name, "lo": lo, "hi": hi, "roles": []}])
        self._call(go(), LOAD_TIMEOUT_S)

    async def serve(self, request):
        b = await request.json()
        lo, hi = int(b["lo"]), int(b["hi"])
        if not 0 <= lo < hi <= self.n_layers:
            return web.json_response({"error": "range out of bounds"}, status=400)
        threading.Thread(target=self._try, args=([], "serve", self._load_local, lo, hi), daemon=True).start()
        return web.json_response({"ok": True})

    async def chat(self, request):
        b = await request.json()
        who = str(b.get("key") or "")[:64]
        if not who:
            return web.json_response({"error": "missing chat key"}, status=400)
        if not self.route()[0]:
            return web.json_response({"error": "model not covered yet"}, status=409)
        with self.active_lock:
            self.active += 1
        self.emit("chat_session", key="chat_session", busy=True, started=time.time())
        threading.Thread(target=self._chat, args=(b["prompt"], int(b.get("max_tokens", 256)), who),
                         daemon=True).start()
        return web.json_response({"ok": True})

    def _chat(self, prompt, max_tokens, who):
        try:
            self.ensure_head()
            text = self.tok.apply_chat_template([{"role": "user", "content": prompt}], add_generation_prompt=True,
                                                tokenize=False, enable_thinking=False)
            ids = self.tok.encode(text)
            self.stats["requests"] += 1
            self.stats["prompt_tokens"] += len(ids)
            self.stats["tokens"] += len(ids)
            t0, first, count = time.perf_counter(), None, 0
            for i, (tok, piece, timing) in enumerate(self.generate(ids, max_tokens)):
                if first is None:
                    first = (time.perf_counter() - t0) * 1000
                count += 1
                self.stats["generated_tokens"] += 1
                if count > 1:
                    self.stats["tokens"] += 1
                if count % 8 == 0:
                    self.self_events()
                self.emit("token", owner=who, index=i, text=piece, token=tok)
                self.emit("token_timing", owner=who, index=i, prefill=(i == 0), **timing)
            total = time.perf_counter() - t0
            self.emit("done", owner=who, tokens=count, ttft_ms=first,
                      tok_s=(count - 1) / max(total - (first or 0) / 1000, 1e-6), total_ms=total * 1000,
                      prompt_tokens=len(ids))
        except Exception as e:  # noqa: BLE001
            self.emit("error", owner=who, message=f"generation failed: {e}")
        finally:
            with self.active_lock:
                self.active -= 1
            self.self_events()
            self.emit("chat_session", key="chat_session", busy=self.active > 0,
                      started=time.time() if self.active else None)

    async def complete(self, request):
        """Blocking completion for scripts and tests: {"ids": [...]} or {"prompt": "..."}, greedy."""
        b = await request.json()

        def run():
            self.ensure_head()
            ids = b.get("ids") or self.tok.encode(b["prompt"])
            out = list(self.generate(ids, int(b.get("max_tokens", 32))))
            return {"tokens": [t for t, _, _ in out], "text": "".join(p for _, p, _ in out),
                    "timings": [tm for _, _, tm in out]}
        try:
            return web.json_response(await asyncio.to_thread(run))
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": str(e)}, status=409)

    async def status(self, _):
        hops, gaps = self.route()
        s = self.slices
        return web.json_response({
            "name": NAME, "peer_id": self.me, "repo": self.repo, "n_layers": self.n_layers,
            "slices": s.slices(), "phase": s.phase, "done": s.done, "total": s.total, "message": s.message,
            "head_loaded": self.head is not None, "route": [[h.name, h.lo, h.hi] for h in hops], "gaps": gaps,
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


def run_peer(repo: str, model_dir, n_layers: int | None, port: int, serve: tuple[int, int] | None,
             open_browser: bool = False):
    app_state = PeerApp(repo, Path(model_dir), n_layers)
    if serve is None and (c := read_config().get("serve")) and c.get("model") == repo:
        serve = (int(c["lo"]), int(c["hi"]))
    app = web.Application(middlewares=[cors], client_max_size=16 << 20)
    app.add_routes([web.get("/", app_state.index), web.get("/ws", app_state.ws), web.get("/status", app_state.status),
                    web.post("/api/start", app_state.start), web.post("/api/serve", app_state.serve),
                    web.post("/api/chat", app_state.chat), web.post("/api/complete", app_state.complete),
                    web.post("/api/shutdown", app_state.shutdown)])

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
            threading.Thread(target=app_state._try, args=([], "serve", app_state._load_local, *serve), daemon=True).start()

    app.on_startup.append(on_start)
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    print(f"peer {NAME} ({app_state.me[:8]}): local API on http://127.0.0.1:{port}", flush=True)
    web.run_app(app, host="127.0.0.1", port=port, print=None)
