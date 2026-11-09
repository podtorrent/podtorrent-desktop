"""Pod rosters: signing, verification, revisions and invites, plus the shared cross-port vectors."""
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from podtorrent import pod
from podtorrent.net.identity import Identity

from pod_vectors import NOW, OUT, build

MODEL = "mlx-community/Qwen3-30B-A3B-4bit"


def machine() -> Identity:
    return Identity(Ed25519PrivateKey.generate())


@pytest.fixture
def two():
    owner, laptop = machine(), machine()
    r = pod.new_pod(owner, "home", "studio")
    r = pod.sign(pod.add_member(r, pod.member(laptop, "air")), owner)
    return owner, laptop, r


def code(fn, *a, **kw):
    with pytest.raises(pod.RosterError) as e:
        fn(*a, **kw)
    return e.value.code


def test_vectors_file_is_current():
    assert json.loads(OUT.read_text()) == json.loads(json.dumps(build(), ensure_ascii=False))


def test_vectors_verdicts():
    v = json.loads(OUT.read_text())
    for c in v["canonical"]:
        assert pod.canonical(c["value"]).decode() == c["utf8"]
    for c in v["rosters"]:
        kw = {"now": v["now"], "matchmakers": tuple(v["matchmakers"])}
        if c["error"] is None:
            pod.verify(c["roster"], **kw)
        else:
            assert code(pod.verify, c["roster"], **kw) == c["error"], c["case"]
    for i in v["invites"]:
        assert pod.parse_invite(i["code"]) == (i["pod_id"], i["secret"])
        assert pod.check_proof(i["secret"], i["pod_id"], i["pubkey"], i["proof"])


def test_new_pod_is_valid_and_owned():
    owner = machine()
    r = pod.verify(pod.new_pod(owner, "home", "studio"))
    assert r["version"] == 1 and pod.is_member(r, owner.peer_id) and r["kind"] == "private"


def test_owner_cannot_make_public_pod():
    assert code(pod.new_pod, machine(), "x", "y", kind="public") == "bad-kind"


def test_plan_50_50(two):
    owner, laptop, r = two
    r = pod.verify(pod.sign(pod.set_plan(r, MODEL, 48, owner.peer_id,
                                         [(owner.peer_id, 0, 24), (laptop.peer_id, 24, 48)]), owner))
    assert r["version"] == 3 and [h["hi"] for h in r["plans"][0]["hops"]] == [24, 48]


def test_plan_must_cover_every_layer_once(two):
    owner, laptop, r = two
    overlap = pod.set_plan(r, MODEL, 48, owner.peer_id, [(owner.peer_id, 0, 30), (laptop.peer_id, 24, 48)])
    short = pod.set_plan(r, MODEL, 48, owner.peer_id, [(owner.peer_id, 0, 24), (laptop.peer_id, 24, 40)])
    assert code(pod.verify, pod.sign(overlap, owner)) == "bad-plan"
    assert code(pod.verify, pod.sign(short, owner)) == "bad-plan"


def test_only_the_owner_can_sign(two):
    _, laptop, r = two
    assert code(pod.verify, pod.sign(pod.add_member(r, pod.member(machine(), "x")), laptop)) == "pod-id-mismatch"


def test_remove_member_drops_its_plans(two):
    owner, laptop, r = two
    r = pod.sign(pod.set_plan(r, MODEL, 48, owner.peer_id, [(owner.peer_id, 0, 24), (laptop.peer_id, 24, 48)]), owner)
    r = pod.verify(pod.sign(pod.remove_member(r, laptop.peer_id), owner))
    assert not pod.is_member(r, laptop.peer_id) and r["plans"] == []


def test_newer_takes_only_higher_valid_versions(two):
    owner, laptop, r = two
    later = pod.sign(pod.remove_member(r, laptop.peer_id), owner)
    assert pod.newer(r, later) is later
    assert pod.newer(later, r) is None                       # rollback
    assert pod.newer(r, {**later, "name": "evil"}) is None   # tampered
    other = pod.new_pod(owner, "other", "studio")
    assert pod.newer(r, pod.sign(pod.revise(other, version=99), owner)) is None  # another pod


def test_public_roster_expires():
    mm, a = machine(), machine()
    salt = "11" * 16
    r = pod.sign({"pod_id": pod.pod_id_of(mm.public.hex(), salt), "salt": salt, "kind": "public", "name": "pub",
                  "version": 1, "signer": "", "members": [pod.member(a, "a")], "plans": [], "expires": NOW},
                 mm)
    keys = (mm.public.hex(),)
    pod.verify(r, now=NOW - 1, matchmakers=keys)
    assert code(pod.verify, r, now=NOW, matchmakers=keys) == "expired"
    assert code(pod.verify, r, now=NOW - 1) == "untrusted-signer"  # no matchmaker configured


def test_invite_roundtrip_bound_to_the_joiner():
    pod_id = "ab" * 16
    invite, secret = pod.new_invite(pod_id)
    assert pod.parse_invite(invite) == (pod_id, secret)
    joiner, other = machine(), machine()
    proof = pod.invite_proof(secret, pod_id, joiner.public.hex())
    assert pod.check_proof(secret, pod_id, joiner.public.hex(), proof)
    assert not pod.check_proof(secret, pod_id, other.public.hex(), proof)
    assert code(pod.parse_invite, "pod1-xyz-abc") == "bad-invite"


def test_canonical_refuses_floats():
    assert code(pod.canonical, {"price": 0.5}) == "bad-value"


def test_save_and_load(tmp_path, two):
    _, _, r = two
    pod.save_roster(r, tmp_path / "pod.json")
    assert pod.load_roster(tmp_path / "pod.json") == r
    (tmp_path / "pod.json").write_text(json.dumps({**r, "name": "edited"}))
    assert pod.load_roster(tmp_path / "pod.json") is None
