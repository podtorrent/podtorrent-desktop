# PodTorrent P2P: implementation plan

Status: phases 1–6 built, awaiting the multi-Mac tests · updated 2026-10-08

## Goal

Remove Tailscale and the host/worker split. Every PodTorrent Mac is a **peer** that:

- **serves** zero or more model slices (`model A: layers [x, y)`, `model B: layers [x, y)`, ...), and
- **requests** completions from any model the swarm can fully cover.

Peers anywhere on the internet discover each other automatically and connect directly.

```
peer 1: model A layers [0, 24)  ; model B layers [0, 40)
peer 2: model B layers [40, 80)
peer 3: model A layers [24, 48)
peer 4: (serves nothing, only requests)
```

Model A is available through peer 1 → peer 3. Model B is available through peer 1 → peer 2.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Network | Peers are on different networks, behind NAT. |
| Discovery | Global: every online peer sees every other peer. There is no join code. |
| Connectivity | Direct only, through UDP hole punching. There is **no relay**. A peer we can't reach is excluded from routes and shown as unreachable. |
| Infra | A cheap rendezvous service: a Cloudflare Worker with a Durable Object, free tier, sized for 10–15 peers. |
| Roles | No host or worker. All peers are equal. |
| Scope | Everything that works over Tailscale today keeps working: inference, the playground, telemetry, and the peers and swarm views. |

## Current state (what changes)

- `server.py` (the host) owns the tokenizer, embeddings, layers `[0, k)` and the head. It drives inference against one `worker_addr` (`host.py:45`). It chooses the split itself (`server.py:141`).
- `worker.py` runs a gRPC `Pipeline` server (`Forward`, `Heartbeat`, `Info`, `Load`) on TCP port 50051. It registers with the host over HTTP using a Tailscale or LAN IP (`worker.py:194`).
- `server.py:34` picks the Tailscale IP from the `100.64/10` range.
- The UI talks about the host and worker roles and Tailscale in: `onboarding.js`, `actions.js`, `views/node.js`, `views/models.js`, `views/settings.js`, `demo.js`.
- The Tauri commands (`main.rs`) start `host`, `join <addr>` or `download --split`.
- Slices are already fetched on demand through HTTP range requests (`slicer.py`), and `Shard(lo, hi, embed, head)` already supports any range. **Both are reused unchanged.**

## Architecture

```
            ┌──────────────────────────────────────┐
            │ Rendezvous (CF Worker + Durable Obj) │
            │  - peer registry (heartbeat, TTL)    │
            │  - hole-punch signaling (WebSocket)  │
            └──────────────────────────────────────┘
                 ▲ wss            ▲ wss          ▲ wss
           ┌─────┴────┐     ┌─────┴────┐   ┌─────┴────┐
           │ peer A   │◄───►│ peer B   │   │ peer C   │
           │ QUIC/UDP │ direct, encrypted │          │
           └──────────┘                    └──────────┘
```

### 1. Rendezvous service (`rendezvous/`, new)

- A Cloudflare Worker with one Durable Object, `Swarm`, deployed with `wrangler`.
- Each peer keeps one WebSocket open to it. The Durable Object uses the WebSocket Hibernation API, which keeps costs at about $0.
- **Peer record:** `{peer_id, name, chip, mem_total_gb, mem_free_gb, public_endpoints[], slices: [{model, lo, hi, loaded}], has_head: {model: bool}, version, last_seen}`
- **Messages:**
  - `hello` / `update`: the peer upserts its own record.
  - `peers`: the server pushes the full list on every change. At 15 peers that's tiny.
  - `punch {to}`: the server relays the request to the target, along with both peers' endpoints, so both sides start punching at the same time.
- A record expires 30 s after the peer's last heartbeat.
- **Endpoints:** each peer learns its own public `ip:port` from a STUN server (Cloudflare or Google), using the **same UDP socket** as QUIC. It also publishes its LAN addresses, so two Macs on the same network connect locally.

### 2. Peer transport (`podtorrent/net/`, new)

- **QUIC over a single UDP socket**, using `aioquic`. This replaces the gRPC/TCP transport, which can't be hole-punched reliably.
- **Hole punching:**
  1. On `punch`, both peers send UDP probes to every candidate endpoint of the other, for about 3 s.
  2. The first one that gets an answer completes the QUIC handshake.
  3. If none succeeds, the target is marked `unreachable` for that pair and retried after 60 s.
- **Identity:**
  - Each peer has an Ed25519 keypair stored in `~/.podtorrent/identity`.
  - `peer_id` = the hash of its public key.
  - The QUIC TLS certificate is self-signed with that key, and the dialer checks it against the `peer_id`. So connections are encrypted and can't be impersonated. They are **not** private from the peers on the route itself; that is a known demo limitation.
