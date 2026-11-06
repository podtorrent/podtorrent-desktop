"""Direct peer links: QUIC over one UDP socket, with STUN and hole punching on that same socket.

One `PeerNet` per process. The socket carries three kinds of datagram, told apart by the first bytes:
  - STUN responses (top two bits 00, magic cookie at [4:8]) answer our own `stun()` queries, so the
    public ip:port we publish is the NAT mapping QUIC actually uses;
  - punch probes (PROBE prefix) open NAT mappings and tell us which candidate address works;
  - QUIC packets (fixed bit 0x40 set), routed to a connection by remote address.

Connecting to a peer (the smaller peer_id initiates, so each pair dials once):
  1. ask the rendezvous to `punch` the target; it hands each side the other's record;
  2. both sides spray probes at every candidate endpoint of the other for PUNCH_S;
  3. the initiator dials QUIC to the first address that answers a probe;
  4. the server proves its peer_id with its TLS certificate (self-signed with the identity key, or a
     P-256 key vouched for by the identity key; see `cert_peer_id`), the client proves its own with a
     signed `auth` frame. No path within PUNCH_S: `unreachable`.

RPC: each call is one bidirectional stream that opens with [method u8], then carries frames of
[len u32][protobuf] both ways. Unary calls send one frame each way; `Load` streams progress back;
`Forward` keeps the stream open for a whole session (one request frame → one response frame)."""
import asyncio
import datetime
import json
import os
import socket
import ssl
import struct
import time
from typing import Awaitable, Callable

from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.buffer import Buffer
from aioquic.quic import events
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.connection import QuicConnection
from aioquic.quic.packet import (
    QuicPacketType,
    pull_quic_header,
    pull_quic_transport_parameters,
    push_quic_transport_parameters,
)
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.x509.oid import NameOID

from .. import pipeline_pb2 as pb
from . import stun
from .identity import Identity, peer_id_of

ALPN = "podtorrent/1"
PROBE = b"\x00PTP"
PUNCH_S = 4.0
PROBE_EVERY_S = 0.2
RETRY_S = 60          # an unreachable pair is retried after this long
HEARTBEAT_S = 2
INFO_S = 10
RPC_TIMEOUT_S = 5
IDLE_TIMEOUT_S = 30
MAX_FRAME = 256 << 20
WINDOW = 64 << 20
# aioquic can't decrypt a packet over 1500 bytes (PACKET_LENGTH_MAX in its _crypto.c) yet never says so;
# a peer that probes the path MTU (Apple's QUIC) would grow its packets past that and stall every stream.
MAX_UDP_PAYLOAD = 1500
# Apple's TLS can't sign with Ed25519, so an iOS peer's certificate has a P-256 key and carries its identity
# here: ed25519 public key (32 bytes) || that key's signature (64) over b"podtorrent-tls|" + the P-256 point.
IDENTITY_EXT = x509.ObjectIdentifier("1.3.6.1.4.1.53594.77.1")

M_AUTH, M_HEARTBEAT, M_INFO, M_FORWARD, M_LOAD, M_VIDEO, M_BLOB = 0, 1, 2, 3, 4, 5, 6
# A streaming handler gets the first request frame and the stream; it writes response frames.
Handler = Callable[["Conn", bytes, asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


def _cert(ident: Identity) -> x509.Certificate:
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ident.peer_id)])
    now = datetime.datetime.now(datetime.timezone.utc)
    return (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(ident.key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=3650))
            .sign(ident.key, None))


