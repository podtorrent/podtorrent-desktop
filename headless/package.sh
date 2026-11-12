#!/usr/bin/env bash
# Build podtorrent-headless-vX.Y.Z-linux-amd64-rocm.tar.gz: uv, the Python backend locked to ROCm PyTorch,
# podtorrent-agent, the `podtorrent` launcher and README.md (the user's guide). No Tauri, no GTK. Run on Linux x86_64 (uv is copied in).
#
#   PODTORRENT_AGENT_BIN=/path/to/podtorrent-agent headless/package.sh [out-dir]
#
# PODTORRENT_TORCH_INDEX picks the ROCm wheel index (default gfx1151, Strix Halo). VERSION overrides the
# version in the file name (default: pyproject.toml's).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(mkdir -p "${1:-$root/dist}" && cd "${1:-$root/dist}" && pwd)"
version="${VERSION:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/pyproject.toml" | head -n1)}"
name="podtorrent-headless-v$version-linux-amd64-rocm"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/$name"
PODTORRENT_BACKEND_OUT="$stage/$name/backend" \
PODTORRENT_TORCH_INDEX="${PODTORRENT_TORCH_INDEX:-https://repo.amd.com/rocm/whl/gfx1151/}" \
  node "$root/app/scripts/bundle-backend.js"
[[ -x "$stage/$name/backend/podtorrent-agent" ]] || { echo "podtorrent-agent was not staged; set PODTORRENT_AGENT_BIN" >&2; exit 1; }
grep -q 'repo.amd.com/rocm' "$stage/$name/backend/pyproject.toml" || { echo "backend is not locked to ROCm" >&2; exit 1; }
cp "$root/headless/podtorrent" "$stage/$name/podtorrent"
cp "$root/headless/README.md" "$stage/$name/README.md"
chmod +x "$stage/$name/podtorrent"
tar -C "$stage" -czf "$out/$name.tar.gz" "$name"
echo "$out/$name.tar.gz"