- **RPC:** keep `pipeline.proto` as the message schema. Each RPC is framed as length-prefixed protobuf on its own QUIC stream. `Forward` uses a long-lived bidirectional stream per session.
- **Proto changes:**
  - `ForwardRequest` and `LoadRequest` gain `model`.
  - `ForwardRequest` gains `session_id`. It is already `request_id`; rename it for clarity.
  - `NodeInfo` becomes a list of slices.

### 3. Peer runtime (`podtorrent/peer.py`, replaces `server.py` + `worker.py`)

- One process per Mac, started with `podtorrent peer`.
- **Serving:**
  - Holds a dict `{(model, lo, hi): Shard}`. Slices to serve come from `~/.podtorrent/config.json` and are downloaded on demand through `slicer.download_slice`.
  - Serves `Forward`, `Heartbeat`, `Info` and `Load`. Keeps a KV cache per `(session_id, slice)` and evicts it on `release` or after 5 minutes idle.
  - Rejects a slice up front if `mem_free_gb` is too low.
- **Requesting:**
  1. The requester lazily loads the tokenizer, the embeddings and the head (`Shard(..., 0, 0, embed=True, head=True)`). That's about 1 GB for Qwen3-30B-A3B.
  2. It plans a route (section 4).
  3. For each token, it runs embed → `Forward` on each route hop in turn → head → sample. This generalizes `host.py` from one remote call per token to N.
- **Local API:** keeps the current local HTTP API on `127.0.0.1:8000` for the UI. It binds to loopback only, because remote access now goes through QUIC. The current host endpoints are folded into it: status, the events stream, the playground, and the layer map.

### 4. Routing (`podtorrent/route.py`, new, pure functions)

- **Input:** the model's layer count, plus the reachable peers' loaded slices with each peer's RTT.
- **Output:** an ordered list of hops covering `[0, n)` exactly once (`[(peer, lo, hi)]`), or the gaps that block it.
- **Algorithm:** a shortest-path search (Dijkstra) over layer boundaries. An edge `lo → hi` exists when a peer serves a slice that covers it, and its cost is that peer's RTT plus an estimated compute time. A peer serving `[0, 24)` can also run `[8, 24)`, so overlapping slices still produce valid routes.
- **Failover:** if a hop fails mid-generation, re-plan around that peer and replay the prompt to rebuild the KV cache. A partial answer is kept.
- Ships with unit tests: overlaps, gaps, a single peer covering everything, ties.

### 5. Desktop app and UI

- **Tauri (`main.rs`):**
  - Replace `host` / `join <addr>` / `download --split` with `peer` (start), `serve {model, lo, hi}` and `unserve`.
  - Drop the Tailscale IP detection.
- **Onboarding:** "Name this Mac → choose what to serve (or nothing) → done". There's no role picker and no address to type.
- **Swarm / Peers view:** every online peer, showing its name, chip, memory, slices, RTT, and reachability (`direct` / `connecting` / `unreachable`).
- **Models view** (rewrite of `views/models.js`):
  - Each model has a **coverage bar**: one cell per layer, shaded by how many reachable peers serve it.
  - States are `Available · N routes`, `Partial · layers 24–47 missing`, or `Offline`.
  - A "Serve missing layers" action pre-fills the serve dialog with the gap.
- **My Node view:** the slices this Mac serves, with load or download progress, memory, active sessions, and tokens served for others.
- **Playground:**
  - The model picker lists only available models.
  - The trace shows the route `You → Mac A [0,16) → Mac C [16,48) → You`, with per-hop timing for each token. This reuses `viz/trace.js` and `viz/strip.js`.
- **Copy cleanup:** remove all Tailscale wording from `onboarding.js`, `actions.js`, `views/node.js`, `views/models.js`, `views/settings.js` and `demo.js`.
- **Demo Mode (`demo.js`):** simulates four peers, two models, one gap, and a peer joining live that fills the gap.

## Phases

Each phase ends in a runnable state and its own commit or PR.

1. **Rendezvous and discovery** (in progress)
   - [x] Write the Worker and Durable Object (`rendezvous/`).
   - [x] Deploy it to `wss://rendezvous.podtorrent.com`.
   - [x] Write `podtorrent/net/rendezvous.py` (a WebSocket client), the identity keys (`identity.py`) and a STUN client (`stun.py`).
   - [x] The host and worker processes register themselves. Add the `podtorrent swarm [--watch]` CLI.
   - [x] Add the "Online in the swarm" card to the Peers view.
   - [x] Build the app (`PodTorrent_0.1.0_aarch64.dmg`) with the swarm code bundled.
   - [x] Tested locally: peers appear on join and disappear on leave, and the deployed registry works from this Mac.
   - [ ] *Done when:* two Macs on different networks see each other within 5 s. Waiting on the second Mac running the app.
