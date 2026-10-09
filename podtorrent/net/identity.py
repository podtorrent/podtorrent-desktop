"""This Mac's long-lived peer identity: an Ed25519 key in ~/.podtorrent/identity.

peer_id is the first 32 hex chars of sha256(public key). QUIC certificates are signed with this key."""
import hashlib
import os
from functools import cache
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def home() -> Path:
    return Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent"))


def peer_id_of(public: bytes) -> str:
    return hashlib.sha256(public).hexdigest()[:32]


class Identity:
    def __init__(self, key: Ed25519PrivateKey):
        self.key = key
        self.public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.peer_id = peer_id_of(self.public)


@cache
def load_identity(path: Path | None = None) -> Identity:
    path = path or home() / "identity"
    if path.exists():
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    else:
        key = Ed25519PrivateKey.generate()
        path.parent.mkdir(parents=True, exist_ok=True)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
    return Identity(key)
