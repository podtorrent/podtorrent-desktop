#!/usr/bin/env bash
# End-to-end test of the macOS headless build (macos-arm64-headless) on an Apple Silicon Mac; CI runs it
# before publishing. Everything a user runs, for real: the MLX install, the GPU check, `setup` refusing a
# model the engine can't run, then a real slice of a model, a restart that reloads it, a forward pass
# through those layers on MLX, status / top, `doctor` (whose bundle must not contain the node token), and
# the launchd service: install, a crash that launchd restarts, an update that restarts it on the new
# version, and uninstall leaving no peer behind.
#
#   headless/e2e-macos.sh <~/.local/share/podtorrent/app after install.sh, or an extracted tarball folder>
#
# A machine without Metal (some virtual Macs) can't run a peer at all; there the test checks the install,
# that the GPU check blocks, and doctor, and says it skipped the rest.
#
# E2E_MODEL / E2E_LO / E2E_HI pick the slice (default: layers 0–3 of Qwen3-30B-A3B-4bit, about 1.4 GB).
# E2E_TARBALL (optional): the tarball to reinstall for the update check.
# It uses ~/.podtorrent and the com.podtorrent.peer launchd job, so run it on a throwaway machine or user
# (or with HOME pointing at an empty folder). Runs on macOS's bash 3.2.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$(cd "${1:?usage: e2e-macos.sh <podtorrent headless folder>}" && pwd)"
model="${E2E_MODEL:-mlx-community/Qwen3-30B-A3B-4bit}"
lo="${E2E_LO:-0}"
hi="${E2E_HI:-4}"
dense="mlx-community/Qwen3-0.6B-4bit"   # a qwen3 (dense) model: the engine runs qwen3_moe only
export PODTORRENT_PORT="${PODTORRENT_PORT:-27183}" PODTORRENT_SKIP_PREFLIGHT=1
data="$HOME/.podtorrent"
api="http://127.0.0.1:$PODTORRENT_PORT"
py="$data/venv/bin/python"
job="gui/$(id -u)/com.podtorrent.peer"
work="$(mktemp -d)"
cd "$dir"

PEER=""
group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
fail() {
  echo "E2E FAIL: $*" >&2
  for f in "$work/peer.log" "$data/engine.log" "$data/setup-peer.log" "$data/service.log"; do
    [[ -f "$f" ]] && { echo "--- tail of $f" >&2; tail -n 60 "$f" >&2; }
  done
  exit 1
}
cleanup() {
  if [[ -n "$PEER" ]]; then kill -TERM "$PEER" 2>/dev/null || true; wait "$PEER" 2>/dev/null || true; fi
  ./podtorrent uninstall-service >/dev/null 2>&1 || true
}
trap cleanup EXIT

json() {  # json URL PYTHON-EXPR: GET URL, evaluate EXPR on it as `d`, print the result
  "$py" -c 'import json,sys,urllib.request
d = json.load(urllib.request.urlopen(sys.argv[1], timeout=30))
print(eval(sys.argv[2]))' "$1" "$2"
}
up() { local i; for (( i = 0; i < 150; i++ )); do curl -sf "$api/status" >/dev/null && return 0; sleep 2; done; return 1; }
# The peer's own processes (uv and Python), whatever started them.
peer_procs() { pgrep -f "podtorrent peer --port $PODTORRENT_PORT" || true; }

group "launcher"
[[ "$(head -n1 PLATFORM)" == macos ]] || fail "PLATFORM isn't macos"
./podtorrent help | grep -qE "^  (\./)?podtorrent setup" || fail "help doesn't list setup"
./podtorrent help | grep -q -- "--at-boot" || fail "help doesn't mention install-service --at-boot"
[[ -f README.md ]] || fail "the tarball has no README.md"
if [[ "$(readlink -f "$(command -v podtorrent || true)")" == "$dir/podtorrent" ]]; then
  podtorrent help | grep -q "^  podtorrent setup" || fail "the installed command's help doesn't say 'podtorrent setup'"
  echo "installed command: $(command -v podtorrent) -> $dir/podtorrent ($(cat VERSION 2>/dev/null))"
fi
file backend/uv backend/podtorrent-agent | tee "$work/file.txt"
grep -q "uv: .*arm64" "$work/file.txt" && grep -q "podtorrent-agent: .*arm64" "$work/file.txt" || fail "uv or the agent isn't arm64"
endgroup

group "preflight"
PODTORRENT_SKIP_PREFLIGHT= ./podtorrent preflight | tee "$work/preflight.txt" || true
grep -q "ok    macOS" "$work/preflight.txt" || fail "preflight didn't check the macOS version"
endgroup

