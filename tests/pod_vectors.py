"""Builds tests/pod_vectors.json: fixed keys, canonical encodings, rosters with the expected verdict,
and invite proofs. Every port's roster code must agree with it (Ed25519 signatures are deterministic).

    uv run python tests/pod_vectors.py   # rewrite after a deliberate wire change
"""
import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from podtorrent import pod
from podtorrent.net.identity import Identity

OUT = Path(__file__).with_name("pod_vectors.json")
NOW = 1_800_000_000
MODEL = "mlx-community/Qwen3-30B-A3B-4bit"


def ident(label: str) -> tuple[Identity, str]:
    seed = hashlib.sha256(f"podtorrent-test|{label}".encode()).digest()
    return Identity(Ed25519PrivateKey.from_private_bytes(seed)), seed.hex()


def build() -> dict:
    keys = {k: ident(k) for k in ("owner", "laptop", "stranger", "matchmaker")}
    owner, laptop, stranger, mm = (keys[k][0] for k in ("owner", "laptop", "stranger", "matchmaker"))
    mms = [mm.public.hex()]

    def roster(signer, kind="private", members=None, plans=None, expires=0, version=1, salt="00" * 16, name="home"):
        signer_hex = signer.public.hex()
        return {"pod_id": pod.pod_id_of(signer_hex, salt), "salt": salt, "kind": kind, "name": name,
                "version": version, "signer": signer_hex, "members": members or [pod.member(owner, "studio")],
                "plans": plans or [], "expires": expires}

    duo = [pod.member(owner, "studio"), pod.member(laptop, "air")]
    split = [{"model": MODEL, "layers": 48, "head": owner.peer_id,
              "hops": [{"peer": owner.peer_id, "lo": 0, "hi": 24}, {"peer": laptop.peer_id, "lo": 24, "hi": 48}]}]
    good = pod.sign(roster(owner, members=duo, plans=split, version=3), owner)

    def tampered(**changes):
        return {**good, **changes}

    cases = [
        ("private pod, two machines at 50/50", good, None),
        ("alone: a pod of one", pod.sign(roster(owner, kind="alone", plans=[
            {"model": MODEL, "layers": 48, "head": owner.peer_id, "hops": [{"peer": owner.peer_id, "lo": 0, "hi": 48}]}]),
            owner), None),
        ("public pod signed by the matchmaker", pod.sign(roster(mm, kind="public", members=[
            pod.member(laptop, "air"), pod.member(stranger, "box")], expires=NOW + 600), mm), None),
        ("private pod with a public machine filling a gap", pod.sign(roster(owner, members=[
            pod.member(owner, "studio"), pod.member(stranger, "box", public=True)]), owner), None),
        ("name changed after signing", tampered(name="other"), "bad-signature"),
        ("member added after signing", tampered(members=[*duo, pod.member(stranger, "box")]), "bad-signature"),
        ("signed by a member that is not the owner", pod.sign({**good, "signer": laptop.public.hex()}, laptop),
         "pod-id-mismatch"),
        ("owner not a member", pod.sign(roster(owner, members=[pod.member(laptop, "air")]), owner), "untrusted-signer"),
        ("public pod signed by an owner", pod.sign(roster(owner, kind="public", expires=NOW + 600), owner),
         "untrusted-signer"),
        ("public pod past its expiry", pod.sign(roster(mm, kind="public", members=[pod.member(laptop, "air")],
                                                       expires=NOW - 1), mm), "expired"),
        ("alone with two members", pod.sign(roster(owner, kind="alone", members=duo), owner), "bad-members"),
        ("hops leave a gap", pod.sign(roster(owner, members=duo, plans=[{**split[0], "hops": [
            {"peer": owner.peer_id, "lo": 0, "hi": 20}, {"peer": laptop.peer_id, "lo": 24, "hi": 48}]}]), owner),
         "bad-plan"),
        ("hop on a machine outside the pod", pod.sign(roster(owner, plans=[{**split[0], "head": owner.peer_id}]), owner),
         "bad-plan"),
        ("member peer_id does not match its key", pod.sign(roster(owner, members=[
            pod.member(owner, "studio"), {**pod.member(laptop, "air"), "peer_id": stranger.peer_id}]), owner),
         "bad-members"),
    ]

    secret = hashlib.sha256(b"podtorrent-test|invite").digest()[:16].hex()
    code = f"pod1-{good['pod_id']}-{base64.b32encode(bytes.fromhex(secret)).decode().rstrip('=').lower()}"
    return {
        "now": NOW,
        "matchmakers": mms,
        "keys": {k: {"seed": seed, "pubkey": i.public.hex(), "peer_id": i.peer_id} for k, (i, seed) in keys.items()},
        "canonical": [{"value": v, "utf8": pod.canonical(v).decode()} for v in (
            {"b": 1, "a": [True, None, "x"]}, {"model": MODEL, "name": "Café ☕", "n": -3}, {"q": "a\"b\\c\n"})],
        "signing_input_prefix": pod.ROSTER_DOMAIN.decode(),
        "rosters": [{"case": c, "roster": r, "error": e} for c, r, e in cases],
        "invites": [{"code": code, "pod_id": good["pod_id"], "secret": secret, "pubkey": laptop.public.hex(),
                     "proof": pod.invite_proof(secret, good["pod_id"], laptop.public.hex())}],
    }


if __name__ == "__main__":
    OUT.write_text(json.dumps(build(), indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT}")
