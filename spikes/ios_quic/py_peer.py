"""A real PeerNet on a fixed UDP port, no rendezvous, for the Swift QUIC spike to dial.

    uv run python spikes/ios_quic/py_peer.py [port] [--p256]
    uv run python spikes/ios_quic/py_peer.py --make-p12 DIR     # identity + P-256 cert for `QuicSpike listen`
    uv run python spikes/ios_quic/py_peer.py --dial HOST:PORT PEER_ID   # dial a Swift listener as a client

Prints its peer_id, logs every datagram source and every link change, and answers Info with name "py-peer".
Uses a throwaway identity under the spike's .home/ so it never touches ~/.podtorrent.

--p256 serves a certificate Apple's TLS can verify: an ephemeral P-256 key, plus an extension holding
the Ed25519 identity key and its signature over that P-256 public key (the libp2p TLS trick)."""
import asyncio
import datetime
import os
import sys
import time
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
os.environ["PODTORRENT_HOME"] = str(HERE / ".home")

from podtorrent import pipeline_pb2 as pb  # noqa: E402
from podtorrent.net import quic  # noqa: E402
from podtorrent.net.identity import Identity, load_identity  # noqa: E402
from podtorrent.net.quic import PeerNet  # noqa: E402


def p256_cert(ident):
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    proof = ident.public + ident.key.sign(b"podtorrent-tls|" + point)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ident.peer_id)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=30))
            .add_extension(x509.UnrecognizedExtension(quic.IDENTITY_EXT, proof), critical=False)
            .sign(key, hashes.SHA256()))
    return cert, key


class LoggingNet(PeerNet):
    seen: set = set()

    def datagram_received(self, data, addr):
        key = (addr[:2], "quic" if data and data[0] & 0x40 else "other")
        if key not in self.seen:
            self.seen.add(key)
            print(f"py: first {key[1]} datagram from {addr[0]}:{addr[1]}", flush=True)
        if os.environ.get("TRACE") and len(data) > 1200:
            self.big = getattr(self, "big", 0) + 1
            if self.big <= 5 or self.big % 20 == 0:
                print(f"py: datagram #{self.big} of {len(data)} bytes", flush=True)
        super().datagram_received(data, addr)

    async def _serve_stream(self, conn, reader, writer):
        if os.environ.get("TRACE"):
            orig = reader.readexactly

            async def readexactly(n):
                out = await orig(n)
                if n > 1000:
                    print(f"py: stream read {n} bytes", flush=True)
                return out
            reader.readexactly = readexactly
        await super()._serve_stream(conn, reader, writer)


def make_p12(out: Path):
    """A throwaway Ed25519 identity (raw 32-byte seed, for CryptoKit) and a PKCS#12 holding the P-256 cert."""
    out.mkdir(parents=True, exist_ok=True)
    key = Ed25519PrivateKey.generate()
    ident = Identity(key)
    cert, ckey = p256_cert(ident)
    (out / "swift.seed").write_bytes(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                                       serialization.NoEncryption()))
    enc = (serialization.PrivateFormat.PKCS12.encryption_builder().kdf_rounds(2048)
           .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
           .hmac_hash(hashes.SHA1()).build(b"spike"))   # the legacy algorithms SecPKCS12Import still reads
    (out / "swift.p12").write_bytes(pkcs12.serialize_key_and_certificates(b"swift", ckey, cert, None, enc))
    print(f"py: wrote {out}/swift.p12 and swift.seed for peer_id {ident.peer_id}")


async def dial(target: str, peer_id: str):
    host, port = target.rsplit(":", 1)
    ident = load_identity()
    net = LoggingNet(ident, port=None, info=lambda: pb.NodeInfo(name="py-peer"))   # PODTORRENT_UDP_PORT or any
    await net.start()
    await asyncio.sleep(float(os.environ.get("DIAL_DELAY", "0")))
    l = net.link(peer_id)
    l.addr = (host, int(port))
    l.state = "connecting"
    await net._dial(l)
    print(f"py: dialed {peer_id[:8]} → {l.state}", flush=True)
    for _ in range(3):
        print(f"py: heartbeat rtt {await net.heartbeat(l):.2f} ms", flush=True)
    await asyncio.sleep(1)
    print(f"py: Swift says its name is {l.info.get('name')!r}", flush=True)
    for kb in (16, 1024, 8192):
        body = os.urandom(kb << 10)
        t = time.perf_counter()
        echo = await l.conn.call(quic.M_HEARTBEAT, body, timeout=30)
        dt = time.perf_counter() - t
        print(f"py: {kb:5d} KB echo {'intact' if echo == body else 'CORRUPT'} in {dt * 1000:.0f} ms", flush=True)
    await asyncio.sleep(4)


async def main():
    if "--make-p12" in sys.argv:
        return make_p12(Path(sys.argv[sys.argv.index("--make-p12") + 1]))
    if "--dial" in sys.argv:
        i = sys.argv.index("--dial")
        return await dial(sys.argv[i + 1], sys.argv[i + 2])
    if os.environ.get("TRACE"):
        import logging
        logging.basicConfig(level=logging.DEBUG, format="aioquic: %(message)s")
        logging.getLogger("asyncio").setLevel(logging.WARNING)
    nums = [a for a in sys.argv[1:] if a.isdigit()]
    port = int(nums[0]) if nums else 47100
    ident = load_identity()
    net = LoggingNet(ident, port=port, info=lambda: pb.NodeInfo(name="py-peer", layer_lo=0, layer_hi=12))
    if "--p256" in sys.argv:
        net.server_cfg.certificate, net.server_cfg.private_key = p256_cert(ident)
        print("py: serving a P-256 certificate with an Ed25519 identity extension", flush=True)
    net.on_change = lambda: None
    await net.start()
    print(f"py: peer_id {ident.peer_id} on udp/{net.port}", flush=True)
    last = {}
    while True:
        await asyncio.sleep(0.5)
        for pid, s in net.snapshot().items():
            now = (s["state"], s["addr"], s["info"].get("name"), s["error"])
            if last.get(pid) != now:
                print(f"py: link {pid[:8]} {s['state']} addr={s['addr']} info={now[2]!r} {s['error']}", flush=True)
                last[pid] = now


asyncio.run(main())
