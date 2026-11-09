"""Pods: the signed roster that says which machines serve together (docs/PODS_PLAN.md).

A roster lists a pod's members and, per model, the layer split and head. Its signer is the owner
machine (private pods, and alone: a pod of one) or a matchmaker (public pods). The canonical encoding
and signing input here are the wire format: the Swift peer must produce the same bytes, checked against
tests/pod_vectors.json.

Pure functions plus load/save; nothing here touches the network."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .net.identity import Identity, home, peer_id_of

KINDS = ("private", "public", "alone")
# Public halves of the matchmaker keys allowed to sign public rosters; empty until the matchmaker exists.
MATCHMAKERS: tuple[str, ...] = ()
INVITE_TTL_S = 24 * 3600
ROSTER_DOMAIN = b"podtorrent-roster|"
INVITE_DOMAIN = b"podtorrent-invite|"


class RosterError(ValueError):
    """`code` is stable across ports (see tests/pod_vectors.json); the message is for people."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code


def canonical(obj) -> bytes:
    """Sorted keys, no whitespace, UTF-8. Only str, int, bool, None, lists and dicts: floats encode
    differently across languages, so they are refused."""
    def check(x):
        if isinstance(x, float):
            raise RosterError("bad-value", "floats are not allowed")
        if isinstance(x, dict):
            for k, v in x.items():
                if not isinstance(k, str):
                    raise RosterError("bad-value", "keys must be strings")
                check(v)
        elif isinstance(x, list):
            for v in x:
                check(v)
        elif not (x is None or isinstance(x, (str, int))):
            raise RosterError("bad-value", f"unsupported {type(x).__name__}")
    check(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def signing_input(roster: dict) -> bytes:
    return ROSTER_DOMAIN + canonical({k: v for k, v in roster.items() if k != "sig"})


def pod_id_of(signer: str, salt: str) -> str:
    return hashlib.sha256(bytes.fromhex(signer) + bytes.fromhex(salt)).hexdigest()[:32]


def _pub_hex(ident: Identity) -> str:
    return ident.public.hex()


def member(ident_or_pubkey: Identity | str, name: str, public: bool = False) -> dict:
    pub = _pub_hex(ident_or_pubkey) if isinstance(ident_or_pubkey, Identity) else ident_or_pubkey
    m = {"peer_id": peer_id_of(bytes.fromhex(pub)), "pubkey": pub, "name": name}
    if public:
        m["public"] = True  # a public machine filling a private pod's gaps
    return m


def new_pod(owner: Identity, name: str, owner_name: str, kind: str = "private") -> dict:
    """A signed version-1 roster with the owner as its only member."""
    if kind not in ("private", "alone"):
        raise RosterError("bad-kind", "owners make private or alone pods; the matchmaker makes public ones")
    salt = secrets.token_hex(16)
    signer = _pub_hex(owner)
    roster = {"pod_id": pod_id_of(signer, salt), "salt": salt, "kind": kind, "name": name, "version": 1,
              "signer": signer, "members": [member(owner, owner_name)], "plans": [], "expires": 0}
    return sign(roster, owner)


def sign(roster: dict, signer: Identity) -> dict:
    out = {**roster, "signer": _pub_hex(signer)}
    out.pop("sig", None)
    out["sig"] = signer.key.sign(signing_input(out)).hex()
    return out


def revise(roster: dict, **changes) -> dict:
    """An unsigned copy one version newer, with `changes` applied; sign it before publishing."""
    out = {k: v for k, v in roster.items() if k != "sig"}
    out.update(changes)
    out["version"] = roster["version"] + 1
    return out


def add_member(roster: dict, m: dict) -> dict:
    if any(x["peer_id"] == m["peer_id"] for x in roster["members"]):
        return revise(roster)
    return revise(roster, members=[*roster["members"], m])


def remove_member(roster: dict, peer_id: str) -> dict:
    """Without `peer_id`, and without the plans it was part of (they need a new split)."""
    members = [m for m in roster["members"] if m["peer_id"] != peer_id]
    plans = [p for p in roster["plans"] if p["head"] != peer_id and all(h["peer"] != peer_id for h in p["hops"])]
    return revise(roster, members=members, plans=plans)


def set_plan(roster: dict, model: str, layers: int, head: str, hops: list[tuple[str, int, int]]) -> dict:
    plan = {"model": model, "layers": layers, "head": head,
            "hops": [{"peer": p, "lo": lo, "hi": hi} for p, lo, hi in hops]}
    return revise(roster, plans=[*(p for p in roster["plans"] if p["model"] != model), plan])


def _need(cond: bool, code: str, message: str = ""):
    if not cond:
        raise RosterError(code, message)


def _hex(x, n: int) -> bool:
    return isinstance(x, str) and len(x) == n and all(c in "0123456789abcdef" for c in x)


def _int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def verify(roster: dict, now: float | None = None, matchmakers: tuple[str, ...] | None = None) -> dict:
    """`roster` if it is well formed, signed by an allowed signer and not expired; else RosterError."""
    _need(isinstance(roster, dict), "bad-shape", "not an object")
    keys = {"pod_id", "salt", "kind", "name", "version", "signer", "members", "plans", "expires", "sig"}
    _need(set(roster) == keys, "bad-shape", f"fields must be {sorted(keys)}")
    _need(roster["kind"] in KINDS, "bad-kind", str(roster["kind"]))
    _need(isinstance(roster["name"], str) and 0 < len(roster["name"]) <= 64, "bad-shape", "name")
    _need(_int(roster["version"]) and roster["version"] >= 1, "bad-shape", "version")
    _need(_int(roster["expires"]) and roster["expires"] >= 0, "bad-shape", "expires")
    _need(_hex(roster["signer"], 64) and _hex(roster["salt"], 32) and _hex(roster["sig"], 128), "bad-shape", "hex fields")
    _need(roster["pod_id"] == pod_id_of(roster["signer"], roster["salt"]), "pod-id-mismatch")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(roster["signer"])).verify(
            bytes.fromhex(roster["sig"]), signing_input(roster))
    except (InvalidSignature, ValueError):
        raise RosterError("bad-signature") from None

    members = roster["members"]
    _need(isinstance(members, list) and members, "bad-members", "no members")
    ids = set()
    for m in members:
        _need(isinstance(m, dict) and set(m) - {"public"} == {"peer_id", "pubkey", "name"}, "bad-members", "member fields")
        _need(_hex(m["pubkey"], 64) and isinstance(m["name"], str) and m.get("public", True) is True, "bad-members", "member values")
        _need(m["peer_id"] == peer_id_of(bytes.fromhex(m["pubkey"])), "bad-members", f"peer_id of {m['name']}")
        _need(m["peer_id"] not in ids, "bad-members", f"{m['name']} listed twice")
        ids.add(m["peer_id"])

    signer_id = peer_id_of(bytes.fromhex(roster["signer"]))
    if roster["kind"] == "public":
        allowed = MATCHMAKERS if matchmakers is None else matchmakers
        _need(roster["signer"] in allowed, "untrusted-signer", "not a matchmaker")
        _need(roster["expires"] > 0, "bad-shape", "a public roster must expire")
    else:
        _need(signer_id in ids, "untrusted-signer", "the owner must be a member")
        _need(not any(m.get("public") for m in members) or roster["kind"] == "private", "bad-members", "public member")
    if roster["kind"] == "alone":
        _need(len(members) == 1, "bad-members", "an alone pod has one member")
    if roster["expires"]:
        _need((time.time() if now is None else now) < roster["expires"], "expired")

    plans = roster["plans"]
    _need(isinstance(plans, list), "bad-plan", "plans")
    models = set()
    for p in plans:
        _need(isinstance(p, dict) and set(p) == {"model", "layers", "head", "hops"}, "bad-plan", "plan fields")
        _need(isinstance(p["model"], str) and p["model"] not in models, "bad-plan", "model")
        models.add(p["model"])
        _need(_int(p["layers"]) and p["layers"] > 0, "bad-plan", "layers")
        _need(p["head"] in ids, "bad-plan", "head is not a member")
        hops, at = p["hops"], 0
        _need(isinstance(hops, list) and hops, "bad-plan", "no hops")
        for h in hops:
            _need(isinstance(h, dict) and set(h) == {"peer", "lo", "hi"} and h["peer"] in ids, "bad-plan", "hop peer")
            _need(_int(h["lo"]) and _int(h["hi"]) and h["lo"] == at and h["hi"] > at, "bad-plan",
                  f"hops must cover [0, {p['layers']}) in order, once")
            at = h["hi"]
        _need(at == p["layers"], "bad-plan", f"hops end at {at}, not {p['layers']}")
    return roster