group "MLX install and GPU check"
metal=1
if ./podtorrent gpu-check | tee "$work/gpu.txt"; then
  grep -q "ok    .*matmul matches the CPU" "$work/gpu.txt" || fail "gpu-check passed without saying what it checked"
else
  [[ -x "$py" ]] || fail "MLX wasn't installed"
  grep -q "MLX can't use the GPU" "$work/gpu.txt" || fail "gpu-check failed for another reason than missing Metal"
  metal=0
fi
"$py" -c 'import mlx.core as mx; print("mlx", mx.__version__, "metal", mx.metal.is_available())'
endgroup

if (( ! metal )); then
  echo "::warning::no Metal on this machine: the peer, setup, service and forward-pass checks were skipped"
  group "doctor (bundle without the token), no Metal"
  token="E2E-FAKE-TOKEN-$RANDOM$RANDOM"
  (umask 077; printf '%s' "$token" >"$data/node-token")
  ./podtorrent doctor | tee "$work/doctor.txt"
  bundle="$(ls -t "$data"/podtorrent-doctor-*.tar.gz | head -n1)"
  mkdir -p "$work/doctor" && tar -C "$work/doctor" -xzf "$bundle"
  if grep -rqF "$token" "$work/doctor"; then fail "the doctor bundle contains the node token"; fi
  grep -q "FAIL  GPU check failed: MLX can't use the GPU" "$work/doctor.txt" || fail "doctor didn't report the missing GPU"
  rm -f "$data/node-token"
  endgroup
  echo "E2E OK (no Metal: partial)"
  exit 0
fi

group "setup refuses a model the engine can't run, before downloading it"
if ./podtorrent setup --yes --no-service --no-join --name ci-e2e --model "$dense" >"$work/dense.log" 2>&1; then
  cat "$work/dense.log"; fail "setup accepted $dense"
fi
cat "$work/dense.log"
grep -q "can't run here" "$work/dense.log" || fail "setup didn't say why it refused $dense"
if ls "$data/models" 2>/dev/null | grep -q "Qwen3-0.6B"; then fail "setup downloaded $dense before refusing it"; fi
endgroup

group "setup (peer just for setup, real download)"
./podtorrent setup --yes --no-service --no-join --name ci-e2e --model "$model" --serve "$lo:$hi" | tee "$work/setup.log"
grep -q "Serving layers $lo–$((hi - 1)) of $model" "$work/setup.log" || fail "setup didn't report serving the slice"
if curl -sf "$api/status" >/dev/null; then fail "the setup peer is still running after setup"; fi
[[ -z "$(peer_procs)" ]] || fail "setup left peer processes behind: $(peer_procs)"
endgroup

group "peer restart reloads the saved slice; it keeps the machine awake"
./podtorrent peer >"$work/peer.log" 2>&1 &
PEER=$!
up || fail "the peer didn't come up"
for _ in $(seq 150); do
  [[ "$(json "$api/status" "any(s['loaded'] for s in d['slices'])" 2>/dev/null)" == True ]] && break
  sleep 2
done
[[ "$(json "$api/status" "d['name']")" == ci-e2e ]] || fail "the peer doesn't use the saved name"
[[ "$(json "$api/status" "[(s['model'], s['lo'], s['hi'], s['loaded']) for s in d['slices']]")" == "[('$model', $lo, $hi, True)]" ]] \
  || fail "the peer didn't reload the saved slice: $(json "$api/status" "d['slices']")"
pgrep -f "caffeinate -i -s -w" >/dev/null || fail "nothing keeps the machine awake while the peer runs"
endgroup

group "forward pass through the served layers (MLX)"
"$py" - "$model" "$lo" "$hi" <<'EOF' || fail "a forward pass through the served layers failed"
import sys
import mlx.core as mx
from podtorrent.cli import default_dir
from podtorrent.shard import Shard
model, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
shard = Shard(default_dir(model), lo, hi)
h = mx.random.normal((1, 5, shard.args.hidden_size), key=mx.random.key(0)).astype(mx.bfloat16)
out = shard.run_layers(h, shard.make_cache())
mx.eval(out)
assert out.shape == h.shape, out.shape
assert mx.all(mx.isfinite(out.astype(mx.float32))).item(), "non-finite output"
assert not mx.allclose(out.astype(mx.float32), h.astype(mx.float32)).item(), "the layers did nothing"
print(f"forward through layers {lo}-{hi - 1}: shape {tuple(out.shape)}, mean |h| {mx.abs(out.astype(mx.float32)).mean().item():.3f}")
EOF
endgroup

