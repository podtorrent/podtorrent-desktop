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


async def _pair():
    a, b = ident(), ident()
    return a, b, await quic.PeerNet(a, port=0).start(), await quic.PeerNet(b, port=0).start()


def _close(*nets):
    for net in nets:
        for l in net.links.values():
            if l.conn:
                l.conn.close()
        for t in net._tasks:
            t.cancel()
        net.transport.close()


def test_non_member_refused_both_ways():
    async def run(refuser: str):
        server_id, client_id, server, client = await _pair()
        (server if refuser == "server" else client).allowed = lambda pid: False
        try:
            link = client.link(server_id.peer_id)
            link.addr, link.state = ("127.0.0.1", server.port), "connecting"
            try:
                await client._dial(link)
                raise AssertionError("dial should have been refused")
            except ConnectionError as e:
                assert "not-a-member" in str(e)
            assert client_id.peer_id not in server.links or server.links[client_id.peer_id].state != "direct"
        finally:
            _close(client, server)

    asyncio.run(run("server"))
    asyncio.run(run("client"))


def test_prune_drops_a_removed_member_and_refuses_its_streams():
    async def run():
        server_id, client_id, server, client = await _pair()
        try:
            link = client.link(server_id.peer_id)
            link.addr, link.state = ("127.0.0.1", server.port), "connecting"
            await client._dial(link)
            assert await client.heartbeat(link) > 0
            server.allowed = lambda pid: False   # the client was removed from the pod
            assert await link.conn.call(quic.M_INFO, b"") == b"not-a-member"
            server.prune()
            assert client_id.peer_id not in server.links
        finally:
            _close(client, server)

    asyncio.run(run())


def _relay_pair(a: "quic.PeerNet", b: "quic.PeerNet"):
    """Wire both nets' signals together as the pod room would: relay packets go across, punches are dropped."""
    def signal(src, dst):
        async def send(msg):
            if msg.get("type") == "relay":
                dst.relay_in(src.ident.peer_id, __import__("base64").b64decode(msg["data"]))
        return send
    a.signal, b.signal = signal(a, b), signal(b, a)


def test_relay_when_hole_punching_fails():
    async def run():
        server_id, client_id, server, client = await _pair()
        _relay_pair(client, server)
        quic.PUNCH_S, old = 0.5, quic.PUNCH_S
        try:
            dead = {"endpoints": [{"kind": "stun", "ip": "192.0.2.1", "port": 9}]}  # TEST-NET: never answers
            link = client.link(server_id.peer_id)
            client._set(link, "connecting")
            server._set(server.link(client_id.peer_id), "connecting")
            server_side = asyncio.create_task(server._punch(server.link(client_id.peer_id), dead, dial=False))
            await client._punch(link, dead, dial=True)
            assert link.state == "direct" and link.via == "relay", (link.state, link.error)
            assert link.snapshot()["addr"] == "rendezvous"
            assert await client.heartbeat(link) > 0
            assert server.links[client_id.peer_id].state == "direct"
            assert server.links[client_id.peer_id].via == "relay"
            server_side.cancel()
            # A machine no longer in the pod: its relayed packets are dropped, so calls go unanswered.
            server.allowed = lambda pid: False
            try:
                await link.conn.call(quic.M_INFO, b"", timeout=1)
                raise AssertionError("a removed member was answered over the relay")
            except (asyncio.TimeoutError, ConnectionError):
                pass
        finally:
            quic.PUNCH_S = old
            _close(client, server)

    asyncio.run(run())


def test_relay_ignores_non_members():
    async def run():
        server_id, client_id, server, client = await _pair()
        server.allowed = lambda pid: False
        try:
            server.relay_in(client_id.peer_id, b"\xc0" + b"\0" * 1300)
            assert not server.conns
        finally:
            _close(client, server)

    asyncio.run(run())
