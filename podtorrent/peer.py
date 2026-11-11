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
import platform
import sys
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Callable

import aiohttp
from aiohttp import WSMsgType, web

from . import backend as B
from . import catalog
from . import openai_api
from . import pod
from . import pipeline_pb2 as pb
from .cli import default_dir
from .backend import CHIP, GB, from_wire, load_tokenizer, mem_free_gb, mem_total_gb, to_wire
from .common import cors
from .net.identity import home, load_identity
from .net.quic import M_FORWARD, M_LOAD, PeerNet, Stream, _frame, _read_frame
from .net.rendezvous import RoomError, SwarmClient, join_pod
from .route import Hop, Offer, coverage, plan
from .backend import Shard
from .slicer import download_slice, estimate_slice_bytes, fetch_meta
from .video import api as video_api
from .video.encoder_node import EncoderNode
from .video.service import MIN_VRAM_GB
from .video.service import VideoService
from .video.swarm import VideoSwarm

STATIC = Path(__file__).parent / "static"
MLX = threading.Lock()   # one computation at a time in this process (MLX or PyTorch)
CACHE_IDLE_S = 300
HOP_TIMEOUT_S = 120
MAX_REROUTES = 3
DECODE_HOP_TIMEOUT_S = 10  # one token's hop; a dead peer sends no close, so don't wait for the QUIC idle timeout
LOAD_TIMEOUT_S = 3600
SUPPORTED = {"qwen3_moe"}  # architectures Shard can run
PLAN_RETRY_S = 60          # a plan hop that failed to load is tried again after this long
SUPPLY_REFRESH_S = 60      # how often the lobby supply rescans the models on disk
MEM_HEADROOM_GB = 1.0      # keep this much of the GPU budget free after loading a slice
TRUSTED_OWNERS = ("mlx-community",)  # Hugging Face orgs any linked peer may ask this machine to load from
MAX_POSITIONS = 32768      # longest sequence a peer's session may push through a slice (Qwen3's native context)
MAX_PEER_SESSIONS = 8      # live KV-cache sessions one peer may hold on this machine
HEAD_ROLES = ["tokenizer", "embeddings", "lm_head"]


def config_path() -> Path:
    return home() / "config.json"


def read_config() -> dict:
    try:
        return json.loads(config_path().read_text())
    except (OSError, ValueError):
        return {}


# PODTORRENT_NAME (set by the app from onboarding, or by tests), else config.json's `name`, else the hostname.
NAME = os.environ.get("PODTORRENT_NAME") or read_config().get("name") or platform.node().split(".")[0]


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
        self.cancel = threading.Event()   # set by unserve: stop the download at the next chunk

    def record(self) -> dict:
        return {"model": self.model, "lo": self.lo, "hi": self.hi, "loaded": self.shard is not None,
                "n_layers": self.n_layers, "phase": self.phase, "done": self.done, "total": self.total}


class Cancelled(Exception):
    """A slice was unserved while it was still downloading."""


