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

## iPad / iPhone test app (`PeerTest.swiftpm`)

A Swift Playgrounds app (no Xcode needed) built on `PeerTest.swiftpm/Core`. `PeerTestCLI` compiles the same
`Core` on macOS through a symlink, so everything below was first run from this Mac.

- **Swarm tab**: pods, as of 0.1.25. Before joining, the app watches the rendezvous's census
  (`/v1/census`, no key, publishes nothing): every pod's kind, models, and each machine's chip, memory,
  layers and online state (never names), plus the public lobby. Two ways in, both with a throwaway
  identity whose peer_id starts `fff` (the smaller peer_id dials, so members always dial it and never
  need it to verify an Ed25519 certificate):
  - **Join pod** with a `pod1-…` invite code from a private pod's owner. The app proves its key in the
    pod's room (`podtorrent-room|<pod_id>|<nonce>`), sends a `join_request` with the invite's HMAC proof
    (`pod.invite_proof`), and waits for the owner's signed roster listing it. Then it sends its record,
    lists the members, hole-punches when one asks, and links. **Leave** asks the owner to sign it out.
    The identity isn't kept between launches, so every run needs a fresh invite.
  - **Wait in public lobby** proves the key in `/v1/public` and offers supply with no models. It shows
    in the census as idle, and an `assign` from the matchmaker would move it to that pod's room, but the
    matchmaker only assigns machines whose models cover layers, so it never assigns this one. That's
    deliberate: a public pod with a member that can't serve would stall. Public pods can't be joined
    any other way: their roster is signed by the matchmaker, and a `join_request` goes to an owner they
    don't have.
  The app doesn't verify roster signatures itself (the room already did), and it can't carry QUIC
  relayed through the room (0.1.26) yet, so a member that can only reach it by relay won't link.
  Tested end to end through a local `wrangler dev`: census, lobby, a bad invite, and joining
  `py_peer.py --pod`'s private pod, punching and holding a direct link with heartbeats.
- **Models tab**: pick a model from the pods or search Hugging Face. The app suggests a layer range the way
  `catalog.suggest` does: the first gap (from this pod's members, or the census's single-model pods), sized to `os_proc_available_memory()` with 10% headroom.
  It then downloads those layers with range requests into `Documents/models/<name>/layers-<lo>-<hi>.safetensors`,
  plus config and tokenizer. The output is byte-identical to `slicer.download_slice` (checked on
  Qwen3-0.6B-4bit layers 3–6), and `mx.load` reads it. Downloaded layers aren't served or advertised yet;
  that needs MLX Swift.
- **Diagnostics tab**: the direct test against `py_peer.py --p256`, and the connection log.

Two more findings about sharing the port with an `NWListener` (point 3 above was a dial-only test):
- Once the listener holds the port, it gets **every** datagram, even those from a remote that a
  connected BSD socket is bound to. So the BSD sockets can send but never receive. STUN runs before the
  listener starts, a STUN request every 10 s keeps the NAT mapping alive, and punching is send-only.
  The dialing peer only needs to receive our probe to start its dial.
- While a BSD socket is connected to a peer's address, Network.framework can't answer that address.
  The peer's handshake then stalls until the socket closes. So each probe opens, sends and closes a socket.

To run it: unzip `PeerTest.swiftpm.zip` on the iPad (Files app), open it in Swift Playgrounds and tap Run.
For Direct, start `uv run python spikes/ios_quic/py_peer.py 47100 --p256` on the Mac.

Build the zip with: `cd spikes/ios_quic && zip -qr PeerTest.swiftpm.zip PeerTest.swiftpm -x '*.DS_Store'`.
Local pod test (port 8787 is wrangler's default; the run above used `--port 8799`):

```bash
cd rendezvous && npx wrangler dev
```

```bash
uv run python spikes/ios_quic/py_peer.py --pod ws://127.0.0.1:8787 120   # prints "invite: pod1-…"
```

```bash
cd spikes/ios_quic && swift run PeerTestCLI pod ws://127.0.0.1:8787 pod1-… 30
```

`py_peer.py --pod` keeps its pod in the spike's `.home/pod.json` and prints a fresh single-use invite on
every start. Read-only view of the live pods: `PeerTestCLI census wss://rendezvous.podtorrent.com 10`.
Public lobby: `PeerTestCLI public URL 30`. Layer download:
`LAYERS_HOME=/tmp/layers PeerTestCLI download mlx-community/Qwen3-0.6B-4bit 3 7`.

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
