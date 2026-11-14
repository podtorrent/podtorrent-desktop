#!/bin/sh
# Install (or update) PodTorrent on macOS or Linux:
#
#   curl -fsSL https://podtorrent.com/install.sh | sh
#   curl -fsSL https://podtorrent.com/install.sh | sh -s -- --headless     (or --desktop, --build NAME)
#
# Picks the build for this machine (names follow downloads/src/builds.json):
#   macos-arm64               Mac app (Apple Silicon), into /Applications (or ~/Applications)
#   linux-x64-rocm            Linux desktop app for AMD Ryzen AI Max (Strix Halo, gfx1151)
#   linux-x64-cuda            Linux desktop app for NVIDIA (and other machines)
#   linux-x64-rocm-headless   no display (e.g. over SSH) on AMD Ryzen AI Max: the `podtorrent` command
#   linux-arm64-jetson-headless   NVIDIA Jetson (AGX Orin, JetPack 6 or 7), headless: the `podtorrent` command
# On Linux, a local desktop session (DISPLAY or WAYLAND_DISPLAY) means the desktop app; over SSH or with
# no display, headless.
# The download's SHA-256 is checked. No root needed. Run it again to update: the previous version is
# kept (".old"), and a running headless service is restarted on the new one. Models and settings in
# ~/.podtorrent are never touched.
#
# Environment (optional): PODTORRENT_BUILD=NAME (same as --build), PODTORRENT_FILE=PATH (install a local
# file instead of downloading, for tests; PODTORRENT_TARBALL is the old name), PODTORRENT_INSTALL_DIR
# (default ~/.local/share/podtorrent), PODTORRENT_BIN_DIR (default ~/.local/bin), PODTORRENT_APPS_DIR
# (macOS; default /Applications, else ~/Applications).
#
# POSIX sh on purpose: `| sh` is dash on Ubuntu and Debian.
set -eu

# The downloads Worker that serves this script fills in its own origin (downloads/src/index.ts).
BASE="${PODTORRENT_BASE_URL:-@PODTORRENT_BASE_URL@}"
INSTALL_DIR="${PODTORRENT_INSTALL_DIR:-$HOME/.local/share/podtorrent}"
BIN_DIR="${PODTORRENT_BIN_DIR:-$HOME/.local/bin}"
FILE="${PODTORRENT_FILE:-${PODTORRENT_TARBALL:-}}"
BUILD="${PODTORRENT_BUILD:-}"
MODE=""

