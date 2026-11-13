#!/bin/sh
# Install (or update) PodTorrent for headless Linux AMD machines (Ryzen AI Max / Strix Halo, gfx1151):
#
#   curl -fsSL https://podtorrent.com/install.sh | sh
#
# Downloads the latest headless build, checks its SHA-256, puts it in ~/.local/share/podtorrent/app and
# the `podtorrent` command in ~/.local/bin. No root needed. Run it again to update: the previous version
# is kept in app.old, and a running PodTorrent service is restarted on the new one. Models, PyTorch
# and settings stay in ~/.podtorrent and are never touched.
#
# Environment (all optional):
#   PODTORRENT_INSTALL_DIR   where the app goes      (default ~/.local/share/podtorrent)
#   PODTORRENT_BIN_DIR       where the command goes  (default ~/.local/bin)
#   PODTORRENT_TARBALL       install this local tarball instead of downloading (tests)
#
# POSIX sh on purpose: `| sh` is dash on Ubuntu and Debian.
set -eu

BASE="${PODTORRENT_BASE_URL:-https://podtorrent.com/download}"
URL="$BASE/linux-amd-cli.tar.gz"
INSTALL_DIR="${PODTORRENT_INSTALL_DIR:-$HOME/.local/share/podtorrent}"
BIN_DIR="${PODTORRENT_BIN_DIR:-$HOME/.local/bin}"
APP="$INSTALL_DIR/app"

say() { printf 'podtorrent: %s\n' "$*"; }
die() { printf 'podtorrent: %s\n' "$*" >&2; exit 1; }

# ---- this machine ----

[ "$(uname -s)" = Linux ] || die "this installer is for Linux; on a Mac or Windows PC use the desktop app: https://podtorrent.com/download"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "this build is for x86_64 Linux (found $(uname -m))" ;;
esac
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a folder"
if [ "$(id -u)" = 0 ] && [ -z "${PODTORRENT_ALLOW_ROOT:-}" ]; then
  die "run this as the user who will run PodTorrent, not as root (no sudo needed)"
fi
for c in tar gzip mkdir mv; do command -v "$c" >/dev/null 2>&1 || die "missing $c: install it and run this again"; done

# The only headless build is for AMD gfx1151 (ROCm). Say so early rather than after a 25 GB install.
if grep -qs 'gfx_target_version 110501' /sys/class/kfd/kfd/topology/nodes/*/properties; then
  say "found an AMD Ryzen AI Max GPU (gfx1151)"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  die "this machine has an NVIDIA GPU; the headless build is for AMD Ryzen AI Max (gfx1151) only. Use the Linux desktop app: https://podtorrent.com/download"
else
  say "warning: no AMD Ryzen AI Max (gfx1151) GPU found; this build is for those machines."
  say "         Installing anyway; 'podtorrent setup' checks the kernel, driver and permissions and says what to fix."
fi

# ---- download ----

fetch() {  # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$2" "$1" 2>/dev/null || wget -q -O "$2" "$1"
  else
    die "missing curl or wget: install one and run this again"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""; fi
}

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
TMP="$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ -n "${PODTORRENT_TARBALL:-}" ]; then
  say "installing $PODTORRENT_TARBALL"
  cp "$PODTORRENT_TARBALL" "$TMP/podtorrent.tar.gz"
else
  say "downloading the latest PodTorrent headless build"
  fetch "$URL" "$TMP/podtorrent.tar.gz" || die "download failed: $URL"
  fetch "$BASE/linux-amd-cli.sha256" "$TMP/sha256" >/dev/null 2>&1 || die "couldn't download the checksum: $BASE/linux-amd-cli.sha256"
  want="$(cut -d' ' -f1 "$TMP/sha256")"
  got="$(sha256 "$TMP/podtorrent.tar.gz")"
  if [ -z "$got" ]; then
    say "warning: no sha256sum here, so the download's checksum wasn't checked"
  elif [ "$got" != "$want" ]; then
    die "the download is corrupt (SHA-256 $got, expected $want); run this again"
  else
    say "checksum OK"
  fi
fi

# ---- unpack, then swap in ----

mkdir "$TMP/x"
tar -xzf "$TMP/podtorrent.tar.gz" -C "$TMP/x" || die "couldn't unpack the download"
new="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d -name 'podtorrent-headless-*' | head -n 1)"
[ -n "$new" ] && [ -x "$new/podtorrent" ] && [ -x "$new/backend/uv" ] || die "the download doesn't look like a PodTorrent headless build"
version="$(basename "$new" | sed -n 's/^podtorrent-headless-v\([^-]*\)-.*/\1/p')"
printf '%s\n' "${version:-unknown}" >"$new/VERSION"

old_version=""
[ -f "$APP/VERSION" ] && old_version="$(cat "$APP/VERSION")"
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$new" "$APP"
ln -sf "$APP/podtorrent" "$BIN_DIR/podtorrent"

if [ -n "$old_version" ]; then
  say "updated PodTorrent $old_version -> ${version:-?} (the previous version is in $APP.old)"
else
  say "installed PodTorrent ${version:-?} in $APP"
fi

# ---- a service from before keeps running, on the new version ----

unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/podtorrent.service"
if [ -f "$unit" ]; then
  # Point it at this install (an earlier one may have run from an unpacked tarball elsewhere).
  sed "s|^ExecStart=\"[^\"]*/podtorrent\"|ExecStart=\"$APP/podtorrent\"|" "$unit" >"$unit.new" && mv "$unit.new" "$unit"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user is-active --quiet podtorrent 2>/dev/null; then
      systemctl --user restart podtorrent && say "restarted the PodTorrent service on the new version"
    fi
  fi
fi

# ---- next steps ----

cmd="podtorrent"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) cmd="$BIN_DIR/podtorrent" ;;
esac
host="$(hostname 2>/dev/null || echo this-machine)"

cat <<EOF

PodTorrent is installed. Next:

  $cmd setup
      checks this machine, installs PyTorch for the GPU (the first time: about 25 GB, 10-30 minutes),
      suggests a model and layers, starts PodTorrent as a service, and offers to join the network
  $cmd top
      live view of this machine and the network (Ctrl-C quits)
  $cmd doctor
      if anything goes wrong: writes one file to send to PodTorrent support

To keep PodTorrent running after you log out and start it at boot (once):

  sudo loginctl enable-linger $(id -un)

To open the dashboard, run this on your own computer, then open http://127.0.0.1:27183 :

  ssh -L 27183:127.0.0.1:27183 $(id -un)@$host

EOF
if [ "$cmd" != podtorrent ]; then
  say "$BIN_DIR isn't on your PATH yet: log out and back in (most distributions add it then),"
  say "or run: export PATH=\"$BIN_DIR:\$PATH\""
fi
say "update any time by running the same install command again; the guide is $APP/README.md"
