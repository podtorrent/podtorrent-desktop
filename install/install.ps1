# Install (or update) PodTorrent on Windows. In PowerShell:
#
#   irm https://podtorrent.com/install.ps1 | iex
#
# Downloads the latest windows-x64-cuda build (names follow downloads/src/builds.json), checks its SHA-256
# and runs the installer silently for this user (no admin needed). Run it again to update; models and
# settings are kept.
#
# Environment (optional): PODTORRENT_FILE=PATH installs a local installer instead of downloading (tests);
# PODTORRENT_BASE_URL overrides the download server (the site that serves this script, podtorrent.com, fills in its own).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar

function Say($m) { Write-Host "podtorrent: $m" }
function Die($m) { Write-Host "podtorrent: $m" -ForegroundColor Red; throw "podtorrent: $m" }

$build = 'windows-x64-cuda'
$base = if ($env:PODTORRENT_BASE_URL) { $env:PODTORRENT_BASE_URL } else { '@PODTORRENT_BASE_URL@' }

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Die "PodTorrent for Windows needs 64-bit x64 Windows"
}
$gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
if ($gpus -match 'NVIDIA') {
  Say "found $(@($gpus -match 'NVIDIA')[0])"
} else {
  Say "warning: no NVIDIA GPU found ($($gpus -join ', ')). PodTorrent for Windows needs an NVIDIA RTX GPU with driver 570 or newer; installing anyway."
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("podtorrent-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$exe = Join-Path $tmp 'podtorrent-setup.exe'
try {
  if ($env:PODTORRENT_FILE) {
    Say "using $env:PODTORRENT_FILE"
    Copy-Item $env:PODTORRENT_FILE $exe
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($base.StartsWith('@')) { Die "no download server: set PODTORRENT_BASE_URL, or run the copy your downloads site serves" }
    Say "downloading the latest PodTorrent for Windows"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$build" -OutFile $exe
    $want = ((Invoke-WebRequest -UseBasicParsing -Uri "$base/$build.sha256").Content.Trim() -split '\s+')[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
    if ($got -ne $want) { Die "the download is corrupt (SHA-256 $got, expected $want); run this again" }
    Say "checksum OK"
  }

  if (Get-Process -Name 'PodTorrent', 'podtorrent-app' -ErrorAction SilentlyContinue) {
    Die "PodTorrent is running: quit it (tray icon or Task Manager), then run this again"
  }
  Say "installing (silently, for this user)"
  $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { Die "the installer failed (exit code $($p.ExitCode))" }

  # Tauri's installer puts the app in %LOCALAPPDATA%\PodTorrent for a per-user install.
  $app = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'PodTorrent'), (Join-Path $env:ProgramFiles 'PodTorrent') `
    -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^uninstall' } | Select-Object -First 1
  if ($app) {
    Say "installed $($app.VersionInfo.ProductVersion) at $($app.FullName)"
  } else {
    Say "installed"
  }
  Write-Host ""
  Write-Host "Start PodTorrent from the Start menu. If Windows Firewall asks, allow it, so other machines can reach this one."
  Write-Host "Update any time by running the same command again."
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
