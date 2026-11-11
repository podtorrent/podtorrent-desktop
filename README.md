# PodTorrent

Apple Silicon Macs jointly serve a model none of them can hold alone (Qwen3-30B-A3B, 4-bit MLX), split by layer range. Every Mac runs the same **peer**: it serves a layer slice to the swarm and can request completions itself. Peers anywhere on the internet find each other through a small rendezvous service and connect directly over QUIC (UDP hole punching; no VPN, no relay). Each Mac downloads only its own tensors from Hugging Face. Design: [docs/P2P_PLAN.md](docs/P2P_PLAN.md).

Two-Mac demo walkthrough: [docs/DEMO.md](docs/DEMO.md).

Status and plan: [PodTorrent PoC Plan and Build Checklist.md](PodTorrent%20PoC%20Plan%20and%20Build%20Checklist.md).

## Setup (both Macs)

```bash
brew install uv            # or: curl -LsSf https://astral.sh/uv/install.sh | sh
git clone <this repo> podtorrent && cd podtorrent
uv sync
uv run python -c "import mlx.core as mx; print(mx.__version__)"   # must match on both Macs
```

Optional but recommended: a Hugging Face token for faster downloads (`huggingface-cli login`, or `export HF_TOKEN=...`).

Keep the Macs awake during runs: `caffeinate -dis &`.

A 16 GB Mac may need a higher GPU wired-memory limit for an ~8.5 GB slice plus KV cache:

```bash
sudo sysctl iogpu.wired_limit_mb=13000   # resets on reboot; note the value you use
```

## Run

On every Mac:

```bash
uv run podtorrent peer                  # serve nothing yet; local API + dashboard on http://127.0.0.1:27183
uv run podtorrent peer --serve 24:48    # or serve a layer range right away (remembered in ~/.podtorrent/config.json)
```

A peer can serve several slices, of several models (any `qwen3_moe` MLX repo), at once. While it runs:

```bash
uv run podtorrent serve 0:12                                   # another slice of the default model
uv run podtorrent serve mlx-community/Qwen3-30B-A3B-4bit:24:48 --peer mac-b   # ask a connected peer instead
uv run podtorrent unserve 0:12                                 # or `unserve <model>` for all its slices
uv run podtorrent models                                       # per-layer coverage, gaps and route for each model
```

Before downloading, a slice is checked against this Mac's GPU memory budget (macOS's recommended working set, about 75% of RAM; cap it with `PODTORRENT_MEM_BUDGET_GB`) and refused if it won't fit.

Peers appear in each other's swarm within seconds. Click **Load model** on any Mac: it serves layers `[0, 24)` itself and asks a connected Mac that serves nothing to load the rest. Once every layer has a reachable peer, the chat box unlocks. Any Mac can then chat; its prompts route through the peers' slices.

`uv run podtorrent swarm --watch` lists every online peer and whether this Mac reaches it directly (with RTT) or not.

The local API binds to 127.0.0.1 only; other Macs talk to this one over QUIC on a UDP port (random; pin it with `PODTORRENT_UDP_PORT`). QUIC is encrypted and both ends prove their peer IDs, but the swarm is open: any PodTorrent peer can send work to yours.

## Serving the PodTorrent network

A peer can offer the models its swarm fully covers to PodTorrent network clients. The app bundles
[podtorrent-agent](https://github.com/Munerate/podtorrent-agent); in **Settings → PodTorrent Network**
enter an approved node id and node token (saved as `node-token` in the data folder, readable by your user only) and click **Join Network**.
This Mac becomes the head of each route: the agent forwards network requests to the peer's loopback
`POST /v1/chat/completions` and `GET /v1/models`, and the peer runs them through the swarm's slices.

- The peer writes `network-manifest.json` in the data folder (from `network.json`, which the app
  saves): one entry per fully covered model, with `slots: 1` and the current route as `pipeline`.
  The agent picks up changes as routes change.
- Generation is greedy; sampling parameters are accepted and ignored.
- This node's operator is paid for each request. Every machine on the route sees the model's
  intermediate state for it.
- Building the app stages the agent: `PODTORRENT_AGENT_BIN=/path/to/podtorrent-agent`, or a
  `podtorrent-agent` checkout next to this repo and Go 1.24+ (`PODTORRENT_GO` to pick a `go`).

## Options

| Command | Flag | Default |
| --- | --- | --- |
| `peer` | `--model` | `mlx-community/Qwen3-30B-A3B-4bit` |
| `peer` | `--model-dir` | `~/.podtorrent/models/<model>` |
| `peer` | `--layers` | from the model's config (48) |
| `peer` | `--serve [MODEL:]LO:HI` (repeatable) | the slices served last time, else nothing |
| `peer` | `--port`, `--open` | 27183 (or `PODTORRENT_PORT`), don't open a browser |

## Tests

```bash
# Needs a model dir holding the first 16 layers + embeddings + head
uv run python -m tests.golden <model-dir> --layers 16 --splits 5,10
uv run python -m tests.golden <model-dir> --layers 16 --splits 5,10 --tokens 60 --prompts 6 --failover
uv run python -m tests.multi <model-dir>   # several slices and models per peer, serve/unserve, memory check
uv run --with pytest pytest tests/test_route.py
```

Starts one peer process per slice (`[0,5)`, `[5,10)`, `[10,16)`), lets them connect over QUIC through the rendezvous, runs 20 prompts through the chain and requires token-exact output versus a single-process reference.

## Layout

- `podtorrent/slicer.py`: downloads only the tensors for a layer range (HTTP range requests)
- `podtorrent/shard.py`: loads a layer range into MLX
- `podtorrent/peer.py`: the peer runtime (serving, requesting, local API and event stream)
- `podtorrent/route.py`: plans which peers run which layers
- `podtorrent/net/`: identity keys, STUN, rendezvous client, QUIC transport and hole punching
- `rendezvous/`: the Cloudflare Worker that keeps the global peer registry
- `podtorrent/pipeline.proto`: message schema (regenerate with `uv run python -m grpc_tools.protoc -I podtorrent --python_out=podtorrent podtorrent/pipeline.proto`)

## Desktop app (Tauri)

`app/` builds a self-contained Mac app (Apple Silicon). It bundles `uv` and the Python backend; on first launch it installs its Python environment into `~/.podtorrent/venv` (needs internet, one-time), then runs the engine itself. No terminal on the second Mac: copy `PodTorrent.app`, open it, click **Join Host**, type the host's address.

```bash
cd app && npm install
npm run dev      # dev mode
npm run build    # app/src-tauri/target/release/bundle/macos/PodTorrent.app (also .dmg)
```

The app keeps its own UI (Swarm, Models, Playground, My Node, Peers, Activity) and talks to the engine over HTTP/WebSocket; closing the window keeps the node running in the menu bar, ⌘Q quits. UI docs: [UI_AUDIT](docs/UI_AUDIT.md), [DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md), [UI_DATA_GAPS](docs/UI_DATA_GAPS.md). Preview the UI in a browser: `python3 app/scripts/serve-ui.py`.

Engine output goes to `~/.podtorrent/engine.log`. The app is unsigned: on another Mac, right-click > Open the first time (or `xattr -dr com.apple.quarantine PodTorrent.app`).
