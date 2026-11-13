# Downloads: names, URLs and installers

Every PodTorrent download follows one naming standard, defined in
[`downloads/src/builds.json`](../downloads/src/builds.json) (used by the download Worker and
`publish.js`).

**Name:** `<os>-<arch>[-<gpu stack>][-headless]`
**File:** `podtorrent-<version>-<name>.<ext>`

| Name | What | File |
|---|---|---|
| `macos-arm64` | Mac app, Apple Silicon | `podtorrent-<version>-macos-arm64.dmg` |
| `windows-x64-cuda` | Windows app, NVIDIA | `podtorrent-<version>-windows-x64-cuda.exe` |
| `linux-x64-cuda` | Linux desktop app, NVIDIA | `podtorrent-<version>-linux-x64-cuda.AppImage` |
| `linux-x64-rocm` | Linux desktop app, AMD Ryzen AI Max (Strix Halo, gfx1151) | `podtorrent-<version>-linux-x64-rocm.AppImage` |
| `linux-x64-rocm-headless` | Linux without a display (SSH), AMD Ryzen AI Max | `podtorrent-<version>-linux-x64-rocm-headless.tar.gz` |

## URLs (podtorrent.com)

| URL | Gives |
|---|---|
| `/download/<name>` | the latest build (`curl -LO` / `wget --content-disposition` keep its file name) |
| `/download/<name>.<ext>` | the same, with a file name plain `wget` keeps |
| `/download/<name>.sha256` | `<sha256>  <file>` of the latest build |
| `/download/v/<version>/<name>` | that version's build |
| `/install.sh` | installer for macOS and Linux |
| `/install.ps1` | installer for Windows |
| `/download/latest.json` | the manifest |

The names from before the standard (`mac`, `windows`, `linux`, `linux-amd`, `linux-amd-cli`) keep
working anywhere a name does. Builds published before it keep their old file names.

## Installers

```bash
curl -fsSL https://podtorrent.com/install.sh | sh                     # macOS, Linux
curl -fsSL https://podtorrent.com/install.sh | sh -s -- --headless     # force headless (or --desktop, --build NAME)
```
```powershell
irm https://podtorrent.com/install.ps1 | iex                          # Windows
```

`install.sh` picks the build: macOS → `macos-arm64`; Linux with a local desktop → `linux-x64-rocm` on
AMD Ryzen AI Max, else `linux-x64-cuda`; Linux over SSH or without a display → `linux-x64-rocm-headless`.
Both installers verify the SHA-256, need no root or admin, and update in place when run again.

| Build | Installs to | Command |
|---|---|---|
| `macos-arm64` | `/Applications/PodTorrent.app` (or `~/Applications`) | `open -a PodTorrent` |
| `linux-x64-cuda`, `linux-x64-rocm` | `~/.local/share/podtorrent/desktop/PodTorrent.AppImage` + menu entry | `podtorrent-desktop` |
| `linux-x64-rocm-headless` | `~/.local/share/podtorrent/app` | `podtorrent` |
| `windows-x64-cuda` | `%LOCALAPPDATA%\PodTorrent` (per-user) | Start menu |

Sources: [`install/install.sh`](../install/install.sh), [`install/install.ps1`](../install/install.ps1).
CI runs each installer on its platform's build before publishing it.
