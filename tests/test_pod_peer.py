"""The peer runtime inside a pod: who it routes through, lends to and loads for (no model, no network)."""
import asyncio
import json
import os
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from podtorrent import pipeline_pb2 as pb
from podtorrent import pod
from podtorrent.net import identity
from podtorrent.net.identity import Identity
from podtorrent.net.quic import _read_frame

MODEL = "example/model"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("PODTORRENT_HOME", str(tmp_path))
    identity.load_identity.cache_clear()
    from podtorrent.peer import PeerApp
    a = PeerApp(MODEL, tmp_path / "model", 48)
    yield a
    identity.load_identity.cache_clear()


def machine() -> Identity:
    return Identity(Ed25519PrivateKey.generate())


def peer(ident: Identity, name: str, lo: int, hi: int, free: float = 64.0) -> dict:
    return {"peer_id": ident.peer_id, "name": name,
            "link": {"state": "direct", "rtt_ms": 5.0,
                     "info": {"mem_free_gb": free, "slices": [{"model": MODEL, "lo": lo, "hi": hi, "loaded": True}]}}}


def join(app, owner: Identity | None = None, members=(), plan=None):
    """Put `app` in a pod owned by `owner` (default: app itself) with `members`, and reload it."""
    me = app.ident
    owner = owner or me
    r = pod.new_pod(owner, "home", "owner")
    for ident, name in [(me, "me"), *members]:
        r = pod.sign(pod.add_member(r, pod.member(ident, name)), owner)
    if plan:
        r = pod.sign(pod.set_plan(r, MODEL, 48, plan[0][0], plan), owner)
    pod.save_roster(r)
    os.utime(pod.roster_path(), (1, 1))   # a new mtime even within the same clock tick
    app.reload_pod()
    return r


def test_no_pod_routes_through_anyone(app):
    stranger = machine()
    app.peers = [peer(stranger, "stranger", 0, 48)]
    assert app.allows(stranger.peer_id)
    assert [h.name for h in app.route(MODEL)[0]] == ["stranger"]


def test_pod_ignores_strangers_even_when_linked(app):
    mate, stranger = machine(), machine()
    join(app, members=[(mate, "mate")])
    app.peers = [peer(stranger, "stranger", 0, 48), peer(mate, "mate", 24, 48)]
    assert not app.allows(stranger.peer_id) and app.allows(mate.peer_id)
    hops, gaps = app.route(MODEL)
    assert hops == [] and gaps == [(0, 24)]                     # the stranger's [0,24) doesn't count
    assert app.pick_helper({app.me}) == mate.peer_id            # and it's never asked to help
    assert all(o.peer_id != stranger.peer_id for o in app.offers(MODEL, reachable=False))


def test_alone_links_with_nobody(app):
    r = pod.new_pod(app.ident, "solo", "me", kind="alone")
    pod.save_roster(r)
    app.reload_pod()
    assert app.pod["kind"] == "alone" and not app.allows(machine().peer_id)


def test_apply_plan_loads_only_the_head(app, monkeypatch):
    mate = machine()
    loads, heads = [], []
    monkeypatch.setattr(app, "_load_local", lambda m, lo, hi, *_: loads.append((m, lo, hi)))
    monkeypatch.setattr(app, "ensure_head", lambda m: heads.append(m))
    join(app, members=[(mate, "mate")], plan=[(app.me, 0, 24), (mate.peer_id, 24, 48)])
    app.apply_plan()
    for _ in range(50):
        if heads:
            break
        time.sleep(0.01)
    assert loads == [] and heads == [MODEL]                     # layers come from the Models tab
    app.apply_plan()                                            # not again until PLAN_RETRY_S passes
    assert heads == [MODEL]


def test_removed_member_is_dropped(app, monkeypatch):
    mate = machine()
    owner = app.ident
    r = join(app, members=[(mate, "mate")])
    pruned = []
    monkeypatch.setattr(app.net, "prune", lambda: pruned.append(app.allows(mate.peer_id)))
    pod.save_roster(pod.sign(pod.remove_member(r, mate.peer_id), owner))
    os.utime(pod.roster_path(), (2, 2))
    app.reload_pod()
    assert pruned == [False] and app.pod["version"] == r["version"] + 1


def test_tampered_roster_means_no_pod(app):
    mate = machine()
    join(app, members=[(mate, "mate")])
    r = pod.load_roster()
    pod.roster_path().write_text(json.dumps({**r, "name": "edited"}))
    os.utime(pod.roster_path(), (3, 3))
    app.reload_pod()
    assert app.pod is None


def test_load_requests_only_from_the_owner(app):
    owner, other = machine(), machine()
    join(app, owner=owner, members=[(other, "other")])

    class Conn:
        def __init__(self, pid):
            self.peer_id = pid

    class Writer:
        def __init__(self):
            self.data = b""

        def write(self, b):
            self.data += b

    async def ask(pid):
        w = Writer()
        body = pb.LoadRequest(repo=MODEL, layer_lo=0, layer_hi=8).SerializeToString()
        await asyncio.wait_for(app._serve_load(Conn(pid), body, None, w), 5)
        r = asyncio.StreamReader()
        r.feed_data(w.data)
        r.feed_eof()
        return pb.LoadProgress.FromString(await _read_frame(r))

    refused = asyncio.run(ask(other.peer_id))   # a member, but not the owner
    assert refused.phase == "error" and "owner" in refused.message


def test_owner_admits_a_valid_invite_once(app, monkeypatch):
    sent = []
    monkeypatch.setattr(app, "_room_send", sent.append)
    app._save_pod(pod.new_pod(app.ident, "home", "me"))
    code, _ = pod.create_invite(app.pod["pod_id"])
    pod_id, secret = pod.parse_invite(code)
    joiner = machine()
    req = {"type": "join_request", "from": joiner.peer_id, "pubkey": joiner.public.hex(), "name": "air",
           "proof": pod.invite_proof(secret, pod_id, joiner.public.hex())}
    app.on_owner_request(req)
    assert pod.is_member(app.pod, joiner.peer_id) and sent[-1]["type"] == "roster"
    other = machine()
    app.on_owner_request({**req, "from": other.peer_id, "pubkey": other.public.hex(),
                          "proof": pod.invite_proof(secret, pod_id, other.public.hex())})   # used up
    assert not pod.is_member(app.pod, other.peer_id) and sent[-1]["type"] == "join_failed"
    app.on_owner_request({"type": "leave_request", "from": joiner.peer_id})
    assert not pod.is_member(app.pod, joiner.peer_id)


def test_member_adopts_newer_rosters_and_leaves_when_removed(app):
    owner = machine()
    r = join(app, owner=owner)
    later = pod.sign(pod.revise(r, name="renamed"), owner)
    app.on_roster(later)
    assert app.pod["name"] == "renamed" and pod.load_roster()["version"] == later["version"]
    app.on_roster(r)                                            # an older one is ignored
    assert app.pod["name"] == "renamed"
    app.on_roster(pod.sign(pod.remove_member(later, app.me), owner))
    assert app.pod is None and pod.load_roster() is None        # back in the public swarm


def test_auto_split_is_proportional(app, monkeypatch):
    big, small = machine(), machine()
    join(app, members=[(big, "big"), (small, "small")])
    mem = {app.me: 32, big.peer_id: 64, small.peer_id: 32}
    monkeypatch.setattr(app, "pod_view", lambda: {"members": [{"peer_id": p, "mem_total_gb": g} for p, g in mem.items()]})
    assert app.auto_split(48) == [(app.me, 0, 12), (big.peer_id, 12, 36), (small.peer_id, 36, 48)]
