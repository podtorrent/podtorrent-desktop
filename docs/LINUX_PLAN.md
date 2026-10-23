# Linux port plan

Goal: a click-and-run Linux app (x86_64, NVIDIA GPU) whose peers join the **same shared-inference chains** as the Mac (MLX) and Windows (PyTorch CUDA) peers.

## Starting point
The Windows port did most of the work. Linux already takes the "not macOS" path almost everywhere:
- **Backend:** `backend.py` picks PyTorch whenever the machine is not Apple Silicon, and `_cpu_name()` already reads `/proc/cpuinfo`.
- **Dependencies:** `pyproject.toml` already sends Linux to the `pytorch-cu128` index.
- **Engine process:** `main.rs` uses `#[cfg(unix)]` for `process_group(0)` and `kill -TERM -pid`, which work on Linux unchanged.
- **System health:** `system_health()` (sysinfo + `nvidia-smi`) is `not(macos)`. `power_status()` already has a Linux stub.
- **Build:** `bundle-backend.js` is already cross-platform.

So most of the work is packaging, CI, distribution, and Linux desktop quirks, not inference code.

## First target
Ubuntu 22.04/24.04 desktop, x86_64, NVIDIA RTX GPU with a 570+ driver (needed for CUDA 12.8 / Blackwell). Other distros work if they can run an AppImage. AMD (ROCm) and CPU-only peers come later.

## Code changes
1. **`tauri.linux.conf.json`:** a plain decorated window, like the Windows config: no overlay title bar, no transparency, no `macOSPrivateApi`. Bundle targets: `appimage` (the click-and-run download) and `deb`.
2. **`main.rs`:**
   - The `/opt/homebrew/bin` PATH prefix is harmless, but limit it to macOS.
   - `power_status()` on Linux: read `/sys/class/power_supply/*/{type,online,capacity}` for AC or battery and the battery percentage. Read the power-profiles-daemon `power-saver` state, if present, as low power.
   - **Tray:** Linux trays (libayatana-appindicator) don't deliver click events; they only open the menu. Make sure the tray menu has a "Show PodTorrent" item, since the `!macos` left-click → `show_main` path never fires on Linux. GNOME needs the AppIndicator extension to show a tray icon at all, so the app must work fine without a tray.
   - **WebKitGTK:** set `WEBKIT_DISABLE_DMABUF_RENDERER=1` at startup when an NVIDIA GPU is present. Without it, the window is often blank or flickers on NVIDIA with Wayland.
   - Notifications go through libnotify via `tauri-plugin-notification`; nothing to change, but test them.
3. **UI (`app/ui`):** WebKitGTK is the oldest of the three webviews. Check `backdrop-filter`, the canvas visualisations (`viz/*.js`), and CSS features in `tokens.css` and `shell.css`. Check that `native.js` and `onboarding.js` don't assume a value of `"mac"` or `"windows"` for `os`. `system_health` should report `"linux"`.
4. **Python engine:**
   - `video/service.py` branches on `WIN`. Review the non-Windows branch: it was written for Macs and may assume MLX or Metal for the ComfyUI/video path on Linux. The video encoder must work with Linux peers taking leftover layers, as Windows does.
   - Memory reporting: same as Windows (GPU memory from torch/`nvidia-smi`, system RAM from psutil).
   - When `torch.cuda.is_available()` is false (no driver or an old driver), show a clear UI error that names the driver version needed, rather than quietly falling back to a CPU peer.
5. **Networking:** UDP hole punching needs nothing special on Linux. Most desktop distros ship with the firewall (ufw/firewalld) off. If it's on, show a "machine or peer unreachable" hint pointing at the UDP port, as on Windows.

## Packaging and first run
- **AppImage:** the bundled `uv` (Linux x86_64 build) installs Python and CUDA PyTorch (~3 GB) into `~/.podtorrent` on first launch, with the same progress UI as Windows (`UV_CACHE_DIR` is already set on non-macOS).
- **glibc:** build on **ubuntu-22.04** so the AppImage runs on 22.04 and newer.
- **Runtime libraries:** `.deb` depends on `libwebkit2gtk-4.1-0`, `libayatana-appindicator3-1` and `libnotify4`. The AppImage bundles them.
- **Auto-update:** the Tauri updater supports AppImage. Hook it into the same feed as Windows, if that's how Windows updates. Version bumps must also update `tauri.linux.conf.json`, if it ever holds a version.

## CI and distribution
1. **`.github/workflows/linux.yml`:** a copy of `windows.yml` running on `ubuntu-22.04`. Steps:
   - Install `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.
   - Run `node scripts/bundle-backend.js`.
   - Run `npx tauri build --bundles appimage,deb`.
   - Upload the artifacts.
   - On a `v*` tag, run `publish.js linux <AppImage>`.
2. **`downloads/`:**
   - Add `"linux"` to `PLATFORMS`, the route regexes, the `Release` type and the download page row ("Linux (x64, AppImage)").
   - Add it to the `publish.js` usage check and to its latest-keeping loop.

## Testing
1. **Smoke test in CI:** run the engine's unit tests (`tests/test_*.py`) on `ubuntu-latest` (CPU torch) to catch Linux-only import or path bugs.
2. **Parity:** the torch path is already parity-tested against MLX. Repeat `tests/parity.py` once on a Linux CUDA box to confirm the hidden states match across platforms.
3. **Real chain:** run a Linux CUDA VM (any cloud GPU instance on a different network) in one chain with a Mac and the Windows PC. Run the chat demo, then the video demo with ≥1 Mac.
4. **Desktop matrix:** Ubuntu GNOME on Wayland, Ubuntu GNOME on X11, and KDE. Check the window, tray, notifications and first-run install.

## Order of work
1. `tauri.linux.conf.json`, the `main.rs` fixes, and `linux.yml` producing an AppImage.
2. Downloads worker plus publish for `linux`.
3. Review the video service on Linux, and add the CUDA/driver error UX.
4. Cloud GPU end-to-end chain test, then release.

## Later
- AMD GPUs via ROCm PyTorch (a separate wheel index; RDNA3+ only).
- ARM64 Linux (Jetson / Grace) peers.
- Flatpak packaging.
