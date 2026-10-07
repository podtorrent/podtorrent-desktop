"""Minimal STUN (RFC 5389) binding request: learn this Mac's public ip:port as seen from the internet.

Phase 2 must query from the same UDP socket QUIC uses, so the mapping matches; `query` takes one."""
import os
import socket
import struct

MAGIC = 0x2112A442
SERVERS = [("stun.cloudflare.com", 3478), ("stun.l.google.com", 19302)]


def query(sock: socket.socket, server: tuple[str, int], timeout: float = 2.0) -> tuple[str, int] | None:
    txn = os.urandom(12)
    sock.settimeout(timeout)
    try:
        sock.sendto(struct.pack("!HHI", 0x0001, 0, MAGIC) + txn, server)
        while True:
            data, _ = sock.recvfrom(2048)
            if len(data) >= 20 and data[8:20] == txn:
                return _mapped_address(data)
    except OSError:
        return None


def _mapped_address(data: bytes) -> tuple[str, int] | None:
    pos, end = 20, 20 + struct.unpack("!H", data[2:4])[0]
    while pos + 4 <= min(end, len(data)):
        kind, size = struct.unpack("!HH", data[pos:pos + 4])
        val = data[pos + 4:pos + 4 + size]
        if kind in (0x0020, 0x0001) and len(val) >= 8 and val[1] == 0x01:  # (XOR-)MAPPED-ADDRESS, IPv4
            port, ip = struct.unpack("!H", val[2:4])[0], struct.unpack("!I", val[4:8])[0]
            if kind == 0x0020:
                port ^= MAGIC >> 16
                ip ^= MAGIC
            return socket.inet_ntoa(struct.pack("!I", ip)), port
        pos += 4 + size + (-size % 4)
    return None


def public_endpoint(sock: socket.socket | None = None) -> tuple[str, int] | None:
    """First answer from SERVERS. Without a socket, a throwaway one (good enough for discovery)."""
    own = sock is None
    sock = sock or socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for s in SERVERS:
            try:
                addr = socket.getaddrinfo(*s, socket.AF_INET, socket.SOCK_DGRAM)[0][4]
            except OSError:
                continue
            if (r := query(sock, addr)):
                return r
        return None
    finally:
        if own:
            sock.close()
