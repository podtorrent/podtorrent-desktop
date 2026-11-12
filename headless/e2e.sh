#!/usr/bin/env bash
# End-to-end test of an extracted headless tarball on Linux with no GPU (CI runs it before publishing).
# Everything a user runs, for real: the ROCm PyTorch install, `setup` (which starts a peer just for
# setup), a real model download, a restart that reloads the saved slice, a completion, status / top,
# and `doctor` (whose bundle must not contain the node token). Only the GPU itself is missing, so
# preflight is skipped and the GPU check is allowed to fall back to the CPU, after checking that it
# does block without that override.
#
#   headless/e2e.sh <extracted podtorrent-headless-… folder>
#
# E2E_MODEL / E2E_LAYERS pick the model (default: a 0.6B Qwen3, 28 layers, about 350 MB).
# It uses ~/.podtorrent, so run it on a throwaway machine or user.
set -euo pipefail

dir="$(cd "${1:?usage: e2e.sh <extracted podtorrent-headless folder>}" && pwd)"
model="${E2E_MODEL:-mlx-community/Qwen3-0.6B-4bit}"
layers="${E2E_LAYERS:-28}"
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
./podtorrent help | grep -q "./podtorrent setup" || fail "help doesn't list setup"
[[ -f README.md ]] || fail "the tarball has no README.md"
endgroup

group "GPU check blocks without a GPU (installs ROCm PyTorch first: the slow part)"
if PODTORRENT_ALLOW_CPU= ./podtorrent gpu-check; then
  fail "gpu-check passed on a machine with no GPU"
fi
[[ -x "$data/venv/bin/python" ]] || fail "PyTorch wasn't installed"
"$data/venv/bin/python" -c 'import torch; assert torch.version.hip, "not a ROCm build"; print("torch", torch.__version__, "hip", torch.version.hip)'
endgroup
export PODTORRENT_ALLOW_CPU=1

group "setup (peer just for setup, real download)"
./podtorrent setup --yes --no-service --no-join --name ci-e2e --model "$model" --serve "0:$layers" | tee setup.log
grep -q "Serving layers 0–$((layers - 1)) of $model" setup.log || fail "setup didn't report serving the slice"
python3 - "$data/config.json" "$model" "$layers" <<'EOF' || fail "config.json doesn't hold the name and slice"
import json, sys
c = json.load(open(sys.argv[1]))
assert c.get("name") == "ci-e2e", c
assert {"model": sys.argv[2], "lo": 0, "hi": int(sys.argv[3])} in [{k: s[k] for k in ("model", "lo", "hi")} for s in c["serve"]], c
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
[[ "$(json "$api/status" "[(s['model'], s['lo'], s['hi'], s['loaded']) for s in d['slices']]")" == "[('$model', 0, $layers, True)]" ]] \
  || fail "the peer didn't reload the saved slice: $(json "$api/status" "d['slices']")"
endgroup

group "completion through the served layers"
out="$(python3 - "$api" "$model" <<'EOF'
import json, sys, urllib.request
req = urllib.request.Request(sys.argv[1] + "/api/complete", headers={"Content-Type": "application/json"},
                             data=json.dumps({"prompt": "The capital of France is", "max_tokens": 6,
                                              "model": sys.argv[2]}).encode())
try:
    r = json.load(urllib.request.urlopen(req, timeout=600))
except urllib.error.HTTPError as e:
    r = json.load(e)
print(json.dumps(r))
EOF
)"
echo "$out"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert "error" not in r, r; assert "Paris" in r["text"], r["text"]' "$out" \
  || fail "the completion failed or didn't say Paris"
endgroup

group "status, status --json, top"
./podtorrent status --json >status.json || fail "status --json failed"
python3 - status.json "$model" <<'EOF' || fail "status --json is missing this machine's slice or the model"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["me"]["name"] == "ci-e2e" and d["me"]["slices"][0]["model"] == sys.argv[2], d["me"]
m = next(m for m in d["models"] if m["model"] == sys.argv[2])
assert m["state"] == "available", m
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
rm -f "$data/node-token"
endgroup

group "setup again is a no-op"
./podtorrent setup --yes --no-service --no-join --model "$model" --serve "0:$layers" | tee setup2.log
grep -q "nothing to do" setup2.log || fail "a second setup didn't recognise the slice it already serves"
endgroup

echo "E2E OK"
