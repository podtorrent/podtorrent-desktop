"""Route planning: which peers run which layers for one generation. Pure functions, no I/O.

A shortest-path search (Dijkstra) over layer boundaries 0..n. An edge `lo → hi` exists when an
offer covers [lo, hi); its cost is that peer's RTT (zero for this Mac) plus an estimated compute
time per layer. Any sub-range of an offered slice can be used, so overlapping slices are fine,
and fewer, closer hops win."""
import heapq
from dataclasses import dataclass

LAYER_MS = 1.0  # rough per-layer compute estimate per token; keeps ties from preferring needless splits


@dataclass(frozen=True)
class Offer:
    """A peer serving `model` layers [lo, hi), reachable with this RTT (0 for this Mac)."""
    peer_id: str
    name: str
    lo: int
    hi: int
    rtt_ms: float = 0.0


@dataclass(frozen=True)
class Hop:
    peer_id: str
    name: str
    lo: int
    hi: int


def plan(n_layers: int, offers: list[Offer], exclude: frozenset[str] | set[str] = frozenset(),
         layer_ms: float = LAYER_MS) -> tuple[list[Hop], list[tuple[int, int]]]:
    """Cheapest hops covering [0, n_layers) exactly once, or ([], gaps) when some layers have no peer.
    Peers in `exclude` (e.g. ones that just failed) are ignored."""
    offers = [o for o in offers if o.peer_id not in exclude and o.lo < o.hi]
    if n_layers <= 0:
        return [], []
    # Only boundaries where some slice starts or ends (plus 0 and n) matter: from any boundary b, an
    # offer covering b can jump to its own end; jumping to an interior point never beats that except
    # to hand off to another offer, whose start is itself a boundary.
    points = sorted({0, n_layers} | {min(max(x, 0), n_layers) for o in offers for x in (o.lo, o.hi)})
    best: dict[int, tuple[float, int]] = {0: (0.0, 0)}  # boundary -> (cost, hop count)
    prev: dict[int, tuple[int, Offer]] = {}
    heap = [(0.0, 0, 0)]
    done = set()
    while heap:
        cost, hops, at = heapq.heappop(heap)
        if at in done:
            continue
        done.add(at)
        if at == n_layers:
            break
        for o in offers:
            if not (o.lo <= at < o.hi):
                continue
            end = min(o.hi, n_layers)
            for to in points:
                if to <= at or to > end:
                    continue
                c = cost + o.rtt_ms + layer_ms * (to - at)
                key = (c, hops + 1)
                if to not in best or key < best[to] or (key == best[to] and o.peer_id < prev[to][1].peer_id):
                    best[to] = key
                    prev[to] = (at, o)
                    heapq.heappush(heap, (c, hops + 1, to))
    if n_layers not in prev:
        return [], gaps(n_layers, offers)
    out, at = [], n_layers
    while at:
        lo, o = prev[at]
        out.append(Hop(o.peer_id, o.name, lo, at))
        at = lo
    out.reverse()
    return merge(out), []


def merge(hops: list[Hop]) -> list[Hop]:
    """Join consecutive hops on the same peer into one."""
    out: list[Hop] = []
    for h in hops:
        if out and out[-1].peer_id == h.peer_id and out[-1].hi == h.lo:
            out[-1] = Hop(h.peer_id, h.name, out[-1].lo, h.hi)
        else:
            out.append(h)
    return out


def gaps(n_layers: int, offers: list[Offer]) -> list[tuple[int, int]]:
    covered = [False] * n_layers
    for o in offers:
        for i in range(max(o.lo, 0), min(o.hi, n_layers)):
            covered[i] = True
    out, start = [], None
    for i, c in enumerate(covered + [True]):
        if not c and start is None:
            start = i
        elif c and start is not None:
            out.append((start, i))
            start = None
    return out


def coverage(n_layers: int, offers: list[Offer]) -> list[int]:
    """How many distinct peers serve each layer."""
    peers: list[set[str]] = [set() for _ in range(max(n_layers, 0))]
    for o in offers:
        for i in range(max(o.lo, 0), min(o.hi, n_layers)):
            peers[i].add(o.peer_id)
    return [len(p) for p in peers]


