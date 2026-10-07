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