group "status, status --json, top"
./podtorrent status --json >"$work/status.json" || fail "status --json failed"
"$py" - "$work/status.json" "$model" "$lo" "$hi" <<'EOF' || fail "status --json is missing this machine's slice or the model"
import json, sys
d = json.load(open(sys.argv[1]))
lo, hi = int(sys.argv[3]), int(sys.argv[4])
assert d["me"]["name"] == "ci-e2e" and d["me"]["slices"][0]["model"] == sys.argv[2], d["me"]
m = next(m for m in d["models"] if m["model"] == sys.argv[2])
assert m["coverage"][lo:hi] == [1] * (hi - lo) and sum(m["coverage"]) == hi - lo, m
assert d["network"] == {"joined": False}, d["network"]
EOF
./podtorrent top | tee "$work/top.txt"
grep -q "PodTorrent · ci-e2e" "$work/top.txt" || fail "top didn't render"
endgroup

group "doctor (bundle without the token)"
token="E2E-FAKE-TOKEN-$RANDOM$RANDOM"
(umask 077; printf '%s' "$token" >"$data/node-token")
echo "test line PODTORRENT_NODE_TOKEN=$token" >>"$data/engine.log"
./podtorrent doctor | tee "$work/doctor.txt"
bundle="$(ls -t "$data"/podtorrent-doctor-*.tar.gz | head -n1)"
mkdir -p "$work/doctor" && tar -C "$work/doctor" -xzf "$bundle"
if grep -rqF "$token" "$work/doctor"; then fail "the doctor bundle contains the node token"; fi
grep -q "ok    machine checks (macOS, memory, disk)" "$work/doctor.txt" || fail "doctor's machine checks line is wrong"
grep -q "ok    GPU check: " "$work/doctor.txt" || fail "doctor didn't pass the GPU check"
grep -rq "peer running" "$work/doctor"/*/summary.txt || fail "doctor didn't see the running peer"
rm -f "$data/node-token"
endgroup

group "Ctrl-C stops the peer and everything it started"
kill -TERM "$PEER"; wait "$PEER" 2>/dev/null || true; PEER=""
sleep 2
[[ -z "$(peer_procs)" ]] || fail "stopping the launcher left the peer running: $(peer_procs)"
! pgrep -f "caffeinate -i -s -w" >/dev/null || fail "caffeinate kept running after the peer stopped"
endgroup

group "setup again is a no-op"
./podtorrent setup --yes --no-service --no-join --model "$model" --serve "$lo:$hi" | tee "$work/setup2.log"
grep -q "nothing to do" "$work/setup2.log" || fail "a second setup didn't recognise the slice it already serves"
[[ -z "$(peer_procs)" ]] || fail "setup left peer processes behind"
endgroup

group "launchd service: install, crash, update, uninstall"
./podtorrent install-service | tee "$work/service.txt"
plutil -lint "$HOME/Library/LaunchAgents/com.podtorrent.peer.plist" || fail "the LaunchAgent plist isn't valid"
up || fail "the service's peer didn't come up"
launchctl print "$job" | grep -q "state = running" || fail "launchd doesn't show the job running"
# A crash: launchd starts it again (KeepAlive on failure).
kill -9 "$(pgrep -f "venv/bin/podtorrent peer --port $PODTORRENT_PORT" | head -n1)"
sleep 3
up || fail "launchd didn't restart the peer after a crash"
[[ "$(launchctl print "$job" | awk '/runs =/ {print $3}')" -ge 2 ]] || fail "launchd didn't count a second run"
if [[ -n "${E2E_TARBALL:-}" ]]; then
  # An update while the service runs: install.sh stops it cleanly and starts it on the new version.
  PODTORRENT_FILE="$E2E_TARBALL" sh "$repo/install/install.sh" --headless | tee "$work/update.txt"
  cd "$dir"   # the update swapped the folder: run the new launcher from here on
  grep -q "restarted the PodTorrent service on the new version" "$work/update.txt" || fail "the update didn't restart the service"
  up || fail "the service didn't come back after the update"
  [[ "$(peer_procs | wc -l | tr -d ' ')" == 2 ]] || fail "more than one peer after the update: $(peer_procs)"
fi
./podtorrent uninstall-service
sleep 2
! launchctl print "$job" >/dev/null 2>&1 || fail "the job is still loaded after uninstall-service"
[[ -z "$(peer_procs)" ]] || fail "uninstall-service left the peer running: $(peer_procs)"
[[ ! -e "$HOME/Library/LaunchAgents/com.podtorrent.peer.plist" ]] || fail "the plist is still there"
endgroup

echo "E2E OK"