# ---------- video (MiniMax-H3) routes from peer roles ----------
# Roles a peer advertises in NodeInfo.roles:
#   h3-encoder:LO:HI         encoder layers [LO, HI) on disk; a hop must run a slice whole (it's one file)
#   h3-video[:VRAM:RAM]      can render; GPU memory and system RAM in GB (missing on older peers: trusted)
VIDEO_MIN_VRAM_GB = 11.0    # a "12 GB" card reports ~11.9
VIDEO_MIN_RAM_GB = 31.0
HOP_MS = 50.0               # each encoder hop also moves the hidden state; keeps routes short


@dataclass(frozen=True)
class VideoOffer:
    """A peer's video roles, reachable with this RTT (0 for this machine)."""
    peer_id: str
    name: str
    roles: tuple[str, ...]
    rtt_ms: float = 0.0


def parse_role(role: str) -> tuple | None:
    """("encoder", lo, hi), ("video", vram_gb | None, ram_gb | None), or None for anything else."""
    p = role.split(":")
    try:
        if p[0] == "h3-encoder" and len(p) == 3 and 0 <= int(p[1]) < int(p[2]):
            return "encoder", int(p[1]), int(p[2])
        if p[0] == "h3-video" and len(p) in (1, 3):
            return ("video", None, None) if len(p) == 1 else ("video", float(p[1]), float(p[2]))
    except ValueError:
        pass
    return None


def video_role(vram_gb: float, ram_gb: float) -> str:
    return f"h3-video:{vram_gb:g}:{ram_gb:g}"


def can_render(offer: VideoOffer) -> str | None:
    """Why this peer can't take the video stage, or None if it can."""
    vids = [r for x in offer.roles if (r := parse_role(x)) and r[0] == "video"]
    if not vids:
        return "doesn't render video"
    _, vram, ram = vids[0]
    if vram is not None and vram < VIDEO_MIN_VRAM_GB:
        return f"has {vram:g} GB of GPU memory (video needs 12 GB)"
    if ram is not None and ram < VIDEO_MIN_RAM_GB:
        return f"has {ram:g} GB of RAM (video needs 32 GB)"
    return None


def plan_video(n_layers: int, offers: list[VideoOffer], me: str,
               exclude: frozenset[str] | set[str] = frozenset()) -> tuple[list[Hop], str]:
    """Encoder hops covering [0, n_layers) and the peer that renders.

    Hops run whole slices, chained end to start; the cheapest chain wins (each hop costs HOP_MS plus
    its RTT, so fewer, closer hops; ties go to this machine). The renderer is this machine if it can,
    else the closest capable peer. Raises ValueError saying what's missing."""
    offers = [o for o in offers if o.peer_id not in exclude]
    rtt = lambda o: 0.0 if o.peer_id == me else o.rtt_ms  # noqa: E731
    edges = sorted(((s[1], min(s[2], n_layers), o) for o in offers for x in o.roles
                    if (s := parse_role(x)) and s[0] == "encoder" and s[1] < n_layers),
                   key=lambda e: (e[0], e[1], e[2].peer_id))
    best: dict[int, tuple[float, int, int]] = {0: (0.0, 0, 0)}  # boundary -> (cost, hops, remote hops)
    prev: dict[int, tuple[int, VideoOffer]] = {}
    heap, done = [(0.0, 0, 0, 0)], set()
    while heap:
        cost, hops, remote, at = heapq.heappop(heap)
        if at in done:
            continue
        done.add(at)
        for lo, hi, o in edges:
            if lo != at or hi <= at:
                continue
            key = (cost + HOP_MS + rtt(o), hops + 1, remote + (o.peer_id != me))
            if hi not in best or key < best[hi]:
                best[hi], prev[hi] = key, (at, o)
                heapq.heappush(heap, (*key, hi))
    if n_layers not in prev:
        reach = max(done)
        raise ValueError(f"No machine or peer has encoder layers starting at {reach}. "
                         "Download the missing layers on a machine in the Video view.")
    hops, at = [], n_layers
    while at:
        lo, o = prev[at]
        hops.append(Hop(o.peer_id, o.name, lo, at))
        at = lo
    hops.reverse()

    able = [o for o in offers if can_render(o) is None]
    if not able:
        why = [f"{o.name} {r}" for o in offers if (r := can_render(o)) != "doesn't render video"]
        raise ValueError("No machine or peer can render video yet (needs an NVIDIA GPU with 12 GB or more"
                         + (f"; {', '.join(why)}" if why else "") + ").")
    video = min(able, key=lambda o: (o.peer_id != me, rtt(o), o.name))
    return hops, video.peer_id