def cert_peer_id(cert: x509.Certificate) -> str:
    """The peer_id a server certificate proves: its own Ed25519 key, or the identity in IDENTITY_EXT."""
    pub = cert.public_key()
    if isinstance(pub, Ed25519PublicKey):
        return peer_id_of(pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    try:
        proof = cert.extensions.get_extension_for_oid(IDENTITY_EXT).value.value
        point = pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        if len(proof) != 96:
            return ""
        Ed25519PublicKey.from_public_bytes(proof[:32]).verify(proof[32:], b"podtorrent-tls|" + point)
    except (x509.ExtensionNotFound, ValueError, InvalidSignature):
        return ""
    return peer_id_of(proof[:32])


class _QuicConnection(QuicConnection):
    """Advertises MAX_UDP_PAYLOAD, which aioquic leaves unset."""

    def _serialize_transport_parameters(self) -> bytes:
        params = pull_quic_transport_parameters(Buffer(data=super()._serialize_transport_parameters()))
        params.max_udp_payload_size = MAX_UDP_PAYLOAD
        buf = Buffer(capacity=3 * self._max_datagram_size)
        push_quic_transport_parameters(buf, params)
        return buf.data


def _auth_payload(server_id: str, client_id: str) -> bytes:
    return f"podtorrent-auth|{server_id}|{client_id}".encode()


async def _read_frame(reader: asyncio.StreamReader) -> bytes:
    n = struct.unpack("!I", await reader.readexactly(4))[0]
    if n > MAX_FRAME:
        raise ValueError(f"frame too large: {n}")
    return await reader.readexactly(n)


def _frame(body: bytes) -> bytes:
    return struct.pack("!I", len(body)) + body


class Conn(QuicConnectionProtocol):
    """One QUIC connection to one peer, sharing the PeerNet socket."""

    def __init__(self, net: "PeerNet", quic: QuicConnection, addr, is_client: bool):
        super().__init__(quic, stream_handler=self._on_stream)
        self.net, self.addr, self.is_client = net, addr, is_client
        self.peer_id = ""   # set once the other side is authenticated

    def _on_stream(self, reader, writer):
        asyncio.ensure_future(self.net._serve_stream(self, reader, writer))

    def quic_event_received(self, event):
        super().quic_event_received(event)
        if isinstance(event, events.ConnectionTerminated):
            self.net._conn_closed(self, event.reason_phrase or "closed")

    def server_peer_id(self) -> str:
        cert = self._quic.tls._peer_certificate
        return cert_peer_id(cert) if cert is not None else ""

    async def call(self, method: int, body: bytes, timeout: float = RPC_TIMEOUT_S) -> bytes:
        reader, writer = await self.create_stream()
        writer.write(bytes([method]) + _frame(body))
        writer.write_eof()
        return await asyncio.wait_for(_read_frame(reader), timeout)

    async def open(self, method: int, body: bytes) -> "Stream":
        """A long-lived call: the first frame goes out now, more with `send`."""
        reader, writer = await self.create_stream()
        writer.write(bytes([method]) + _frame(body))
        self.transmit()
        return Stream(reader, writer, self)


class Stream:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, conn: Conn):
        self.reader, self.writer, self.conn = reader, writer, conn

    def send(self, body: bytes):
        self.writer.write(_frame(body))
        self.conn.transmit()

    async def recv(self) -> bytes:
        return await _read_frame(self.reader)

    def close(self):
        try:
            self.writer.write_eof()
            self.conn.transmit()
        except Exception:  # noqa: BLE001 - connection already gone
            pass


class Link:
    """What we know about our direct path to one peer."""

    def __init__(self, peer_id: str):
        self.peer_id = peer_id
        self.state = "idle"     # idle | connecting | direct | unreachable
        self.error = ""
        self.addr: tuple[str, int] | None = None
        self.via = ""           # lan | stun
        self.rtt_ms: float | None = None
        self.info: dict = {}
        self.since = time.time()
        self.conn: Conn | None = None
        self.got_probe = asyncio.Event()
        self.punch_task: asyncio.Task | None = None

    def snapshot(self) -> dict:
        return {"state": self.state, "error": self.error, "rtt_ms": self.rtt_ms, "via": self.via,
                "addr": f"{self.addr[0]}:{self.addr[1]}" if self.addr else "", "since": self.since,
                "info": self.info}


def udp_port() -> int:
    """PODTORRENT_UDP_PORT pins the QUIC port (e.g. for a port forward); default: any free port."""
    return int(os.environ.get("PODTORRENT_UDP_PORT", "0"))