class Slices:
    """Every slice this Mac serves to the swarm, keyed by (model, lo, hi)."""

    def __init__(self, model_dir: Callable[[str], Path]):
        self.model_dir = model_dir
        self.items: dict[tuple[str, int, int], Served] = {}
        self.caches: dict[str, tuple[list, float]] = {}   # "session:model:lo:hi" -> (KV cache, last used)
        self.positions: dict[str, int] = {}   # session -> positions pushed through it so far
        self._hidden: dict[str, int] = {}     # model -> hidden size, from its config
        self.served = self.tokens = 0
        self.busy = False
        self.last_compute_ms = 0.0
        self.last_forward_ts = 0.0
        self._load_lock = threading.Lock()

    def held_gb(self) -> float:
        """Memory these text-model slices take (or will, once loaded)."""
        return sum(gb(self.model_dir(s.model), s.lo, s.hi) for s in list(self.items.values()))

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

    def run(self, session: str, model: str, lo: int, hi: int, h) -> tuple[object, float]:
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
                B.materialize(h)
            finally:
                self.busy = False
        ms = (time.perf_counter() - t) * 1000
        self.served += 1
        self.tokens += int(h.shape[1])
        self.last_compute_ms, self.last_forward_ts = ms, time.time()
        return h, ms

    def hidden_size(self, model: str) -> int:
        if model not in self._hidden:
            cfg = json.loads((self.model_dir(model) / "config.json").read_text())
            self._hidden[model] = cfg.get("text_config", cfg)["hidden_size"]
        return self._hidden[model]

    def check(self, req: pb.ForwardRequest, model: str):
        """Refuse a peer's forward before it costs memory: one sequence, this model's hidden size, the bytes
        to match, and no more than MAX_POSITIONS positions over the session's life (attention grows with T²)."""
        shape = list(req.shape)
        if len(shape) != 3 or shape[0] != 1 or shape[1] < 1:
            raise ValueError(f"expected hidden states of shape [1, T, hidden], got {shape}")
        if shape[2] != self.hidden_size(model):
            raise ValueError(f"hidden size {shape[2]} does not match {model} ({self.hidden_size(model)})")
        if len(req.hidden) != 2 * shape[1] * shape[2]:
            raise ValueError(f"{len(req.hidden)} bytes of hidden states for shape {shape}")
        if self.positions.get(req.session_id, 0) + shape[1] > MAX_POSITIONS:
            raise ValueError(f"session is longer than {MAX_POSITIONS} positions")

    def forward(self, req: pb.ForwardRequest) -> pb.ForwardResponse:
        model = req.model or next((s.model for s in self.loaded()), "")
        try:
            if not self.loaded(model):
                raise ValueError(f"not serving {model}")
            self.check(req, model)
            out, ms = self.run(req.session_id, model, req.layer_lo, req.layer_hi,
                               from_wire(req.hidden, list(req.shape)))
            self.positions[req.session_id] = self.positions.get(req.session_id, 0) + req.shape[1]
        except ValueError as e:
            return pb.ForwardResponse(session_id=req.session_id, error=str(e))
        return pb.ForwardResponse(session_id=req.session_id, hidden=to_wire(out), shape=list(out.shape),
                                  compute_ms=ms)

    def release(self, session: str):
        for k in [k for k in self.caches if k.startswith(session + ":")]:
            self.caches.pop(k, None)
        self.positions.pop(session, None)

    def evict_idle(self):
        now = time.time()
        for k in [k for k, (_, ts) in self.caches.items() if now - ts > CACHE_IDLE_S]:
            self.caches.pop(k, None)
        live = {k.rsplit(":", 3)[0] for k in self.caches}
        for s in [s for s in self.positions if s not in live]:
            self.positions.pop(s, None)

    def sessions_of(self, prefix: str) -> set[str]:
        """Live sessions whose id starts with `prefix` (a peer's namespace)."""
        return {k.rsplit(":", 3)[0] for k in self.caches if k.startswith(prefix)}

    def load(self, model: str, lo: int, hi: int, progress=lambda phase, done=0, total=0, msg="": None,
             replace: bool = False) -> Served:
        """Download and load `model` layers [lo, hi) next to whatever is already served. Slices of the
        same model that the new one contains are dropped once it's ready; with `replace` (a resize, which
        may also shrink), every other slice of the model is. Raises MemoryError up front when the slice
        won't fit in this machine's GPU budget."""
        with self._load_lock:
            have = (next((s for s in self.loaded(model) if (s.lo, s.hi) == (lo, hi)), None) if replace
                    else self.find(model, lo, hi))
            if have is not None:
                if replace:
                    with MLX:
                        for r in self.loaded(model):
                            if r is not have:
                                r.shard = None
                                self.items.pop((r.model, r.lo, r.hi), None)
                        B.clear_cache()
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
            replaced = [s for s in self.loaded(model) if replace or (lo <= s.lo and s.hi <= hi)]
            # Text first: video encoder layers on disk hold no memory here; a video job checks for room
            # when it loads them (EncoderNode.check_load).
            need = gb(d, lo, hi)
            free = mem_free_gb() + sum(gb(d, s.lo, s.hi) for s in replaced)
            if need + MEM_HEADROOM_GB > free:
                fit = int(max(free - MEM_HEADROOM_GB, 0) // (need / (hi - lo))) if need else 0
                raise MemoryError(f"{model.split('/')[-1]} layers {lo}–{hi - 1} need ~{need:.1f} GB plus {MEM_HEADROOM_GB:.0f} GB "
                                  f"headroom, but this machine has {max(free, 0):.1f} GB free for models. "
                                  f"Serve {fit} layers or fewer.")
            s = self.items[(model, lo, hi)] = Served(model, lo, hi, n)

            def emit(phase, done=0, total=0, msg=""):
                if s.cancel.is_set():
                    raise Cancelled(f"{model} layers [{lo},{hi})")
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
                    B.clear_cache()
                    s.shard = Shard(d, lo, hi)
                emit("ready", 1, 1)
                return s
            except Exception as e:
                if self.items.get((model, lo, hi)) is s:
                    self.items.pop((model, lo, hi), None)
                if isinstance(e, Cancelled):  # a partial download is of no use: drop it
                    (d / f"layers-{lo}-{hi}.data.tmp").unlink(missing_ok=True)
                raise

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no slice is being downloaded or loaded."""
        if self._load_lock.acquire(timeout=timeout):
            self._load_lock.release()
            return True
        return False

    def unserve(self, model: str, lo: int | None = None, hi: int | None = None) -> list[Served]:
        """Stop serving `model` layers [lo, hi) exactly, or every slice of `model` without a range."""
        with MLX:
            gone = [s for s in list(self.items.values())
                    if s.model == model and (lo is None or (s.lo, s.hi) == (lo, hi))]
            for s in gone:
                s.cancel.set()
                s.shard = None
                self.items.pop((s.model, s.lo, s.hi), None)
            # Sessions through layers nobody here serves any more get an error on their next token and re-route.
            for k in list(self.caches):
                _, m, a, b = k.rsplit(":", 3)
                if m == model and not any(s.shard is not None and s.lo <= int(a) and int(b) <= s.hi
                                          for s in self.items.values() if s.model == m):
                    self.caches.pop(k, None)
            if gone:
                B.clear_cache()
        return gone

    def info(self) -> pb.NodeInfo:
        first = next(iter(self.loaded()), None)
        return pb.NodeInfo(
            name=NAME, layer_lo=first.lo if first else 0, layer_hi=first.hi if first else 0,
            loaded=first is not None,
            mem_active_gb=B.mem_active_gb(), mem_peak_gb=B.mem_peak_gb(),
            mem_total_gb=mem_total_gb(), mem_free_gb=mem_free_gb(), requests_served=self.served,
            tokens_processed=self.tokens, active_requests=len(self.caches), busy=self.busy,
            slices=[pb.Slice(model=r["model"], lo=r["lo"], hi=r["hi"], loaded=r["loaded"], n_layers=r["n_layers"])
                    for r in self.slices()])


# ---------------------------------------------------------------- the peer


def pod_summary(r: dict | None) -> dict | None:
    """What the UI and CLI show about a roster (no keys or signature)."""
    if not r:
        return None
    return {"pod_id": r["pod_id"], "name": r["name"], "kind": r["kind"], "version": r["version"],
            "owner": pod.owner_id(r),
            "members": [{"peer_id": m["peer_id"], "name": m["name"], "public": m.get("public", False)}
                        for m in r["members"]],
            "plans": r["plans"], "expires": r["expires"]}


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
        self.net.allowed = self.allows
        self.pod: dict | None = pod.load_roster()   # None: no pod, every peer is fair game (the public swarm)
        self._pod_mtime = self._roster_mtime()
        self._plan_tries: dict[tuple[str, int, int], float] = {}   # plan hop -> when this Mac last started it
        self._on_disk: list[dict] = []   # catalog.local's complete models, for the matchmaker
        self._supply_ts = 0.0
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
        self._names: dict[str, str] = {}   # peer_id -> display name, for peers that vanish
        self.peers: list[dict] = []   # swarm records, each with this Mac's `link` to it

    # ---- pod ----
    def allows(self, peer_id: str) -> bool:
        """Whether this Mac links with and serves `peer_id`: its pod's members, or anyone outside a pod."""
        return self.pod is None or pod.is_member(self.pod, peer_id)

    @staticmethod
    def _roster_mtime() -> float:
        try:
            return pod.roster_path().stat().st_mtime
        except OSError:
            return 0.0

    def reload_pod(self):
        """Pick up a changed pod.json: drop links to machines no longer in the pod, dial new members."""
        mtime = self._roster_mtime()
        if mtime == self._pod_mtime and not (self.pod and self.pod["expires"] and time.time() >= self.pod["expires"]):
            return
        self._pod_mtime = mtime
        self._set_pod(pod.load_roster())

    def _set_pod(self, new: dict | None):
        if new == self.pod:
            return
        old, self.pod = self.pod, new
        print(f"pod: {new['name']} v{new['version']}, {len(new['members'])} machines" if new else "pod: none", flush=True)
        self.net.prune()
        self._announce()
        self.emit("pod", key="pod", pod=pod_summary(new))
        if (old or {}).get("pod_id") != (new or {}).get("pod_id") and self.swarm and self.loop:
            asyncio.run_coroutine_threadsafe(self.swarm.reconnect(), self.loop)   # into the new pod's room

    def _save_pod(self, r: dict):
        """Keep `r` as this machine's roster, act on it, and give it to the pod's room."""
        pod.save_roster(r)
        self._pod_mtime = self._roster_mtime()
        same_room = (self.pod or {}).get("pod_id") == r["pod_id"]
        self._set_pod(r)
        if same_room:
            self._room_send({"type": "roster", "roster": r})

    def _forget_pod(self):
        pod.roster_path().unlink(missing_ok=True)
        self._pod_mtime = 0.0
        self._set_pod(None)

    def on_dissolved(self):
        """The matchmaker gave up on this machine's public pod: back to the lobby."""
        if self.pod and self.pod["kind"] == "public":
            print(f"pod: {self.pod['name']} dissolved", flush=True)
            self._forget_pod()

    def supply(self) -> dict:
        """What this machine offers the matchmaker from the lobby: every model it has on disk in full,
        with the layers it already serves, and its free memory (docs/PODS_PLAN.md, 3)."""
        if time.time() - self._supply_ts > SUPPLY_REFRESH_S:
            known = [self.repo, *{s.model for s in self.slices.items.values()}]
            self._on_disk = [m for m in catalog.local(known) if m["complete"] and m["n_layers"]]
            self._supply_ts = time.time()
        models = [{"model": m["repo"], "layers": m["n_layers"], "gb": round(m["disk_bytes"] / 1e9, 1),
                   "held": [[s.lo, s.hi] for s in self.slices.loaded(m["repo"])]} for m in self._on_disk]
        return {"name": NAME, "chip": CHIP, "mem_total_gb": round(mem_total_gb(), 1),
                "mem_free_gb": round(self.free_for_models() * 2) / 2, "node": (home() / "network.json").exists(),
                "models": models}

    def _room_send(self, msg: dict):
        if self.swarm and self.loop:
            asyncio.run_coroutine_threadsafe(self.swarm.send(msg), self.loop)

    def on_roster(self, r: dict):
        """A roster from the pod's room: adopt it if it's newer; a roster without this machine means
        the owner removed it, so it goes back to the public swarm."""
        new = pod.newer(self.pod, r)
        if new is None:
            return
        if pod.is_member(new, self.me):
            pod.save_roster(new)
            self._pod_mtime = self._roster_mtime()
            self._set_pod(new)
        else:
            self.emit("error", message=f"This machine was removed from the pod {new['name']}; it's back in the public swarm.")
            self._forget_pod()

    def on_owner_request(self, msg: dict):
        """As the owner: add a machine whose proof answers one of this owner's pending invites, or sign
        out a member that left."""
        if not self.pod or pod.owner_id(self.pod) != self.me:
            return
        if msg.get("type") == "leave_request":
            pid = str(msg.get("from") or "")
            if pid != self.me and pod.is_member(self.pod, pid):
                name = next(m["name"] for m in self.pod["members"] if m["peer_id"] == pid)
                self._save_pod(pod.sign(pod.remove_member(self.pod, pid), self.ident))
                print(f"pod: {name} left", flush=True)
            return
        pubkey, name = str(msg.get("pubkey", "")), str(msg.get("name") or "")[:64] or "machine"
        try:
            ok = pod.take_invite(self.pod["pod_id"], pubkey, str(msg.get("proof", "")))
        except ValueError:
            ok = False
        if not ok:
            self._room_send({"type": "join_failed", "to": msg.get("from"), "reason": "invalid or expired invite code"})
            return
        self._save_pod(pod.sign(pod.add_member(self.pod, pod.member(pubkey, name)), self.ident))
        self.emit("pod_joined", node=name)
        print(f"pod: {name} joined", flush=True)

    def apply_plan(self):
        """Load the head of every plan this Mac heads in its pod. Layers come from the Models tab for
        now: a plan's hops don't load or unload anything."""
        if not self.pod:
            return
        now = time.time()
        for p in self.pod["plans"]:
            model, hkey = p["model"], (p["model"], -1, -1)
            if p["head"] == self.me and model not in self.heads and now - self._plan_tries.get(hkey, 0.0) >= PLAN_RETRY_S:
                self._plan_tries[hkey] = now
                threading.Thread(target=self._try, args=([], "pod plan", self.ensure_head, model), daemon=True).start()

    def free_for_models(self) -> float:
        """Room for more text-model layers: the free GPU budget. Video encoder layers on disk don't
        hold any of it (text first); a video job checks for room when it loads them."""
        return mem_free_gb()

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
        self.emit("memory", key=f"mem:{NAME}", node=NAME, active_gb=B.mem_active_gb(),
                  peak_gb=B.mem_peak_gb(), total_gb=mem_total_gb())
        self.emit("node_stats", key=f"stats:{NAME}", node=NAME, busy=self.active > 0 or s.busy,
                  active_requests=self.active + len(s.caches), tokens=self.stats["tokens"] + s.tokens,
                  requests=self.stats["requests"] + s.served, **{k: v for k, v in self.stats.items() if k not in ("tokens", "requests")})

    # ---- swarm ----
    def swarm_record(self) -> dict:
        return {"name": NAME, "chip": CHIP, "mem_total_gb": round(mem_total_gb(), 1),
                "mem_free_gb": round(mem_free_gb() * 2) / 2,  # half-GB steps, so idle drift doesn't republish
                "slices": [{k: v for k, v in r.items() if k != "phase"} for r in self.slices.slices()],
                "has_head": {m: True for m in self.heads},
                # For the census: this machine heads a plan and serves it on the network.
                "on_network": bool(self.pod) and (home() / "network.json").exists()
                and any(p["head"] == self.me for p in self.pod["plans"])}

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
                    self._names[pid] = name
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
            if rec is None:
                # Gone from the registry entirely: forget it, so it is not replayed to new clients.
                name = self._names.pop(pid, pid[:8])
                for k in ("node", "status", "mem", "stats"):
                    self.state.pop(f"{k}:{name}", None)
                self.emit("node_left", node=name)
                continue
            name = rec.get("name") or pid[:8]
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
            if p["peer_id"] == self.me or not self.allows(p["peer_id"]) or (reachable and link.get("state") != "direct"):
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
        names = {s.model for s in list(self.slices.items.values())} | {self.repo}
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
        # Session ids come from the peer: keep each peer's in its own namespace so none can reach another's KV cache.
        ns = f"{conn.peer_id}/"
        try:
            while True:
                req = pb.ForwardRequest.FromString(body)
                theirs = req.session_id
                req.session_id = ns + theirs
                if req.release:
                    self.slices.release(req.session_id)
                else:
                    sessions.add(req.session_id)
                    t = time.perf_counter()
                    held = self.slices.sessions_of(ns)
                    try:
                        if req.session_id not in held and len(held) >= MAX_PEER_SESSIONS:
                            raise ValueError(f"this machine already holds {MAX_PEER_SESSIONS} sessions for that peer")
                        resp = await asyncio.to_thread(self.slices.forward, req)
                    except Exception as e:  # noqa: BLE001 - say why, or the caller waits until it times out
                        resp = pb.ForwardResponse(error=f"{type(e).__name__}: {e}")
                    resp.session_id = theirs
                    secs = time.perf_counter() - t
                    if resp.error or secs > 2:
                        print(f"forward: layers [{req.layer_lo},{req.layer_hi}) x{req.shape[1] if len(req.shape) > 1 else '?'} "
                              f"for {self.net._name(conn.peer_id)} "
                              f"took {secs:.1f}s" + (f": {resp.error}" if resp.error else ""), flush=True)
                    writer.write(_frame(resp.SerializeToString()))
                try:
                    body = await _read_frame(reader)
                except asyncio.IncompleteReadError:
                    break
        finally:
            for s in sessions:
                self.slices.release(s)

    def _may_load_for_peer(self, model: str) -> bool:
        """Outside a pod any linked peer can ask for layers, so only fetch repos from a trusted publisher
        or ones this machine's user already chose (the default model, a configured slice, a model on disk)."""
        if model.split("/")[0] in TRUSTED_OWNERS or model == self.repo:
            return True
        if any(c.get("model") == model for c in configured_slices()):
            return True
        try:
            return (self.model_dir(model) / ".repo").read_text().strip() == model
        except OSError:
            return False

    async def _serve_load(self, conn, body, reader, writer):
        req = pb.LoadRequest.FromString(body)
        model = req.repo or self.repo
        msg = ""
        if self.pod and conn.peer_id != pod.owner_id(self.pod):
            # In a pod, layers come from the plan; only the owner may ask for more directly.
            msg = "this machine is in a pod: only its owner can ask it to load layers"
        elif not self.pod and not self._may_load_for_peer(model):
            msg = (f"this machine only loads {', '.join(TRUSTED_OWNERS)} models, or ones it already has, "
                   f"for other peers; add {model} on this machine first")
        if msg:
            writer.write(_frame(pb.LoadProgress(phase="error", message=msg).SerializeToString()))
            return
        q: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def progress(phase, done=0, total=0, msg=""):
            loop.call_soon_threadsafe(q.put_nowait, pb.LoadProgress(phase=phase, done=done, total=total, message=msg))

        print(f"load requested by {self.net._name(conn.peer_id)}: {model} layers [{req.layer_lo},{req.layer_hi})",
              flush=True)

        def load():
            try:
                # A peer's request lasts until restart; only this machine's user (or its pod plan) makes it stick.
                self._load_local(model, req.layer_lo, req.layer_hi, progress, persist=bool(self.pod))
            except Exception:  # noqa: BLE001 - _load_local already sent it as an error progress
                pass
        task = asyncio.create_task(asyncio.to_thread(load))
        while True:
            p = await q.get()
            writer.write(_frame(p.SerializeToString()))
            if p.phase in ("ready", "error"):
                break
        await asyncio.gather(task, return_exceptions=True)

    def _load_local(self, model, lo, hi, progress=lambda *a: None, replace=False, persist=True):
        last = [None]

        def report(phase, done=0, total=0, msg=""):
            self.emit("load_progress", node=NAME, model=model, lo=lo, hi=hi, phase=phase, done=done, total=total,
                      message=msg)
            if phase != last[0]:  # the replayed slice list (UI reloads, window reopens) shows each new phase
                last[0] = phase
                self.emit("slices", key="slices", slices=self.slices.slices(), mem_free_gb=self.free_for_models())
            progress(phase, done, total, msg)

        if model == self.repo and not self.route()[0]:
            self.emit("layer_map", key="layer_map", total_layers=self.n_layers,
                      assignments=[{"node": NAME, "lo": lo, "hi": hi, "roles": []}])
        self._announce()  # the new slice shows up as "checking" / "downloading"
        try:
            s = self.slices.load(model, lo, hi, report, replace=replace)
        except Cancelled:
            # The UI gets "cancelled"; a requesting peer gets "error", which every version understands.
            self.emit("load_progress", node=NAME, model=model, lo=lo, hi=hi, phase="cancelled", done=0, total=0,
                      message="download cancelled")
            progress("error", 0, 0, "download cancelled")
            self._announce()
            raise
        except Exception as e:
            report("error", msg=str(e))
            self._announce()
            raise
        if persist:
            save_slices(lambda cur: [c for c in cur if not (c.get("model") == model and (replace or lo <= c["lo"] and c["hi"] <= hi))]
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
        self.emit("slices", key="slices", slices=self.slices.slices(), mem_free_gb=self.free_for_models())
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
        strikes: dict[str, int] = {}   # timeouts per peer; one slow token (GC, Wi-Fi blip, DERP flip) isn't death
        hops, gaps = self.route(model)
        if not hops:
            raise RuntimeError(f"{model} not covered: " + (", ".join(f"layers {a}–{b - 1}" for a, b in gaps)
                                                             or "nobody online serves it") + " (no reachable peer)")
        embed_head, tok_ = self.ensure_head(model)
        session = uuid.uuid4().hex
        streams: dict[int, Stream] = {}
        seq = list(ids)
        x = B.token_ids(seq)
        eos = set(getattr(tok_, "eos_token_ids", None) or {tok_.eos_token_id})
        # chat turn terminators aren't always in the tokenizer's EOS set (Qwen's is <|endoftext|>)
        vocab = tok_.get_vocab() if hasattr(tok_, "get_vocab") else {}
        eos |= {vocab[t] for t in ("<|im_end|>", "<|eot_id|>", "<|end|>", "<end_of_turn>", "<|endoftext|>")
                if t in vocab}
        produced, reroutes = 0, 0
        try:
            while produced < max_tokens:
                t0 = time.perf_counter()
                with MLX:
                    h = B.materialize(embed_head.embed(x))
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
                            print(f"route: {hop.name} [{hop.lo},{hop.hi}) x{h.shape[1]} gave no answer in "
                                  f"{time.perf_counter() - t:.1f}s ({len(payload) // 1024} KB sent)", flush=True)
                            raise HopFailed(hop, str(e) or type(e).__name__) from e
                        if resp.error:
                            raise HopFailed(hop, resp.error)
                        rtt = (time.perf_counter() - t) * 1000
                        h = from_wire(resp.hidden, list(resp.shape))
                        nbytes = max(nbytes, len(payload))
                        stages += [{"node": "network", "compute_ms": max(rtt - resp.compute_ms, 0.0)},
                                   {"node": hop.name, "compute_ms": resp.compute_ms}]
                except HopFailed as f:
                    reroutes += 1
                    pid = f.hop.peer_id
                    strikes[pid] = strikes.get(pid, 0) + 1
                    if f.reason != "TimeoutError" or strikes[pid] > 1 or pid == self.me:
                        failed.add(pid)
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
                    x = B.token_ids(seq)
                    continue
                t2 = time.perf_counter()
                with MLX:
                    tok = B.argmax_last(embed_head.logits(h[:, -1:, :]))
                post = (time.perf_counter() - t2) * 1000
                if tok in eos:  # stop without emitting the terminator's text
                    break
                head = {"node": NAME, "compute_ms": pre + post, "pre_ms": pre, "post_ms": post}
                yield tok, tok_.decode([tok]), {"stages": [head, *stages], "bytes": nbytes,
                                                    "route": [[h_.name, h_.lo, h_.hi] for h_ in hops]}
                produced += 1
                seq.append(tok)
                x = B.token_ids([tok])
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
            threads = [threading.Thread(target=self._try, args=(errors, "this machine", self._load_local, model, *r),
                                        daemon=True)
                       for r in mine if not self.slices.find(model, *r)]
            threads.append(threading.Thread(target=self._try, args=(errors, "this machine", self.ensure_head, model),
                                            daemon=True))
            # Layers nobody reachable serves (besides what this Mac is about to load): ask a peer.
            others = [o for o in self.offers(model) if o.peer_id != self.me] + [Offer(self.me, NAME, *r) for r in mine]
            _, gaps = plan(n, others)
            for lo, hi in gaps:
                pid = self.pick_helper({self.me}, self.slice_gb(model, lo, hi))
                if not pid:
                    errors.append(f"layers {lo}–{hi - 1} have no peer, and no other connected machine has room to serve them")
                    continue
                threads.append(threading.Thread(target=self._try, args=(errors, self.net._name(pid),
                                                                         self.remote_load, pid, model, lo, hi),
                                                daemon=True))
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
            if p["peer_id"] in exclude or not self.allows(p["peer_id"]) or link.get("state") != "direct":
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
        ask that direct peer to serve it instead. Progress arrives as `load_progress` events.
        Here only: `replace` makes it a resize (the model's other slices go once it's loaded), and
        `trim` then deletes the model's layers outside what's served from disk."""
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
            replace, trim = bool(b.get("replace")), bool(b.get("trim"))
            fn, who, fargs = (lambda *a: self._load_local(*a, replace=replace)), "serve", (model, lo, hi)
        errors: list[str] = []

        def go():
            self._try(errors, who, fn, *fargs)
            if errors:
                self.emit("error", message=errors[0])
            elif not b.get("peer") and trim:
                self._try(errors, "trim", self._trim, model)
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

    # ---- catalog: find, download and delete models ----
    async def catalog_search(self, request):
        q = request.query.get("q", "").strip()
        try:
            results = await asyncio.to_thread(catalog.search, q)
        except Exception as e:
            return web.json_response({"error": f"Hugging Face search failed: {e}"}, status=502)
        return web.json_response({"results": results})

    async def catalog_info(self, request):
        """Size and layer count of a repo, plus a suggested slice for this Mac."""
        repo = request.query.get("repo", "").strip()
        if "/" not in repo:
            return web.json_response({"error": "expected owner/name"}, status=400)
        try:
            inf = await asyncio.to_thread(catalog.info, repo)
        except Exception as e:
            return web.json_response({"error": f"couldn't read {repo}: {e}"}, status=502)
        self._n_layers.setdefault(repo, inf["n_layers"])
        m = next((m for m in self.models() if m["model"] == repo), None)
        have = [[s.lo, s.hi] for s in self.slices.items.values() if s.model == repo]
        # Room for this model: free for models (video encoder layers keep theirs), plus what its served
        # slices hold, since a resize swaps them out. room_gb is that less the load headroom.
        free = self.free_for_models() + sum(self.slice_gb(repo, s.lo, s.hi) for s in self.slices.loaded(repo))
        # Only suggest layers no online peer serves or is loading, so we don't duplicate their work.
        n = inf["n_layers"]
        taken = [c > 0 for c in m["online_coverage"]] if m else [False] * n
        for p in self.peers:
            for sl in self.peer_slices(p):
                if sl.get("model") == repo:
                    for i in range(max(int(sl["lo"]), 0), min(int(sl["hi"]), n)):
                        taken[i] = True
        for lo, hi in have:
            for i in range(lo, min(hi, n)):
                taken[i] = True
        free_gaps = catalog._runs([i for i, t in enumerate(taken) if not t]) if m else []
        inf["suggest"] = catalog.suggest(n, inf["layer_bytes"], free, free_gaps, have,
                                           in_swarm=bool(m and m["state"] != "offline"))
        inf["swarm"] = m
        inf["mem_free_gb"] = round(free, 1)
        inf["room_gb"] = round(max(free - MEM_HEADROOM_GB, 0.0), 2)
        return web.json_response(inf)

    async def catalog_local(self, _):
        known = [self.repo, *{s.model for s in self.slices.items.values()}]
        items = await asyncio.to_thread(catalog.local, known)
        slices = list(self.slices.items.values())
        for it in items:  # serving = loaded; anything still on its way is downloading, not serving
            it["serving"] = [[s.lo, s.hi] for s in slices if s.model == it["repo"] and s.shard is not None]
            it["downloading"] = [{"lo": s.lo, "hi": s.hi, "phase": s.phase, "done": s.done, "total": s.total}
                                 for s in slices if s.model == it["repo"] and s.shard is None]
        return web.json_response({"models": items})

    def _trim(self, model: str, keep: list[tuple[int, int]] = ()) -> int:
        """Delete `model` layers from disk outside `keep` and every slice served or on its way here."""
        ranges = [*keep, *((s.lo, s.hi) for s in self.slices.items.values() if s.model == model)]
        freed = catalog.trim(self.model_dir(model), ranges)
        self.emit("disk", model=model, freed=freed)
        return freed

    async def catalog_trim(self, request):
        """Delete {repo}'s layers outside [lo, hi) from disk; layers being served are always kept."""
        b = await request.json()
        args = self._slice_args({**b, "model": b.get("repo")})
        if isinstance(args, str):
            return web.json_response({"error": args}, status=400)
        model, lo, hi = args
        try:
            freed = await asyncio.to_thread(self._trim, model, [(lo, hi)])
        except (OSError, ValueError) as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"ok": True, "freed": freed})

    async def catalog_delete(self, request):
        """Stop serving a model and remove its files from this Mac."""
        b = await request.json()
        repo, d = str(b.get("repo") or ""), str(b.get("dir") or "")
        if repo and any(s.model == repo for s in self.slices.items.values()):
            await asyncio.to_thread(self._unserve_local, repo)
            # A cancelled download stops at its next chunk; wait for it before removing the folder.
            await asyncio.to_thread(self.slices.wait_idle, 60)
        try:
            await asyncio.to_thread(catalog.delete, d)
        except (ValueError, OSError) as e:
            return web.json_response({"error": str(e)}, status=400)
        self._n_layers.pop(repo, None) if repo != self.repo else None
        return web.json_response({"ok": True})

    async def models_api(self, _):
        return web.json_response({"models": self.models(), "mem_free_gb": round(self.free_for_models(), 1),
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
            "mem_free_gb": round(self.free_for_models(), 1), "heads": sorted(self.heads),
            "head_loaded": self.repo in self.heads, "route": [[h.name, h.lo, h.hi] for h in hops], "gaps": gaps,
            "links": {self.net._name(k): {kk: v[kk] for kk in ("state", "rtt_ms", "via", "addr", "error")}
                      for k, v in self.net.snapshot().items()},
            "served": s.served, "tokens": s.tokens, "active_requests": len(s.caches),
            "pod": pod_summary(self.pod)})

    # ---- pod API (the Pod tab) ----
    def pod_view(self) -> dict:
        """This machine's pod for the UI: the roster summary plus each member's live state."""
        r = self.pod
        if not r:
            return {"pod": None, "me": self.me, "name": NAME}
        recs = {p["peer_id"]: p for p in self.peers}
        links = self.net.snapshot()
        members = []
        for m in r["members"]:
            rec, link = recs.get(m["peer_id"], {}), links.get(m["peer_id"]) or {}
            me = m["peer_id"] == self.me
            slices = self.slices.slices() if me else self.peer_slices({**rec, "link": link})
            members.append({**m, "me": me, "online": me or bool(rec), "state": "you" if me else link.get("state", "offline"), "via": link.get("via", ""),
                            "rtt_ms": link.get("rtt_ms"), "chip": CHIP if me else rec.get("chip"),
                            "mem_total_gb": round(mem_total_gb(), 1) if me else rec.get("mem_total_gb"),
                            "slices": [{k: x.get(k) for k in ("model", "lo", "hi", "loaded")} for x in slices]})
        owner = pod.owner_id(r)
        return {"pod": pod_summary(r), "me": self.me, "name": NAME, "owner": owner == self.me, "members": members,
                "invites": pod.pending_invites(r["pod_id"]) if owner == self.me else 0,
                "heads": [p["model"] for p in r["plans"] if p["head"] == self.me]}

    def _owner_or_error(self):
        if not self.pod:
            return web.json_response({"error": "this machine is in no pod"}, status=409)
        if pod.owner_id(self.pod) != self.me:
            return web.json_response({"error": "only the pod's owner can change it"}, status=403)
        return None

    async def pod_get(self, _):
        return web.json_response(self.pod_view())

    async def pod_create(self, request):
        b = await request.json()
        name, kind = str(b.get("name") or "").strip(), b.get("kind", "private")
        if not name:
            return web.json_response({"error": "give the pod a name"}, status=400)
        try:
            r = pod.new_pod(self.ident, name[:64], NAME, kind=kind)
        except pod.RosterError as e:
            return web.json_response({"error": str(e)}, status=400)
        self._save_pod(r)
        return web.json_response(self.pod_view())

    async def pod_invite(self, _):
        if err := self._owner_or_error():
            return err
        if self.pod["kind"] == "alone":
            return web.json_response({"error": "an alone pod has no other machines"}, status=409)
        code, expires = pod.create_invite(self.pod["pod_id"])
        return web.json_response({"code": code, "expires": expires})

    async def pod_join(self, request):
        b = await request.json()
        try:
            pod_id, secret = pod.parse_invite(str(b.get("code") or ""))
        except pod.RosterError:
            return web.json_response({"error": "that isn't a pod invite code"}, status=400)
        proof = pod.invite_proof(secret, pod_id, self.ident.public.hex())
        try:
            r = await join_pod(self.ident, pod_id, proof, NAME)
        except (RoomError, aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
            return web.json_response({"error": f"couldn't join: {e}"}, status=409)
        if pod.newer(None, r) is None or r["pod_id"] != pod_id or not pod.is_member(r, self.me):
            return web.json_response({"error": "the pod sent a roster that doesn't check out"}, status=502)
        self._save_pod(r)
        return web.json_response(self.pod_view())

    async def pod_remove(self, request):
        if err := self._owner_or_error():
            return err
        pid = str((await request.json()).get("peer_id") or "")
        if pid == self.me or not pod.is_member(self.pod, pid):
            return web.json_response({"error": "not a machine the owner can remove"}, status=400)
        self._save_pod(pod.sign(pod.remove_member(self.pod, pid), self.ident))
        return web.json_response(self.pod_view())

    def auto_split(self, layers: int) -> list[tuple[str, int, int]]:
        """Every member's share of `layers`, in proportion to its memory (this machine first)."""
        view = {m["peer_id"]: m.get("mem_total_gb") or 0 for m in self.pod_view()["members"]}
        ids = [self.me] + [p for p in view if p != self.me]
        mem = [max(view.get(p) or 0, 1) for p in ids]
        hops, at, cum, n = [], 0, 0, len(ids)
        for i, p in enumerate(ids):
            cum += mem[i]
            hi = layers if i == n - 1 else min(max(round(layers * cum / sum(mem)), at + 1), layers - (n - 1 - i))
            hops.append((p, at, hi))
            at = hi
        return hops

    async def pod_plan(self, request):
        if err := self._owner_or_error():
            return err
        b = await request.json()
        model = str(b.get("model") or self.repo)
        layers = int(b.get("layers") or self.layers_of(model) or 0)
        if layers <= 0:
            return web.json_response({"error": f"unknown layer count for {model}"}, status=400)
        try:
            hops = ([(str(h["peer"]), int(h["lo"]), int(h["hi"])) for h in b["hops"]] if b.get("hops")
                    else self.auto_split(layers))
            head = str(b.get("head") or hops[0][0])
            r = pod.verify(pod.sign(pod.set_plan(self.pod, model, layers, head, hops), self.ident))
        except (KeyError, TypeError, ValueError) as e:
            return web.json_response({"error": str(e)}, status=400)
        self._save_pod(r)
        return web.json_response(self.pod_view())

    async def pod_unplan(self, request):
        if err := self._owner_or_error():
            return err
        model = str((await request.json()).get("model") or "")
        self._save_pod(pod.sign(pod.revise(self.pod, plans=[p for p in self.pod["plans"] if p["model"] != model]), self.ident))
        return web.json_response(self.pod_view())

    async def pod_leave(self, _):
        """A member leaves (the owner signs it out); the owner disbands the pod: a last roster with only
        itself sends every other machine back to the public swarm."""
        if self.pod and self.swarm:
            if pod.owner_id(self.pod) != self.me:
                await self.swarm.send({"type": "leave"})
            elif len(self.pod["members"]) > 1:
                me = [m for m in self.pod["members"] if m["peer_id"] == self.me]
                await self.swarm.send({"type": "roster", "roster": pod.sign(pod.revise(self.pod, members=me, plans=[]), self.ident)})
        self._forget_pod()
        return web.json_response(self.pod_view())

    async def shutdown(self, _):
        self.video.stop()  # os._exit would orphan ComfyUI
        asyncio.get_running_loop().call_later(0.3, os._exit, 0)
        return web.json_response({"ok": True})

    async def index(self, _):
        return web.FileResponse(STATIC / "index.html")

    async def housekeeping(self):
        while True:
            await asyncio.sleep(2)
            self.slices.evict_idle()
            self.reload_pod()
            self.apply_plan()
            self.self_events()
            openai_api.write_network_manifest(self, home())


def run_peer(repo: str, model_dir, n_layers: int | None, port: int, serve: list[tuple[str | None, int, int]] | None,
             open_browser: bool = False):
    """`serve`: slices to load at start as (model or None for `repo`, lo, hi); default: the saved config."""
    import socket
    with socket.socket() as probe:  # fail fast, before loading any model
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            raise SystemExit(f"port {port} is already in use by another program; "
                             f"pick a free one with --port or PODTORRENT_PORT")
    app_state = PeerApp(repo, Path(model_dir), n_layers)
    app_state.video = VideoService(app_state.emit, NAME)
    if serve:
        serve = [(m or repo, lo, hi) for m, lo, hi in serve]
    else:
        serve = [(c.get("model") or repo, int(c["lo"]), int(c["hi"])) for c in configured_slices()]
    app = web.Application(middlewares=[cors], client_max_size=16 << 20)
    app.add_routes([web.get("/", app_state.index), web.get("/ws", app_state.ws), web.get("/status", app_state.status),
                    web.get("/api/models", app_state.models_api),
                    web.get("/api/catalog/search", app_state.catalog_search),
                    web.get("/api/catalog/info", app_state.catalog_info),
                    web.get("/api/catalog/local", app_state.catalog_local),
                    web.post("/api/catalog/delete", app_state.catalog_delete),
                    web.post("/api/catalog/trim", app_state.catalog_trim),
                    web.post("/api/start", app_state.start), web.post("/api/serve", app_state.serve),
                    web.post("/api/unserve", app_state.unserve),
                    web.post("/api/chat", app_state.chat), web.post("/api/complete", app_state.complete),
                    web.post("/api/shutdown", app_state.shutdown),
                    web.get("/api/pod", app_state.pod_get), web.post("/api/pod/create", app_state.pod_create),
                    web.post("/api/pod/invite", app_state.pod_invite), web.post("/api/pod/join", app_state.pod_join),
                    web.post("/api/pod/remove", app_state.pod_remove), web.post("/api/pod/plan", app_state.pod_plan),
                    web.post("/api/pod/unplan", app_state.pod_unplan), web.post("/api/pod/leave", app_state.pod_leave)])
    enc = EncoderNode(app_state.emit)
    enc.renders = lambda: app_state.video.gpu.get("vram_gb", 0) >= MIN_VRAM_GB  # a video machine, set up or not
    # Text-model slices and video encoder layers share one memory budget (unless the encoder runs on the CPU).
    enc.text_gb = app_state.slices.held_gb
    if B.NAME == "torch" and B.CUDA:  # text layers on this GPU pause rendering (see VideoService.paused)
        app_state.video.gpu_text_gb = app_state.slices.held_gb
    app_state.video_swarm = VideoSwarm(app_state.net, app_state.video, enc, app_state.me)

    def node_info():
        ni = app_state.slices.info()
        ni.roles.extend(app_state.video_swarm.roles())
        return ni
    app_state.net.info = node_info
    app.add_routes(openai_api.routes(app_state))
    app.add_routes(video_api.routes(app_state.video, enc, app_state.video_swarm))
    app.on_cleanup.append(lambda _: asyncio.to_thread(app_state.video.stop))

    def load_all():  # one at a time: each slice's memory check sees the ones before it
        for m, lo, hi in serve:
            app_state._try([], "serve", app_state._load_local, m, lo, hi)

    async def on_start(a):
        app_state.loop = asyncio.get_running_loop()
        await app_state.net.start()
        app_state.swarm = SwarmClient(app_state.ident, app_state.swarm_record, app_state.on_swarm, net=app_state.net,
                                      room=lambda: app_state.pod, on_roster=app_state.on_roster,
                                      on_owner_request=app_state.on_owner_request,
                                      supply=app_state.supply, on_dissolved=app_state.on_dissolved)
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
    # A download in progress runs in worker threads that Python would join at exit, so quitting would wait for
    # the whole download. on_cleanup has already stopped the video engine; nothing else needs a clean exit.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
