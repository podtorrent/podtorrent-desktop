#!/bin/sh
# Stage the Python backend + uv into src-tauri/resources/backend so the .app is self-contained.
set -e
cd "$(dirname "$0")/.."
root=$(cd .. && pwd)
out=src-tauri/resources/backend
rm -rf "$out" && mkdir -p "$out"
cp "$(command -v uv)" "$out/uv"
cp "$root/pyproject.toml" "$root/uv.lock" "$root/README.md" "$out/"
rsync -a --exclude __pycache__ "$root/podtorrent/" "$out/podtorrent/"
echo "staged backend in $out"
