"""Route planning: which peers run which layers for one generation. Pure functions, no I/O.

Phase 3 plans greedily (furthest reach first, then lowest RTT); phase 4 swaps in a shortest-path
search with the same interface."""
from dataclasses import dataclass


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


def plan(n_layers: int, offers: list[Offer]) -> tuple[list[Hop], list[tuple[int, int]]]:
    """Hops covering [0, n_layers) exactly once, or ([], gaps) when some layers have no peer.
    Any sub-range of an offered slice can be used, so overlapping slices are fine."""
    hops: list[Hop] = []
    at = 0
    while at < n_layers:
        here = [o for o in offers if o.lo <= at < o.hi]
        if not here:
            return [], gaps(n_layers, offers)
        best = max(here, key=lambda o: (min(o.hi, n_layers), -o.rtt_ms))
        hi = min(best.hi, n_layers)
        hops.append(Hop(best.peer_id, best.name, at, hi))
        at = hi
    return hops, []


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
