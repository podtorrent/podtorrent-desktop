# Windows port plan

Goal: a click-and-run Windows app whose peers join the **same shared-inference chains** as the Mac (MLX) peers.

## First target machine
A friend's PC, used for Unreal: Ryzen 9 7950X3D (16 cores / 32 threads), 64 GB DDR5, RTX 5070 (12 GB GDDR7, Blackwell, compute capability 12.0, needs CUDA 12.8+). The owner is non-technical, so everything must work from an installer.

Capacity estimate for Qwen3-30B-A3B 4-bit (about 17 GB, 48 layers, about 0.35 GB per layer): about 26 layers fit in GPU memory, after leaving room for the KV cache and CUDA overhead. Unreal shares the GPU, so the memory cap must apply to GPU memory.

## Backend: PyTorch CUDA loading the same MLX 4-bit weights
llama.cpp/GGUF was rejected for two reasons. It has no clean way to run one range of layers on its own, and its quantization differs from MLX's, so hidden states would drift in mixed chains.

Instead, a PyTorch backend loads the same `mlx-community` slices. MLX's 4-bit format packs weights into uint32 values, with a scale and offset for every group of 64 weights; unpacking it in PyTorch is straightforward. Weights stay 4-bit on the GPU and are unpacked on the fly. Only about 8 experts are active per token, so this stays cheap.

This keeps the slicer, catalog, routing, QUIC protocol and fp16 wire format unchanged.

## Code changes
1. **Backend switch:** MLX on Apple Silicon, PyTorch elsewhere. MLX imports become conditional in `common.py` and `peer.py`. Memory reporting returns GPU memory and system RAM separately on Windows.
2. **`podtorrent/shard_torch.py`:** a Qwen3-MoE layer-range shard (attention, router, experts, KV cache) mirroring `shard.py`.
3. **Parity test (do this first):** run the same layers through MLX and through PyTorch (on CPU), on a Mac, and check the hidden states match within tolerance. This is the shared-inference guarantee.
4. **`main.rs`:**
   - Make the Unix process handling (`CommandExt`, `process_group`, `kill -TERM`) conditional per platform.
   - On Windows, start the engine with no console window (`CREATE_NO_WINDOW`) and stop it with a Job Object or `taskkill /T`.
   - Find the home directory with Tauri's `home_dir()`, not `HOME`.
   - Use `uv.exe` on Windows.
   - Replace the `sysctl` calls with the `sysinfo` crate.
5. **`tauri.windows.conf.json`:** no overlay title bar, traffic lights or `macOSPrivateApi`; use the `mica` effect or a plain window. Add an NSIS bundle target.
6. **Build scripts:** port `bundle-backend.sh` to Node so it runs on every OS. On first launch, uv installs PyTorch built for CUDA 12.8 (about 3 GB, once), with progress shown in the UI.
7. **CI:** add a `.github/workflows/windows.yml` workflow that builds the `-setup.exe` installer on a Windows runner.

## Known user-facing friction
- **SmartScreen:** without an Authenticode certificate, users must click "More info → Run anyway" once. Buy a certificate before a wider release.
- **Windows Firewall:** users must click "Allow" on first launch, or other peers can't reach the PC over QUIC/UDP. Handle the `ConnectionResetError` that Windows UDP sockets raise after ICMP replies, during hole punching.

## Later
- Intel Macs: CPU-only peers holding few layers; low priority.
- Signing and notarization for macOS releases (today's ad-hoc `-` identity is blocked by Gatekeeper).