2. **QUIC transport and hole punching** (built, awaiting the two-Mac test)
   - [x] Fix: STUN now runs on the QUIC socket (`PeerNet.stun`), so the published public port is the one QUIC uses. LAN endpoints carry the port too.
   - [x] Write `podtorrent/net/quic.py`: one UDP socket demuxes STUN, punch probes and QUIC. The smaller `peer_id` asks the rendezvous to `punch`; both sides probe every candidate for 4 s, and the initiator dials QUIC to the first address that answers.
   - [x] Identity: the server's TLS certificate is self-signed with its Ed25519 key, and the client checks it against the `peer_id`. The client proves its own `peer_id` with a signed `auth` frame.
   - [x] Port `Heartbeat` (RTT every 2 s) and `Info` (every 10 s) to QUIC as length-prefixed protobuf, one stream per call. The host and worker both start a `PeerNet`; gRPC still carries inference until phase 3.
   - [x] Each swarm peer carries a `link` (`connecting` / `direct` + RTT / `unreachable` + reason). The Peers card shows it, and so does `podtorrent swarm [--watch]`. Unreachable pairs are retried after 60 s.
   - [x] Tested locally: two peers on one Mac go `direct via lan` with a ~3 ms RTT, and a peer with a dead endpoint goes `unreachable (hole punch timed out)`.
   - [ ] *Done when:* two Macs behind home NATs show `direct` with live RTT, and an unreachable pair shows a clear error.
3. **Unified peer runtime** (built, awaiting the two-Mac test)
   - [x] Write `peer.py`: serving (`Slices`, KV cache per session and hop, evicted after 5 min idle) and requesting (embeddings + head loaded lazily, N hops per token). One MLX lock per process; network waits don't hold it.
   - [x] Port `Forward` (one QUIC stream per session and hop) and `Load` (streams progress) to QUIC. The proto gains `model`, `layer_lo/hi`, `session_id`, `ForwardResponse.error` and `NodeInfo.slices`; gRPC is gone.
   - [x] Any sub-range of a served slice can run (`Shard.run_layers(lo, hi)`), and a simple greedy `route.py` plans the hops. Phase 4 replaces it with the shortest-path search.
   - [x] The local API keeps the old host's event shapes, so the UI works as-is. "Load model" serves `[0, split)` here and asks a connected peer to `Load` the gap. The served slice is saved in `~/.podtorrent/config.json`, and there's a new `podtorrent peer --serve lo:hi`.
   - [x] Deleted `server.py`, `worker.py`, `host.py`, the gRPC stubs and the `join` CLI. Tauri starts `peer`, and the UI's Join now just starts the peer.
   - [x] Tested locally: `tests/golden.py` runs three peer processes `[0,5) → [5,10) → [10,16)` over QUIC and gets 20/20 token-exact against the reference, at ~4 ms network+serde per token. A remote `Load` triggered through `/api/start` also works.
   - [ ] *Done when:* the current two-Mac demo works with no Tailscale and no roles.
4. **Routing and 3+ peers** (built, awaiting the three-Mac test)
   - [x] `route.py` is a Dijkstra search over slice boundaries: cost is RTT per remote hop plus ~1 ms per layer, ties go to fewer hops and then the lower `peer_id`, and consecutive hops on one peer merge. `plan(..., exclude=)` skips failed peers. `tests/test_route.py` has 12 cases: overlaps, gaps, sub-range hand-offs, ties, exclusion and clamping.
   - [x] Failover in `PeerApp.generate`: a hop that errors or times out (10 s per decode token, 120 s for prefill) marks that peer failed, re-plans without it, and replays prompt + output so far on a fresh session to rebuild the KV cache. Tokens already streamed are kept. A `reroute` event goes to the UI, and it gives up after 3 re-routes or when a gap opens.
   - [x] `PODTORRENT_NAME` overrides the peer name, so local multi-peer tests can tell peers apart.
   - [x] Tested locally: `tests.golden --failover` runs `[0,5) [5,10) [10,16) [10,16)`, kills the routed last-slice peer mid-answer, and the answer finishes on the other one (6/6 pass). After the replay, greedy output can drift from the reference, because a one-shot prefill's float math differs slightly from step-by-step decode. The test checks that every token before the switch matches.
   - [ ] *Done when:* three Macs serving 0–16, 16–32 and 32–48 answer a prompt, and killing a redundant peer mid-answer re-routes.
