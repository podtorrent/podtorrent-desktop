#!/usr/bin/env bash
# End-to-end test of an extracted headless tarball on Linux with no GPU (CI runs it before publishing).
# Everything a user runs, for real: the ROCm PyTorch install, `setup` (which starts a peer just for
# setup) refusing a model the engine can't run before downloading it, then a real slice of the model
# a user serves, a restart that reloads the saved slice, a forward pass through those layers on
# the installed PyTorch, status / top, and `doctor` (whose bundle must not contain the node token).
# Only the GPU itself is missing, so preflight is skipped and the GPU check is allowed to fall back to
# the CPU, after checking that it does block without that override. A full completion needs all of a
# model's layers (17 GB for the default model), more than a CI runner's memory, so the forward pass
# stands in for it.
#
#   headless/e2e.sh <extracted podtorrent-…-headless folder, or ~/.local/share/podtorrent/app after install.sh>
#
# E2E_MODEL / E2E_LO / E2E_HI pick the slice (default: layers 0–3 of Qwen3-30B-A3B-4bit, about 1.4 GB).
# It uses ~/.podtorrent, so run it on a throwaway machine or user.
set -euo pipefail

dir="$(cd "${1:?usage: e2e.sh <extracted podtorrent-headless folder>}" && pwd)"
model="${E2E_MODEL:-mlx-community/Qwen3-30B-A3B-4bit}"
lo="${E2E_LO:-0}"
hi="${E2E_HI:-4}"
dense="mlx-community/Qwen3-0.6B-4bit"   # a qwen3 (dense) model: the engine runs qwen3_moe only
export PODTORRENT_PORT="${PODTORRENT_PORT:-27183}" PODTORRENT_SKIP_PREFLIGHT=1
data="$HOME/.podtorrent"
api="http://127.0.0.1:$PODTORRENT_PORT"
cd "$dir"

PEER=""
group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
fail() {
  echo "E2E FAIL: $*" >&2
  for f in peer.log "$data/engine.log" "$data/setup-peer.log"; do
    [[ -f "$f" ]] && { echo "--- tail of $f" >&2; tail -n 60 "$f" >&2; }
  done
  exit 1
}
cleanup() { if [[ -n "$PEER" ]]; then kill -TERM "$PEER" 2>/dev/null || true; wait "$PEER" 2>/dev/null || true; fi; }
trap cleanup EXIT

json() {  # json URL PYTHON-EXPR: GET URL, evaluate EXPR on it as `d`, print the result
  python3 -c 'import json,sys,urllib.request
d = json.load(urllib.request.urlopen(sys.argv[1], timeout=30))
print(eval(sys.argv[2]))' "$1" "$2"
}

group "launcher"
./podtorrent help | grep -qE "^  (\./)?podtorrent setup" || fail "help doesn't list setup"
[[ -f README.md ]] || fail "the tarball has no README.md"
# Installed by install.sh: the `podtorrent` on PATH is this folder's, and it names itself that way.
if [[ "$(readlink -f "$(command -v podtorrent || true)")" == "$dir/podtorrent" ]]; then
  podtorrent help | grep -q "^  podtorrent setup" || fail "the installed command's help doesn't say 'podtorrent setup'"
  echo "installed command: $(command -v podtorrent) -> $dir/podtorrent ($(cat VERSION 2>/dev/null))"
fi
endgroup

group "GPU check blocks without a GPU (installs ROCm PyTorch first: the slow part)"
if PODTORRENT_ALLOW_CPU= ./podtorrent gpu-check; then
  fail "gpu-check passed on a machine with no GPU"
fi
[[ -x "$data/venv/bin/python" ]] || fail "PyTorch wasn't installed"
"$data/venv/bin/python" -c 'import torch; assert torch.version.hip, "not a ROCm build"; print("torch", torch.__version__, "hip", torch.version.hip)'
endgroup
export PODTORRENT_ALLOW_CPU=1

group "setup refuses a model the engine can't run, before downloading it"
if ./podtorrent setup --yes --no-service --no-join --name ci-e2e --model "$dense" >dense.log 2>&1; then
  cat dense.log; fail "setup accepted $dense"
fi
cat dense.log
grep -q "can't run here" dense.log || fail "setup didn't say why it refused $dense"
if ls "$data/models" 2>/dev/null | grep -q "Qwen3-0.6B"; then fail "setup downloaded $dense before refusing it"; fi
endgroup