def newer(current: dict | None, incoming: dict, **kw) -> dict | None:
    """`incoming` if it is valid and replaces `current` (same pod, higher version), else None."""
    try:
        verify(incoming, **kw)
    except RosterError:
        return None
    if current is None:
        return incoming
    if incoming["pod_id"] != current["pod_id"] or incoming["version"] <= current["version"]:
        return None
    return incoming


def is_member(roster: dict | None, peer_id: str) -> bool:
    return bool(roster) and any(m["peer_id"] == peer_id for m in roster["members"])


def owner_id(roster: dict) -> str | None:
    """The owner machine's peer_id; None for a public pod, whose signer is the matchmaker."""
    return None if roster["kind"] == "public" else peer_id_of(bytes.fromhex(roster["signer"]))


def plan_for(roster: dict | None, model: str) -> dict | None:
    return next((p for p in roster["plans"] if p["model"] == model), None) if roster else None


# ---- invites ----

def new_invite(pod_id: str) -> tuple[str, str]:
    """(code to show, secret to keep until used or expired)."""
    secret = secrets.token_bytes(16)
    return f"pod1-{pod_id}-{base64.b32encode(secret).decode().rstrip('=').lower()}", secret.hex()


def parse_invite(code: str) -> tuple[str, str]:
    """(pod_id, secret hex) from an invite code."""
    parts = code.strip().split("-")
    if len(parts) != 3 or parts[0] != "pod1" or not _hex(parts[1], 32):
        raise RosterError("bad-invite", "not a pod invite code")
    b32 = parts[2].upper()
    try:
        secret = base64.b32decode(b32 + "=" * (-len(b32) % 8))
    except ValueError:
        raise RosterError("bad-invite", "not a pod invite code") from None
    if len(secret) != 16:
        raise RosterError("bad-invite", "not a pod invite code")
    return parts[1], secret.hex()


def invite_proof(secret: str, pod_id: str, pubkey: str) -> str:
    """Proves the joiner holds the invite, bound to its key: a captured request can't admit another machine."""
    msg = INVITE_DOMAIN + f"{pod_id}|{peer_id_of(bytes.fromhex(pubkey))}|{pubkey}".encode()
    return hmac.new(bytes.fromhex(secret), msg, hashlib.sha256).hexdigest()


def check_proof(secret: str, pod_id: str, pubkey: str, proof: str) -> bool:
    return hmac.compare_digest(invite_proof(secret, pod_id, pubkey), proof)


# ---- this machine's pod ----

def roster_path() -> Path:
    return home() / "pod.json"


def load_roster(path: Path | None = None, **kw) -> dict | None:
    """The saved roster if it is still valid (an expired public roster reads as no pod)."""
    try:
        return verify(json.loads((path or roster_path()).read_text()), **kw)
    except (OSError, ValueError):
        return None


def save_roster(roster: dict, path: Path | None = None):
    path = path or roster_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(roster, indent=2, sort_keys=True))
    os.replace(tmp, path)