5. **Multiple models and slices per peer** (built, awaiting the multi-Mac test)
   - [x] `Slices` holds any number of `(model, lo, hi)` slices, each with its own download / load state. A hop that spans adjacent slices on one peer runs through them in turn. Loading a slice that contains others of the same model replaces them once it's ready.
   - [x] Memory check before any download: the slice's estimated size (from the index's `total_size`) plus 1 GB headroom must fit in the Metal working-set budget minus active memory. `PODTORRENT_MEM_BUDGET_GB` caps the budget. "Load model" only asks helpers with enough `mem_free_gb`.
   - [x] Per-model heads, tokenizers, layer counts and routes. `/api/chat` and `/api/complete` take `model`; the default model is still `--model`. Remote `Load` accepts any `qwen3_moe` repo; other architectures are refused after fetching only `config.json`.
   - [x] `~/.podtorrent/config.json` keeps `serve` as a list (a phase 3 single entry still loads). `podtorrent peer --serve [MODEL:]LO:HI` is repeatable. New `/api/serve` (optionally `peer`, to ask a connected peer), `/api/unserve`, and the `podtorrent serve | unserve | models` CLI.
   - [x] Coverage: records and `NodeInfo` carry `mem_free_gb` and each slice's `n_layers`. `/api/models` and a `models` event give, per model: per-layer peer counts (reachable and all online), state (`available` / `partial` / `offline`), gaps, redundancy, and the route. `route.coverage()` is unit tested.
   - [x] Tested locally: `tests.multi` runs two peers serving two models (the second is the first 8 layers under another name): both answer token-exact through A → B → A and A → B routes, unserving on B turns the model partial with the right gap, serving the gap on A restores it, an oversized slice is refused up front, and the config remembers every slice. `tests.golden` (5/5) and `--failover` still pass.
   - [ ] *Done when:* two Macs each serve slices of two models and both models answer from either Mac.
6. **UI** (built; checked in the browser preview against Demo Mode and a real local peer)
   - [x] Store: handles the peer's `models`, `slices` and `reroute` events. Each model's coverage is computed from the swarm records (who serves which layers, and whether this Mac reaches them directly), with the engine's route, gaps and state.
   - [x] Models: one card per model in the swarm, with a coverage bar (one cell per layer, stacked by peers; serving / loading / not reachable / no peer), `Available · N routes` / `Partial · layers 80–93 missing` / `Offline`, the route this Mac would use, and **Serve missing layers**, which pre-fills the new Serve layers sheet (model, range, and this Mac or a connected peer, with free memory).
   - [x] My Node: a "Slices this Mac serves" card with download progress, free memory and Stop serving. Host addresses are gone.
   - [x] Playground: the picker lists available models and chat sends `model`; each reply shows its route (`You → studio 0–59 → mac-mini 60–75 → mbp-16 76–93 → You`, both routes after a re-route), and the token trace labels hops from the route.
   - [x] Onboarding: name this Mac → choose what to serve (nothing, a half, or a quarter, with a fit check) → done. The name goes to the engine as `PODTORRENT_NAME`; the slice is served once the peer is up.
   - [x] Demo Mode emits the same events as the peer: four Macs, two models, an unreachable peer, a gap in the big model that a Mac joining after ~12 s fills. Serve, unserve and Load model are simulated too.
   - [x] Copy cleanup: no host / worker / Tailscale wording left in the UI; the tray shows what this Mac serves.
   - [x] Tauri: removed the host/worker downloader (`start_download`, `download_status`); `start_engine` takes the peer name. The UI calls the local API for serve / unserve directly, so no new Tauri commands were needed.
   - [ ] *Done when:* the app build runs this on two Macs.

## Risks and open items

- **Direct-only reachability:** pairs where either side is behind a symmetric NAT or carrier-grade NAT (mobile hotspots, some ISPs and offices) will not connect. Expect roughly 10% of pairs. Mitigations: try the LAN and IPv6 endpoints first, and show clear "unreachable" UX. A relay can be added later behind the same transport interface.
- **Latency:** each hop costs one RTT per token, so a three-hop route across cities may run at only a few tokens per second. The route planner prefers fewer and closer hops.
- **Open swarm:** with global visibility, anyone running the app can send work to your Mac and see the hidden states routed through it. That's acceptable for the demo. Before a public release: a swarm key, rate limits, and a per-peer opt-out.
- **Model identity:** peers must agree on the exact weights. Key slices by `repo@revision`, not just the repo name.
- **Requester memory:** the embeddings and head add about 1 GB even on a Mac that serves nothing.
- **`aioquic` throughput:** it's pure Python. Hidden states are about 8 KB per token at decode time, so this should be fine, but prefill on long prompts needs measuring in phase 2. Fallback: a small Rust QUIC sidecar (`quinn`) in the Tauri app.
