# PodTorrent two-Mac demo guide

Mac 1 = **host** (dashboard, tokenizer, embeddings, lm_head, layers 0-23). Mac 2 = **worker** (layers 24-47). Each Mac downloads only its own slice (about 8.5 GB each) from Hugging Face.

## Requirements (both Macs)

- Apple Silicon, 16 GB, macOS with the same major version if possible
- About 12 GB free disk and an internet connection (first run only: Python packages, then the model slice)
- Tailscale installed on both (Part B)
- Plugged in, lid open, no heavy apps running (close browsers; the slice needs about 8.5 GB plus KV cache)
- Recommended: a Hugging Face token for faster downloads (see step A3)

## Part A: One-time prep (about 20 minutes, mostly downloads)

### On the build Mac (Mac 1)

1. Install the build tools once: Rust (`curl https://sh.rustup.rs -sSf | sh`), Node (`brew install node`), and `uv` (`brew install uv`).
2. Build the app:
   ```bash
   cd podtorrent/app
   npm install
   npm run build
   ```
   Output: `app/src-tauri/target/release/bundle/macos/PodTorrent.app` (the `.dmg` is in `bundle/dmg/` if you built it).
3. (Optional) Hugging Face token: create a read token at huggingface.co/settings/tokens, then on each Mac run `mkdir -p ~/.cache/huggingface && echo -n "hf_xxx" > ~/.cache/huggingface/token`. Without it, downloads still work but may be rate limited.
4. Copy `PodTorrent.app` to Mac 1's `/Applications`.

### On Mac 2

1. Copy `PodTorrent.app` over (AirDrop, USB, or shared drive) into `/Applications`.
2. First open: right-click the app > **Open** > **Open** (it is unsigned). If macOS says it is damaged, run once: `xattr -dr com.apple.quarantine /Applications/PodTorrent.app`.
3. No terminal is needed otherwise.

### GPU memory limit (both Macs, only if loading fails with an out-of-memory error)

A 16 GB Mac caps GPU memory at roughly 10-11 GB, which can be tight for an 8.5 GB slice plus KV cache. Raise it, then note the value you used:

```bash
sudo sysctl iogpu.wired_limit_mb=13000   # resets on reboot
```

## Part B: Connect the Macs (Tailscale required)

The two Macs are on different networks, so they connect over a Tailscale mesh. Both directions matter: Mac 2 registers with Mac 1 (port 8000), then Mac 1 connects back to Mac 2 (port 50051).

1. On both Macs: install Tailscale (`brew install --cask tailscale` or tailscale.com/download), open it, and sign in to the **same** tailnet (same account, or share one Mac's device with the other).
2. Confirm each Mac shows as connected in the Tailscale menu bar app.
3. On Mac 1, get its Tailscale IP (not shown in the PodTorrent app yet): Tailscale menu > the device name > copy IP, or run `tailscale ip -4` (CLI: `/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`). It looks like `100.x.y.z`. This is the address Mac 2 enters.
4. Test from Mac 2 before starting: `curl http://100.x.y.z:8000` should connect once the host is running (or `ping 100.x.y.z`).
5. Disable any other VPN on both Macs; it can make the worker advertise the wrong IP.

If Tailscale falls back to a relay (DERP), it still works but adds latency; the dashboard timing panel will show it as network time.

Ports used (over the tailnet, no router changes needed): 8000 (host dashboard and join API), 50051 (worker gRPC, host connects to it), 8001 (worker status page). If macOS asks "Allow incoming network connections?", click **Allow** on both Macs. Everything is unauthenticated: use only over the private tailnet.

Keep both Macs awake: System Settings > Battery > Options > prevent sleep when the display is off (or run `caffeinate -dis` in a terminal).

## Part C: Run the demo

### 1. Mac 1: start the host

1. Open **PodTorrent**, click **Start as Host**.
2. First run only: the status line shows "Starting engine..." for 1-3 minutes while Python packages install into `~/.podtorrent/venv`. Wait.
3. The window switches to the dashboard. Mac 1 appears as the host node.

### 2. Mac 2: join as worker

1. Open **PodTorrent**, enter Mac 1's Tailscale address with port 8000 (for example `100.101.102.103:8000`), click **Join Host**.
2. First run: the same Python install wait. Then the window shows the worker status page.
3. Mac 2 should now appear in Mac 1's dashboard node list (name, address, status, RTT, heartbeat). If it does not, see Troubleshooting.

### 3. Mac 1: load the model

1. Check the layer map: default split is layer 24 of 48 (host 0-23, worker 24-47).
2. Click **Load model**.
3. Both Macs download their own tensors (progress bars per node, about 8.5 GB each; allow 10-30 minutes on a typical connection). Files are cached in `~/.podtorrent/models/`, so later runs skip the download.
4. After the download, each node loads its slice into memory; the memory bars fill and the chat box unlocks.

### 4. Demo inference

1. Type a prompt in the chat box (for example "Explain pipeline parallelism in two sentences").
2. Tokens stream in. Point out: the layer map with memory bars (neither Mac holds the whole model), the per-node status, and the per-token timing split into compute on each Mac versus network.
3. Optional talking points: about 4 KB of hidden state crosses the network per token; the worker never sees the tokenizer or the final output.

### 5. Shut down

Quit PodTorrent on both Macs (Cmd+Q). This stops the engine. The model cache and Python environment stay for the next run (second runs start in seconds, skipping both downloads).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Engine did not come up" | Read `~/.podtorrent/engine.log` on that Mac. Usually no internet during the first Python install, or a port already in use (quit other copies of the app). |
| Worker never appears on the host dashboard | Wrong IP, Tailscale not connected on one Mac, or the macOS firewall blocked incoming connections. From Mac 2 run `curl http://<host-ip>:8000` to test. |
| Worker listed but host cannot reach it | The worker auto-detects its IP. If it picked a wrong one (VPN active), disconnect the VPN or use the CLI: `uv run podtorrent join <host>:8000 --advertise <mac2-ip>` from a repo checkout. |
| Out-of-memory when loading | Quit other apps, raise `iogpu.wired_limit_mb` (above), or move the split so each Mac holds fewer layers. |
| Download stalls or errors | Add a Hugging Face token (A3). Re-click **Load model**; finished tensors are cached. |
| Very slow tokens across networks | Expected: each token pays one internet round trip. Check the compute-vs-network split in the timing panel. |
| Mac sleeps mid-run | Use `caffeinate -dis` or the Battery setting above. |

## Known gaps (PoC)

- The host's IP is not shown in the app; look it up as in Part B.
- The app is unsigned, Apple Silicon only, and the first launch needs internet.
- No authentication, failover, or more than two nodes.
- The end-to-end flow in the app has not yet been run on two real Macs (plan milestone M4).
