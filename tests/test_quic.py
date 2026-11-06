"""Server certificate identities (Ed25519, and P-256 with IDENTITY_EXT) and the advertised UDP payload cap.

Usage: uv run --with pytest pytest tests/test_quic.py
"""
import asyncio
import datetime

from aioquic.buffer import Buffer
from aioquic.quic.connection import QuicConnection
from aioquic.quic.packet import QuicProtocolVersion, pull_quic_transport_parameters
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.x509.oid import NameOID

from podtorrent.net import quic
from podtorrent.net.identity import Identity


def ident() -> Identity:
    return Identity(Ed25519PrivateKey.generate())


def p256_cert(owner: Identity, proof: bytes | None = None):
    """What an iOS peer serves: a P-256 key, vouched for by `owner` in IDENTITY_EXT (or `proof` verbatim)."""
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    if proof is None:
        proof = owner.public + owner.key.sign(b"podtorrent-tls|" + point)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, owner.peer_id)])
    now = datetime.datetime.now(datetime.timezone.utc)
    b = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
         .not_valid_after(now + datetime.timedelta(days=30)))
    if proof:
        b = b.add_extension(x509.UnrecognizedExtension(quic.IDENTITY_EXT, proof), critical=False)
    return b.sign(key, hashes.SHA256()), key


def test_ed25519_cert():
    me = ident()
    assert quic.cert_peer_id(quic._cert(me)) == me.peer_id


def test_p256_cert_with_identity():
    me = ident()
    assert quic.cert_peer_id(p256_cert(me)[0]) == me.peer_id


def test_p256_cert_rejected_without_valid_proof():
    me, other = ident(), ident()
    assert quic.cert_peer_id(p256_cert(me, proof=b"")[0]) == ""                              # no extension
    assert quic.cert_peer_id(p256_cert(me, proof=me.public + bytes(64))[0]) == ""            # bad signature
    assert quic.cert_peer_id(p256_cert(me, proof=me.public)[0]) == ""                        # truncated
    # A signature over some other P-256 key can't be moved onto this certificate.
    stolen = p256_cert(other)[0].extensions.get_extension_for_oid(quic.IDENTITY_EXT).value.value
    assert quic.cert_peer_id(p256_cert(me, proof=stolen)[0]) == ""


def test_transport_parameters_cap_udp_payload():
    net = quic.PeerNet(ident(), port=0)
    ours, plain = quic._QuicConnection(configuration=net.client_cfg), QuicConnection(configuration=net.client_cfg)
    ours._version = plain._version = QuicProtocolVersion.VERSION_1   # chosen during the handshake
    got = pull_quic_transport_parameters(Buffer(data=ours._serialize_transport_parameters()))
    want = pull_quic_transport_parameters(Buffer(data=plain._serialize_transport_parameters()))
    assert want.max_udp_payload_size is None and got.max_udp_payload_size == quic.MAX_UDP_PAYLOAD
    got.max_udp_payload_size = None
    # Everything else survives the round trip (connection IDs and reset tokens differ per connection).
    for f in ("initial_source_connection_id", "stateless_reset_token"):
        setattr(got, f, None)
        setattr(want, f, None)
    assert got == want


def test_dial_ed25519_and_p256_servers():
    async def run(p256: bool):
        server_id, client_id = ident(), ident()
        server = await quic.PeerNet(server_id, port=0).start()
        client = await quic.PeerNet(client_id, port=0).start()
        if p256:
            server.server_cfg.certificate, server.server_cfg.private_key = p256_cert(server_id)
        try:
            link = client.link(server_id.peer_id)
            link.addr, link.state = ("127.0.0.1", server.port), "connecting"
            await client._dial(link)
            assert link.state == "direct"
            assert server.links[client_id.peer_id].state == "direct"
            assert await client.heartbeat(link) > 0
        finally:
            for net in (client, server):
                for l in net.links.values():
                    if l.conn:
                        l.conn.close()
                for t in net._tasks:
                    t.cancel()
                net.transport.close()

    asyncio.run(run(p256=False))
    asyncio.run(run(p256=True))