group "setup (peer just for setup, real download)"
./podtorrent setup --yes --no-service --no-join --name ci-e2e --model "$model" --serve "$lo:$hi" | tee setup.log
grep -q "Serving layers $lo–$((hi - 1)) of $model" setup.log || fail "setup didn't report serving the slice"
python3 - "$data/config.json" "$model" "$lo" "$hi" <<'EOF' || fail "config.json doesn't hold the name and slice"
import json, sys
c = json.load(open(sys.argv[1]))
assert c.get("name") == "ci-e2e", c
want = {"model": sys.argv[2], "lo": int(sys.argv[3]), "hi": int(sys.argv[4])}
assert want in [{k: s[k] for k in ("model", "lo", "hi")} for s in c["serve"]], c
EOF
if curl -sf "$api/status" >/dev/null; then fail "the setup peer is still running after setup"; fi
endgroup

group "peer restart reloads the saved slice"
./podtorrent peer >peer.log 2>&1 &
PEER=$!
for _ in $(seq 150); do curl -sf "$api/status" >/dev/null && break; kill -0 "$PEER" || fail "peer exited"; sleep 2; done
for _ in $(seq 150); do
  [[ "$(json "$api/status" "any(s['loaded'] for s in d['slices'])" 2>/dev/null)" == True ]] && break
  sleep 2
done
[[ "$(json "$api/status" "d['name']")" == ci-e2e ]] || fail "the peer doesn't use the saved name"
[[ "$(json "$api/status" "[(s['model'], s['lo'], s['hi'], s['loaded']) for s in d['slices']]")" == "[('$model', $lo, $hi, True)]" ]] \
  || fail "the peer didn't reload the saved slice: $(json "$api/status" "d['slices']")"
endgroup

group "forward pass through the served layers (installed PyTorch, CPU)"
"$data/venv/bin/python" - "$model" "$lo" "$hi" <<'EOF' || fail "a forward pass through the served layers failed"
import sys
import torch
from podtorrent.cli import default_dir
from podtorrent.shard_torch import TorchShard
model, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
shard = TorchShard(default_dir(model), lo, hi, device="cpu")
h = torch.randn(1, 5, shard.cfg["hidden_size"], generator=torch.Generator().manual_seed(0))
out = shard.run_layers(h, shard.make_cache())
assert out.shape == h.shape, out.shape
assert torch.isfinite(out.float()).all(), "non-finite output"
assert not torch.allclose(out.float(), h.to(out.dtype).float()), "the layers did nothing"
print(f"forward through layers {lo}-{hi - 1}: shape {tuple(out.shape)}, mean |h| {out.float().abs().mean():.3f}")
EOF
endgroup

group "status, status --json, top"
./podtorrent status --json >status.json || fail "status --json failed"
python3 - status.json "$model" "$lo" "$hi" <<'EOF' || fail "status --json is missing this machine's slice or the model"
import json, sys
d = json.load(open(sys.argv[1]))
lo, hi = int(sys.argv[3]), int(sys.argv[4])
assert d["me"]["name"] == "ci-e2e" and d["me"]["slices"][0]["model"] == sys.argv[2], d["me"]
m = next(m for m in d["models"] if m["model"] == sys.argv[2])
# Alone in the swarm with one slice: the model is partial, missing everything outside it.
assert m["coverage"][lo:hi] == [1] * (hi - lo) and sum(m["coverage"]) == hi - lo, m
assert m["state"] == ("available" if (lo, hi) == (0, m["n_layers"]) else "partial"), m
assert d["network"] == {"joined": False}, d["network"]
EOF
./podtorrent top | tee top.txt
grep -q "PodTorrent · ci-e2e" top.txt || fail "top didn't render"
endgroup

group "doctor (bundle without the token)"
token="E2E-FAKE-TOKEN-$RANDOM$RANDOM"
(umask 077; printf '%s' "$token" >"$data/node-token")
echo "test line PODTORRENT_NODE_TOKEN=$token" >>"$data/engine.log"
./podtorrent doctor | tee doctor.txt
bundle="$(ls -t "$data"/podtorrent-doctor-*.tar.gz | head -n1)"
[[ -f "$bundle" ]] || fail "doctor wrote no bundle"
mkdir -p doctor-out && tar -C doctor-out -xzf "$bundle"
if grep -rqF "$token" doctor-out; then fail "the doctor bundle contains the node token"; fi
grep -rq "peer running" doctor-out/*/summary.txt || fail "doctor didn't see the running peer"
grep -q "FAIL  GPU check failed: PyTorch can't see the GPU" doctor.txt \
  || fail "doctor didn't report the missing GPU (it must ignore PODTORRENT_ALLOW_CPU)"
rm -f "$data/node-token"
endgroup

group "setup again is a no-op"
./podtorrent setup --yes --no-service --no-join --model "$model" --serve "$lo:$hi" | tee setup2.log
grep -q "nothing to do" setup2.log || fail "a second setup didn't recognise the slice it already serves"
endgroup

echo "E2E OK"