class PeerNet(asyncio.DatagramProtocol):
    """`signal(msg)` sends a message to the rendezvous (set by SwarmClient).
    `on_change()` runs whenever a link changes state or RTT.
    `info()` returns this node's pb.NodeInfo for the Info RPC."""

    def __init__(self, ident: Identity, port: int | None = None, info: Callable[[], pb.NodeInfo] | None = None):
        self.ident, self.port = ident, udp_port() if port is None else port
        self.info = info or (lambda: pb.NodeInfo())
        self.signal: Callable[[dict], Awaitable[None] | None] = lambda msg: None
        self.on_change: Callable[[], None] = lambda: None
        self.links: dict[str, Link] = {}
        self.conns: dict[tuple, Conn] = {}
        self.records: dict[str, dict] = {}
        self.handlers: dict[int, Handler] = {}
        self.transport: asyncio.DatagramTransport | None = None
        self._stun_waiters: dict[bytes, asyncio.Future] = {}
        self._tasks: list[asyncio.Task] = []
        # Prefill hidden states run to several MB: open the flow-control windows wide.
        common = dict(alpn_protocols=[ALPN], idle_timeout=IDLE_TIMEOUT_S, max_data=WINDOW, max_stream_data=WINDOW)
        self.server_cfg = QuicConfiguration(is_client=False, certificate=_cert(ident), private_key=ident.key, **common)
        self.client_cfg = QuicConfiguration(is_client=True, verify_mode=ssl.CERT_NONE, server_name="podtorrent", **common)

    # ---- socket ----
    async def start(self):
        loop = asyncio.get_running_loop()
        self.transport, _ = await loop.create_datagram_endpoint(lambda: self, local_addr=("0.0.0.0", self.port))
        self.port = self.transport.get_extra_info("sockname")[1]
        self._tasks.append(asyncio.create_task(self._maintain()))
        print(f"p2p: QUIC on udp/{self.port} as {self.ident.peer_id[:8]}", flush=True)
        return self

    def connection_made(self, transport):
        self.transport = transport

    def error_received(self, exc):
        pass  # ICMP unreachable while punching is expected

    def datagram_received(self, data: bytes, addr):
        addr = addr[:2]
        if not data:
            return
        if data[0] & 0x40:
            self._quic_datagram(data, addr)
        elif data.startswith(PROBE):
            self._probe_received(data, addr)
        elif len(data) >= 20 and data[4:8] == struct.pack("!I", stun.MAGIC):
            fut = self._stun_waiters.pop(data[8:20], None)
            if fut and not fut.done():
                fut.set_result(stun._mapped_address(data))

    def _quic_datagram(self, data: bytes, addr):
        conn = self.conns.get(addr)
        if conn is None:
            try:
                header = pull_quic_header(Buffer(data=data), host_cid_length=self.server_cfg.connection_id_length)
            except ValueError:
                return
            if header.packet_type != QuicPacketType.INITIAL or len(data) < 1200:
                return
            quic = _QuicConnection(configuration=self.server_cfg,
                                   original_destination_connection_id=header.destination_cid)
            conn = Conn(self, quic, addr, is_client=False)
            conn.connection_made(self.transport)
            self.conns[addr] = conn
        conn.datagram_received(data, addr)

    # ---- STUN, on this socket ----
    async def stun(self, timeout: float = 2.0) -> tuple[str, int] | None:
        loop = asyncio.get_running_loop()
        for host, port in stun.SERVERS:
            try:
                info = await loop.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_DGRAM)
            except OSError:
                continue
            txn = os.urandom(12)
            fut = loop.create_future()
            self._stun_waiters[txn] = fut
            self.transport.sendto(struct.pack("!HHI", 0x0001, 0, stun.MAGIC) + txn, info[0][4][:2])
            try:
                if (r := await asyncio.wait_for(fut, timeout)):
                    return r
            except asyncio.TimeoutError:
                pass
            finally:
                self._stun_waiters.pop(txn, None)
        return None

    # ---- links ----
    def link(self, peer_id: str) -> Link:
        if peer_id not in self.links:
            self.links[peer_id] = Link(peer_id)
        return self.links[peer_id]

    def _set(self, link: Link, state: str, error: str = ""):
        if link.state != state:
            link.since = time.time()
            print(f"p2p: {self._name(link.peer_id)} {state}{' (' + error + ')' if error else ''}", flush=True)
        link.state, link.error = state, error
        if state != "direct":
            link.rtt_ms = None
        self.on_change()

    def _name(self, peer_id: str) -> str:
        return self.records.get(peer_id, {}).get("name") or peer_id[:8]

    def conn_to(self, peer_id: str) -> Conn:
        l = self.links.get(peer_id)
        if not l or l.state != "direct" or not l.conn:
            raise ConnectionError(f"no direct link to {self._name(peer_id)}")
        return l.conn

    def snapshot(self) -> dict[str, dict]:
        return {pid: l.snapshot() for pid, l in self.links.items()}

    def on_peers(self, peers: list[dict]):
        """Registry changed: dial new peers, forget departed ones."""
        self.records = {p["peer_id"]: p for p in peers if p.get("peer_id") != self.ident.peer_id}
        for pid in list(self.links):
            if pid not in self.records:
                l = self.links.pop(pid)
                if l.punch_task:
                    l.punch_task.cancel()
                if l.conn:
                    l.conn.close()
        self._dial_due()
        self.on_change()

    def _dial_due(self):
        now = time.time()
        for pid, rec in self.records.items():
            if rec.get("protocol", 1) < 2 or self.ident.peer_id > pid:
                continue  # old client without QUIC, or the other side initiates
            l = self.link(pid)
            if l.state == "idle" or (l.state == "unreachable" and now - l.since > RETRY_S):
                self._set(l, "connecting")
                asyncio.ensure_future(self.signal({"type": "punch", "to": pid, "nonce": os.urandom(8).hex()}))

    def on_signal(self, msg: dict):
        """A punch message relayed by the rendezvous."""
        kind = msg.get("type")
        if kind == "punch_failed":
            l = self.link(str(msg.get("to")))
            self._set(l, "unreachable", f"peer is {msg.get('reason', 'offline')}")
            return
        rec = msg.get("peer") or {}
        pid = rec.get("peer_id") or msg.get("from") or msg.get("to")
        if not pid or pid == self.ident.peer_id:
            return
        self.records[pid] = rec
        l = self.link(pid)
        if l.state == "direct":
            return
        if l.punch_task and not l.punch_task.done():
            return
        self._set(l, "connecting")
        l.punch_task = asyncio.create_task(self._punch(l, rec, dial=(kind == "punch_ack")))

    def _candidates(self, rec: dict) -> list[tuple[tuple[str, int], str]]:
        out, ports = [], []
        for e in rec.get("endpoints", []):
            if e.get("port"):
                out.append(((e["ip"], int(e["port"])), e.get("kind", "")))
                if e.get("kind") == "stun":
                    ports.append(int(e["port"]))
        # The rendezvous saw this address; with a port-preserving NAT the STUN port works on it too.
        obs = rec.get("observed_ip", "")
        if obs and ":" not in obs:
            out += [((obs, p), "stun") for p in ports if (obs, p) not in [a for a, _ in out]]
        return out

    async def _punch(self, l: Link, rec: dict, dial: bool):
        cands = self._candidates(rec)
        if not cands:
            self._set(l, "unreachable", "peer published no UDP endpoint")
            return
        kinds = dict(cands)
        l.got_probe.clear()
        l.addr = None
        probe = PROBE + b"?" + self.ident.peer_id.encode() + l.peer_id.encode()
        deadline = time.time() + PUNCH_S
        while time.time() < deadline and not l.got_probe.is_set():
            for addr, _ in cands:
                self.transport.sendto(probe, addr)
            try:
                await asyncio.wait_for(l.got_probe.wait(), PROBE_EVERY_S)
            except asyncio.TimeoutError:
                pass
        if not l.got_probe.is_set():
            self._set(l, "unreachable", "no UDP path through NAT (hole punch timed out)")
            return
        l.via = kinds.get(l.addr, "stun")
        # Keep the mapping warm for a moment so the other side's handshake gets through.
        for _ in range(3):
            self.transport.sendto(probe, l.addr)
        if not dial:
            await asyncio.sleep(PUNCH_S + 4)
            if l.state == "connecting":
                self._set(l, "unreachable", "probes answered but no QUIC handshake arrived")
            return
        try:
            await self._dial(l)
        except Exception as e:  # noqa: BLE001
            self._set(l, "unreachable", f"QUIC handshake failed: {e or type(e).__name__}")

    def _probe_received(self, data: bytes, addr):
        body = data[len(PROBE):]
        if len(body) < 1 + 64:
            return
        kind, sender, target = body[:1], body[1:33].decode(errors="replace"), body[33:65].decode(errors="replace")
        if target != self.ident.peer_id:
            return
        if kind == b"?":
            self.transport.sendto(PROBE + b"!" + self.ident.peer_id.encode() + sender.encode(), addr)
        l = self.links.get(sender)
        if l and l.state == "connecting" and not l.got_probe.is_set():
            l.addr = addr
            l.got_probe.set()

    async def _dial(self, l: Link):
        old = self.conns.pop(l.addr, None)
        if old:
            old.close()
        conn = Conn(self, _QuicConnection(configuration=self.client_cfg), l.addr, is_client=True)
        conn.connection_made(self.transport)
        self.conns[l.addr] = conn
        conn.connect(l.addr)
        await asyncio.wait_for(conn.wait_connected(), RPC_TIMEOUT_S)
        got = conn.server_peer_id()
        if got != l.peer_id:
            conn.close()
            raise ConnectionError(f"certificate is for {got[:8] or 'nobody'}, expected {l.peer_id[:8]}")
        sig = self.ident.key.sign(_auth_payload(l.peer_id, self.ident.peer_id))
        reply = await conn.call(M_AUTH, json.dumps({"peer_id": self.ident.peer_id, "pub": self.ident.public.hex(),
                                                    "sig": sig.hex()}).encode())
        if reply != b"ok":
            conn.close()
            raise ConnectionError(reply.decode(errors="replace"))
        conn.peer_id = l.peer_id
        self._attach(l, conn)

    def _attach(self, l: Link, conn: Conn):
        if l.conn and l.conn is not conn:
            l.conn.close()
        l.conn, l.addr = conn, conn.addr
        if not l.via:
            l.via = "stun"
        self._set(l, "direct")
        asyncio.ensure_future(self._refresh_info(l))

    def _conn_closed(self, conn: Conn, reason: str):
        if self.conns.get(conn.addr) is conn:
            del self.conns[conn.addr]
        l = self.links.get(conn.peer_id)
        if l and l.conn is conn:
            l.conn = None
            self._set(l, "unreachable", f"connection lost ({reason})")

    # ---- serving ----
    async def _serve_stream(self, conn: Conn, reader, writer):
        try:
            method = (await reader.readexactly(1))[0]
            body = await _read_frame(reader)
            if method == M_AUTH:
                out = self._auth(conn, body)
            elif not conn.peer_id:
                out = b"unauthenticated"
            elif method == M_HEARTBEAT:
                out = body  # echo: the caller's sent_ns comes back unchanged
            elif method == M_INFO:
                out = self.info().SerializeToString()
            elif method in self.handlers:
                await self.handlers[method](conn, body, reader, writer)
                writer.write_eof()
                return
            else:
                out = b""
            writer.write(_frame(out))
            writer.write_eof()
        except (asyncio.IncompleteReadError, ConnectionError, ValueError):
            pass

    def _auth(self, conn: Conn, body: bytes) -> bytes:
        try:
            a = json.loads(body)
            pub = bytes.fromhex(a["pub"])
            if peer_id_of(pub) != a["peer_id"]:
                return b"peer_id does not match key"
            Ed25519PublicKey.from_public_bytes(pub).verify(bytes.fromhex(a["sig"]),
                                                           _auth_payload(self.ident.peer_id, a["peer_id"]))
        except (ValueError, KeyError, InvalidSignature) as e:
            return f"bad auth: {type(e).__name__}".encode()
        conn.peer_id = a["peer_id"]
        l = self.link(conn.peer_id)
        if l.punch_task and not l.punch_task.done():
            l.punch_task.cancel()
        if l.addr and l.addr != conn.addr:
            l.via = "stun"
        self._attach(l, conn)
        return b"ok"

    # ---- liveness ----
    async def heartbeat(self, l: Link) -> float:
        sent = time.perf_counter_ns()
        await l.conn.call(M_HEARTBEAT, pb.HeartbeatRequest(sent_ns=sent).SerializeToString())
        return (time.perf_counter_ns() - sent) / 1e6

    async def _refresh_info(self, l: Link):
        try:
            ni = pb.NodeInfo.FromString(await l.conn.call(M_INFO, b""))
            l.info = {"name": ni.name, "layer_lo": ni.layer_lo, "layer_hi": ni.layer_hi, "loaded": ni.loaded,
                      "mem_total_gb": round(ni.mem_total_gb, 1), "mem_active_gb": round(ni.mem_active_gb, 1),
                      "requests_served": ni.requests_served, "tokens_processed": ni.tokens_processed,
                      "busy": ni.busy, "active_requests": ni.active_requests,
                      "mem_peak_gb": round(ni.mem_peak_gb, 1), "mem_free_gb": round(ni.mem_free_gb, 1),
                      "ts": time.time(), "roles": list(ni.roles),
                      "slices": [{"model": x.model, "lo": x.lo, "hi": x.hi, "loaded": x.loaded,
                                  "n_layers": x.n_layers} for x in ni.slices]}
            self.on_change()
        except Exception:  # noqa: BLE001
            pass

    async def _beat(self, l: Link, refresh: bool):
        try:
            rtt = await self.heartbeat(l)
        except Exception:  # noqa: BLE001
            if l.conn:
                l.conn.close()
            l.conn = None
            self._set(l, "unreachable", "heartbeat timed out")
            return
        l.rtt_ms = round(rtt if l.rtt_ms is None else 0.7 * l.rtt_ms + 0.3 * rtt, 2)
        if refresh:
            await self._refresh_info(l)

    async def _maintain(self):
        tick = 0
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            tick += 1
            live = [l for l in self.links.values() if l.state == "direct" and l.conn]
            await asyncio.gather(*(self._beat(l, tick % (INFO_S // HEARTBEAT_S) == 0) for l in live))
            self._dial_due()
            self.on_change()