say() { printf 'podtorrent: %s\n' "$*"; }
die() { printf 'podtorrent: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --headless) MODE=headless ;;
    --desktop) MODE=desktop ;;
    --build) [ $# -ge 2 ] || die "--build needs a name"; BUILD="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (options: --desktop, --headless, --build NAME)" ;;
  esac
  shift
done

[ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a folder"
if [ "$(id -u)" = 0 ] && [ -z "${PODTORRENT_ALLOW_ROOT:-}" ]; then
  die "run this as the user who will run PodTorrent, not as root (no sudo needed)"
fi

# ---- which build ----

os="$(uname -s)"
arch="$(uname -m)"
amd_halo() { grep -qs 'gfx_target_version 110501' /sys/class/kfd/kfd/topology/nodes/*/properties; }
nvidia() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; }

if [ -z "$BUILD" ]; then
  case "$os" in
    Darwin)
      [ "$arch" = arm64 ] || die "PodTorrent for macOS needs an Apple Silicon Mac (M1 or later); this one is $arch"
      [ "$MODE" != headless ] || die "there's no headless build for macOS; the Mac app runs in the background on its own"
      BUILD=macos-arm64 ;;
    Linux)
      case "$arch" in
        x86_64|amd64) ;;
        aarch64|arm64)
          [ -r /etc/nv_tegra_release ] || die "PodTorrent for ARM64 Linux is for NVIDIA Jetson only (no /etc/nv_tegra_release here)"
          [ "$MODE" != desktop ] || die "there's no desktop build for Jetson; install the headless build (--headless) and open the dashboard over SSH"
          say "found an NVIDIA Jetson ($(head -n 1 /etc/nv_tegra_release | cut -c 3-30))"
          MODE=headless BUILD=linux-arm64-jetson-headless ;;
        *) die "PodTorrent for Linux needs x86_64, or ARM64 on NVIDIA Jetson (this machine is $arch)" ;;
      esac
      if [ -z "$MODE" ]; then
        # Over SSH (even with X forwarding) means headless; a local desktop session means the desktop app.
        if [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then MODE=headless
        elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then MODE=desktop
        else MODE=headless; fi
      fi
      if [ -n "$BUILD" ]; then :
      elif amd_halo; then
        say "found an AMD Ryzen AI Max GPU (gfx1151)"
        if [ "$MODE" = headless ]; then BUILD=linux-x64-rocm-headless; else BUILD=linux-x64-rocm; fi
      elif nvidia; then
        say "found an NVIDIA GPU"
        [ "$MODE" = desktop ] || die "the headless build is for AMD Ryzen AI Max (gfx1151) only. On this NVIDIA machine, run the desktop app from a desktop session: add --desktop"
        BUILD=linux-x64-cuda
      elif [ "$MODE" = headless ]; then
        say "warning: no AMD Ryzen AI Max (gfx1151) GPU found; the headless build is for those machines."
        say "         Installing anyway; 'podtorrent setup' checks the kernel, driver and permissions and says what to fix."
        BUILD=linux-x64-rocm-headless
      else
        say "warning: no NVIDIA or AMD Ryzen AI Max GPU found; installing the NVIDIA build (use --build linux-x64-rocm for AMD)."
        BUILD=linux-x64-cuda
      fi ;;
    *) die "this installer is for macOS and Linux; on Windows run in PowerShell: irm ${BASE%/download}/install.ps1 | iex" ;;
  esac
fi
case "$BUILD" in
  macos-arm64) EXT=dmg ;;
  linux-x64-cuda|linux-x64-rocm) EXT=AppImage ;;
  linux-x64-rocm-headless|linux-arm64-jetson-headless) EXT=tar.gz ;;
  windows-x64-cuda) die "windows-x64-cuda installs from PowerShell: irm ${BASE%/download}/install.ps1 | iex" ;;
  *) die "unknown build $BUILD (macos-arm64, linux-x64-cuda, linux-x64-rocm, linux-x64-rocm-headless, linux-arm64-jetson-headless)" ;;
esac
say "installing $BUILD"

# ---- download and check ----

fetch() {  # fetch URL FILE [quiet]
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${3:-}" ]; then curl -fsSL --retry 3 -o "$2" "$1"; else curl -fL --retry 3 --progress-bar -o "$2" "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "missing curl or wget: install one and run this again"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""; fi
}

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")"
MOUNT=""
cleanup() {
  if [ -n "$MOUNT" ]; then hdiutil detach -quiet "$MOUNT" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
PKG="$TMP/podtorrent.$EXT"

if [ -n "$FILE" ]; then
  say "using $FILE"
  cp "$FILE" "$PKG"
else
  case "$BASE" in @*) die "no download server: set PODTORRENT_BASE_URL, or run the copy your downloads site serves" ;; esac
  fetch "$BASE/$BUILD" "$PKG" || die "download failed: $BASE/$BUILD"
  fetch "$BASE/$BUILD.sha256" "$TMP/sha256" quiet || die "couldn't download the checksum: $BASE/$BUILD.sha256"
  want="$(cut -d' ' -f1 "$TMP/sha256")"
  got="$(sha256 "$PKG")"
  if [ -z "$got" ]; then
    say "warning: no sha256sum or shasum here, so the download's checksum wasn't checked"
  elif [ "$got" != "$want" ]; then
    die "the download is corrupt (SHA-256 $got, expected $want); run this again"
  else
    say "checksum OK"
  fi
fi

# swap NEW DEST: put NEW at DEST, keeping what was there as DEST.old.
swap() {
  rm -rf "$2.old"
  if [ -e "$2" ]; then mv "$2" "$2.old"; fi
  mv "$1" "$2"
}

on_path() { case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; *) return 1 ;; esac; }
path_hint() {
  on_path && return 0
  say "$BIN_DIR isn't on your PATH yet: log out and back in (most distributions add it then),"
  say "or run: export PATH=\"$BIN_DIR:\$PATH\""
}

# ---- macOS ----

install_macos() {
  apps="${PODTORRENT_APPS_DIR:-}"
  if [ -z "$apps" ]; then
    if [ -w /Applications ]; then apps=/Applications; else apps="$HOME/Applications"; fi
  fi
  mkdir -p "$apps"
  MOUNT="$TMP/mnt"
  mkdir "$MOUNT"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MOUNT" "$PKG" || { MOUNT=""; die "couldn't open the disk image"; }
  src="$(find "$MOUNT" -maxdepth 1 -name '*.app' -type d | head -n 1)"
  [ -n "$src" ] || die "the disk image has no app in it"
  name="$(basename "$src")"
  ditto "$src" "$TMP/$name"
  hdiutil detach -quiet "$MOUNT" || true
  MOUNT=""
  if pgrep -x PodTorrent >/dev/null 2>&1 || pgrep -f "$apps/$name/Contents/MacOS/" >/dev/null 2>&1; then
    say "PodTorrent is running: quit it from its menu, then run this again"
    exit 1
  fi
  old_version=""
  [ -e "$apps/$name" ] && old_version="$(defaults read "$apps/$name/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
  # The previous version is kept outside Applications, so Launchpad and Spotlight show one PodTorrent.
  rm -rf "$INSTALL_DIR/$name.old"
  if [ -e "$apps/$name" ]; then mv "$apps/$name" "$INSTALL_DIR/$name.old"; fi
  mv "$TMP/$name" "$apps/$name"
  # The app isn't notarized: without this macOS calls a downloaded copy "damaged".
  xattr -dr com.apple.quarantine "$apps/$name" 2>/dev/null || true
  version="$(defaults read "$apps/$name/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo ?)"
  if [ -n "$old_version" ]; then
    say "updated PodTorrent $old_version -> $version in $apps/$name (the previous version is $INSTALL_DIR/$name.old)"
  else
    say "installed PodTorrent $version in $apps/$name"
  fi
  cat <<EOF

Open it from Applications, or run:

  open -a "$apps/$name"

EOF
}

# ---- Linux desktop (AppImage) ----

install_appimage() {
  dir="$INSTALL_DIR/desktop"
  mkdir -p "$dir" "$BIN_DIR"
  chmod +x "$PKG"
  old_version=""
  [ -f "$dir/VERSION" ] && old_version="$(cat "$dir/VERSION")"
  swap "$PKG" "$dir/PodTorrent.AppImage"
  printf '%s\n' "$BUILD" >"$dir/BUILD"
  version="$(basename "${FILE:-x}" | sed -n 's/^podtorrent-\([0-9][^-]*\)-.*/\1/p; s/^PodTorrent_\([0-9][^_]*\)_.*/\1/p' | head -n 1)"
  [ -n "$version" ] || version="$(sed -n 's/.*  podtorrent-\([0-9][^-]*\)-.*/\1/p; s/.*  PodTorrent_\([0-9][^_]*\)_.*/\1/p' "$TMP/sha256" 2>/dev/null | head -n 1)"
  printf '%s\n' "${version:-unknown}" >"$dir/VERSION"
  ln -sf "$dir/PodTorrent.AppImage" "$BIN_DIR/podtorrent-desktop"

  # A menu entry, with the app's icon when it can be pulled out of the AppImage.
  icon=podtorrent
  (cd "$TMP" && "$dir/PodTorrent.AppImage" --appimage-extract '.DirIcon' >/dev/null 2>&1) || true
  if [ -L "$TMP/squashfs-root/.DirIcon" ]; then   # usually a link to the real icon: extract that too
    (cd "$TMP" && "$dir/PodTorrent.AppImage" --appimage-extract "$(readlink "$TMP/squashfs-root/.DirIcon")" >/dev/null 2>&1) || true
  fi
  if [ -f "$TMP/squashfs-root/.DirIcon" ]; then
    mkdir -p "$HOME/.local/share/icons"
    cp -L "$TMP/squashfs-root/.DirIcon" "$HOME/.local/share/icons/podtorrent.png" 2>/dev/null && icon="$HOME/.local/share/icons/podtorrent.png"
  fi
  mkdir -p "$HOME/.local/share/applications"
  cat >"$HOME/.local/share/applications/podtorrent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PodTorrent
Comment=Serve part of a large language model, together with other machines
Exec="$dir/PodTorrent.AppImage" %U
Icon=$icon
Terminal=false
Categories=Network;Utility;
EOF
  if [ -n "$old_version" ]; then
    say "updated PodTorrent $old_version -> ${version:-?} (the previous version is $dir/PodTorrent.AppImage.old)"
  else
    say "installed PodTorrent ${version:-?} ($BUILD) in $dir"
  fi

  # AppImages need FUSE 2, which recent Ubuntu doesn't install by default.
  if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; } && [ ! -e /usr/lib/x86_64-linux-gnu/libfuse.so.2 ] && [ ! -e /lib/x86_64-linux-gnu/libfuse.so.2 ]; then
    say "AppImages need FUSE 2, which isn't installed. Install it once:"
    if grep -qs 'VERSION_ID="2[4-9]' /etc/os-release; then
      say "  sudo apt install libfuse2t64"
    else
      say "  sudo apt install libfuse2      (Fedora: sudo dnf install fuse-libs)"
    fi
  fi
  cmd=podtorrent-desktop
  on_path || cmd="$BIN_DIR/podtorrent-desktop"
  cat <<EOF

Start PodTorrent from your applications menu, or run:

  $cmd

EOF
  path_hint
}

# ---- Linux headless (tarball) ----

install_headless() {
  APP="$INSTALL_DIR/app"
  mkdir -p "$BIN_DIR" "$TMP/x"
  tar -xzf "$PKG" -C "$TMP/x" || die "couldn't unpack the download"
  new="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d -name 'podtorrent-*' | head -n 1)"
  [ -n "$new" ] && [ -x "$new/podtorrent" ] && [ -x "$new/backend/uv" ] || die "the download doesn't look like a PodTorrent headless build"
  if [ ! -f "$new/VERSION" ]; then   # builds from before the naming standard carry the version in the folder name
    basename "$new" | sed -n 's/^podtorrent-headless-v\([^-]*\)-.*/\1/p; s/^podtorrent-\([0-9][^-]*\)-.*/\1/p' | head -n 1 >"$new/VERSION"
  fi
  version="$(cat "$new/VERSION")"
  old_version=""
  [ -f "$APP/VERSION" ] && old_version="$(cat "$APP/VERSION")"
  swap "$new" "$APP"
  ln -sf "$APP/podtorrent" "$BIN_DIR/podtorrent"
  if [ -n "$old_version" ]; then
    say "updated PodTorrent $old_version -> ${version:-?} (the previous version is in $APP.old)"
  else
    say "installed PodTorrent ${version:-?} in $APP"
  fi

  # A service from before keeps running, on the new version (an earlier install may have run from an
  # unpacked tarball elsewhere).
  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/podtorrent.service"
  if [ -f "$unit" ]; then
    sed "s|^ExecStart=\"[^\"]*/podtorrent\"|ExecStart=\"$APP/podtorrent\"|" "$unit" >"$unit.new" && mv "$unit.new" "$unit"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload 2>/dev/null || true
      if systemctl --user is-active --quiet podtorrent 2>/dev/null; then
        systemctl --user restart podtorrent && say "restarted the PodTorrent service on the new version"
      fi
    fi
  fi

  cmd=podtorrent
  on_path || cmd="$BIN_DIR/podtorrent"
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
  path_hint
  say "the guide is $APP/README.md"
}

case "$BUILD" in
  macos-arm64) install_macos ;;
  linux-x64-rocm-headless|linux-arm64-jetson-headless) install_headless ;;
  *) install_appimage ;;
esac
say "update any time by running the same install command again"
