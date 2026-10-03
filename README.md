# PodTorrent

Two Apple Silicon Macs jointly serve a model neither can hold alone (Qwen3-30B-A3B, 4-bit MLX), split by layer range. One Mac is the **host** (dashboard, tokenizer, embeddings, lm_head, first layers). The other is the **worker** (remaining layers). Each Mac downloads only its own tensors from Hugging Face.

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

On Mac A (host):

```bash
uv run podtorrent host
```

It prints its address and opens the dashboard at http://localhost:8000.

On Mac B (worker), using Mac A's LAN IP (or mesh IP):

```bash
uv run podtorrent join 192.168.1.10:8000
```

Mac B appears in the dashboard's node list. Click **Load model** on the host dashboard. Each Mac downloads its own layer range (progress bars per node), loads it, and the chat box unlocks.

The worker serves a read-only status page at `http://<worker-ip>:8001`.

Ports: 8000 dashboard (host), 50051 gRPC (worker), 8001 worker status page. All unauthenticated. Use only on a trusted LAN or private mesh.

## Options

| Command | Flag | Default |
| --- | --- | --- |
| `host` | `--model` | `mlx-community/Qwen3-30B-A3B-4bit` |
| `host` | `--model-dir` | `~/.podtorrent/models/<model>` |
| `host` | `--layers` | 48 (total layers) |
| `host` | `--port`, `--no-open` | 8000 |
| `join` | `--name`, `--grpc-port`, `--status-port` | hostname, 50051, 8001 |
| `join` | `--advertise` | auto-detected IP the host should dial |

The split point is set in the dashboard (default: layer 24 of 48).

## Tests

```bash
# Needs a model dir holding the first 16 layers + embeddings + head
uv run python -m tests.golden <model-dir> --layers 16 --split 8
```

Runs 20 prompts through a host and a worker process and requires token-exact output versus a single-process reference.

## Layout

- `podtorrent/slicer.py`: downloads only the tensors for a layer range (HTTP range requests)
- `podtorrent/shard.py`: loads a layer range into MLX
- `podtorrent/worker.py`, `host.py`: gRPC pipeline ends
- `podtorrent/server.py`, `static/index.html`: dashboard and event API
- `podtorrent/pipeline.proto`: wire protocol (regenerate with `grpc_tools.protoc`)

## Desktop app (Tauri)

`app/` wraps the engine in a Mac app: pick **Host** or **Join**, and it runs `uv run podtorrent ...` in the project folder, then opens the dashboard in-window. Closing the app stops the engine. Needs Rust, Node and `uv` on the Mac.

```bash
cd app && npm install
npm run dev      # run in dev mode
npm run build    # app/src-tauri/target/release/bundle/macos/PodTorrent.app
```

The app defaults to the repo it was built from; change the path under "Project folder" if you copy the .app to another Mac (clone the repo there and `uv sync` first).
