# Spike: Network.framework QUIC ↔ Python PeerNet

Question: can an iOS peer use Apple's own QUIC stack (Network.framework) to talk to the existing
aioquic peers in `podtorrent/net/quic.py`, sharing one UDP port with STUN and hole punching?

**Answer: yes, with two small protocol changes on the Python side.** Everything below was run
on macOS (same Network.framework API as iOS), against a real `PeerNet`.

## What was proven

| Check | Result |
| --- | --- |
| Swift dials Python: handshake, cert identity, signed auth, Heartbeat/Info | works (handshake ~10–50 ms) |
| Python calls back into Swift on server-opened streams (Info, heartbeats) | works |
| Python dials a Swift `NWListener` (aioquic as client) | works |
| Swift verifies a Python client's auth frame | works |
| 16 KB – 8 MB frames, both directions | intact, ~22–27 MB/s on loopback (aioquic-bound) |
| Punch probe from a BSD socket, then QUIC, same local port | Python sees one source port for both |
| Listener and outbound dial on the same port | works |

## Problems found, and the fix for each

1. **Apple's TLS has no Ed25519.** Today each peer's QUIC certificate is self-signed with its
   Ed25519 identity key. Network.framework never offers the ed25519 signature algorithm, so aioquic
   aborts with "No supported signature algorithm" (and the Swift side hangs in `preparing`).
   *Fix:* the certificate key becomes an ephemeral P-256 key, and a non-critical extension
   (OID `1.3.6.1.4.1.53594.77.1`, value `ed25519_pub(32) || sig(64)`) carries the identity key's
   signature over `"podtorrent-tls|" + P-256 point`. The peer_id still comes from the Ed25519 key. TLS
   proves possession of the P-256 key, and the signature binds it to the identity. This is the same trick
   libp2p uses. Verification is `cert_peer_id` in `podtorrent/net/quic.py`, and `identityKey` in Swift.
   The cert itself is built by `p256_cert` in `py_peer.py` for now.

2. **aioquic drops packets over 1500 bytes without saying so.** `PACKET_LENGTH_MAX` in
   aioquic's `_crypto.c` is 1500, but it never advertises `max_udp_payload_size`. Apple's QUIC runs
   path-MTU discovery, grows packets to 7–9 KB wherever the path allows (loopback, jumbo-frame LANs), and
   every stream stalls ("Invalid payload length" in aioquic's debug log). *Fix:* advertise
   `max_udp_payload_size=1500` (`_QuicConnection` in `podtorrent/net/quic.py`). This is a latent bug in
   today's Python peers too.

3. **Network.framework will not share a port with its own UDP connections.** A UDP `NWConnection`
   pinned to a reused local port fails with `ENOTSUP`. *Fix:* STUN and punch probes go out of plain BSD
   sockets bound to the QUIC port with `SO_REUSEPORT`. The rule that makes delivery deterministic:
   - QUIC owns the port: an `NWListener`, plus outbound `NWConnectionGroup`s with
     `requiredLocalEndpoint` set to the port.
   - A wildcard (unconnected) BSD socket on the port is never kept open. It receives incoming QUIC
     Initials meant for the listener.
   - Each STUN query or probe target gets a BSD socket that is `connect()`ed to that one remote, so it
     receives only from that remote. Close it as soon as the probe answers and before QUIC to that remote
     begins. A connected socket left open takes that remote's QUIC packets. (Outbound QUIC flows are
     connected too, so they win over an unconnected socket on the dial side.)

## Not covered here

- Real NAT traversal with a phone on a carrier/home network. Needs a device, so it needs Xcode,
  which isn't installed on this Mac yet.
- Building the P-256 cert in Swift. Here Python generated the PKCS#12. In the app,
  `swift-certificates` can build it, and on iOS `SecPKCS12Import` is in-memory by default, or the
  key and cert can go through the keychain to get a `SecIdentity`.
- The rendezvous WebSocket (`URLSessionWebSocketTask`), which is low risk.
- Graceful stream shutdown in Swift: the spike `cancel()`s streams after reading the reply, which
  makes aioquic log "cannot call write() after reset()" from a writer's `__del__`. The real client
  should FIN both directions instead.

## Rollout of the Python changes

Because the smaller peer_id dials, an old peer can end up as the client of a new one. So:
1. Release A (done in `podtorrent/net/quic.py`, tests in `tests/test_quic.py`): accept both certificate
   kinds, and advertise the 1500-byte cap.
2. Release B, once peers have auto-updated: serve P-256 certificates and bump the record's `protocol` to 3.
   Older peers then skip dialing, just as protocol-1 peers are skipped today.

## Run it

```bash
uv run python spikes/ios_quic/py_peer.py 47100 --p256          # Python peer; prints its peer_id
cd spikes/ios_quic && swift build
.build/debug/QuicSpike dial 127.0.0.1 47100 <PEER_ID> --probe

uv run python spikes/ios_quic/py_peer.py --make-p12 spikes/ios_quic/.home   # Swift identity + cert
NOBSD=1 .build/debug/QuicSpike listen 47200 .home              # then, from the repo root:
uv run python spikes/ios_quic/py_peer.py --dial 127.0.0.1:47200 <SWIFT_PEER_ID>
```
