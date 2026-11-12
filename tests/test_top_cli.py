"""`podtorrent top` / `status`: the peer's /api/swarm, the rendering, and the commands against a fake peer."""
import asyncio
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from podtorrent.top_cli import cov_bar, fmt_slices, human, rates, render

ROOT = Path(__file__).resolve().parent.parent
MODEL = "example/model"


# ---- the peer's /api/swarm (a real PeerApp, no model, no network) ----

@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("PODTORRENT_HOME", str(tmp_path))
    from podtorrent.net import identity
    identity.load_identity.cache_clear()
    from podtorrent.peer import PeerApp
    a = PeerApp(MODEL, tmp_path / "model", 48)
    yield a
    identity.load_identity.cache_clear()


def test_api_swarm_lists_me_peers_and_models(app):
    app.on_swarm([
        {"peer_id": app.me, "name": "me"},   # the rendezvous lists this machine too: left out of peers
        {"peer_id": "b" * 32, "name": "studio", "chip": "Apple M2 Ultra", "mem_total_gb": 192,
         "link": {"state": "direct", "rtt_ms": 41.0, "via": "direct",
                  "info": {"busy": True, "active_requests": 2, "tokens_processed": 900, "requests_served": 7,
                           "slices": [{"model": MODEL, "lo": 0, "hi": 24, "loaded": True}]}}},
        {"peer_id": "c" * 32, "name": "far", "slices": [{"model": MODEL, "lo": 24, "hi": 48, "loaded": True}]},
    ], "online")
    r = asyncio.run(app.swarm_api(None))
    body = json.loads(r.body)
    assert body["status"] == "online"
    assert body["me"]["peer_id"] == app.me and body["me"]["slices"] == []
    assert {"tokens", "requests", "active_requests", "mem_free_gb", "chip"} <= body["me"].keys()
    by = {p["name"]: p for p in body["peers"]}
    assert set(by) == {"studio", "far"}
    assert by["studio"]["state"] == "direct" and by["studio"]["tokens"] == 900 and by["studio"]["busy"] is True
    assert by["studio"]["slices"] == [{"model": MODEL, "lo": 0, "hi": 24, "loaded": True}]
    assert by["far"]["state"] == "seen" and by["far"]["rtt_ms"] is None
    m = next(m for m in body["models"] if m["model"] == MODEL)
    assert m["n_layers"] == 48


# ---- rendering ----

def test_cov_bar_shows_the_weakest_layer_per_cell():
    cov = [2] * 24 + [1] * 12 + [0] * 12
    assert cov_bar(cov, 4) == "██▒ "
    assert cov_bar(cov, 4, ascii_only=True) == "##- "
    assert cov_bar([1, 1, 0], 6) == "▒▒▒▒  "   # more cells than layers: each layer gets two
    assert cov_bar([], 5) == "     "


def test_human():
    assert human(None) == "–" and human(12) == "12" and human(45_300) == "45.3k" and human(2_000_000) == "2.0M"


def snap(t, my_tokens, their_tokens, **extra):
    return {"time": t, "status": "online", "network": {"joined": False},
            "me": {"peer_id": "me", "name": "halo-1", "chip": "Radeon 8060S", "mem_total_gb": 96,
                   "mem_free_gb": 41.5, "tokens": my_tokens, "requests": 3, "active_requests": 1, "busy": True,
                   "slices": [{"model": "o/Qwen3-30B", "lo": 24, "hi": 48, "loaded": True, "phase": "ready"}]},
            "peers": [{"peer_id": "s", "name": "studio", "chip": "Apple M2 Ultra", "mem_total_gb": 192,
                       "state": "direct", "rtt_ms": 41.0, "tokens": their_tokens,
                       "slices": [{"model": "o/Qwen3-30B", "lo": 0, "hi": 24, "loaded": True}]},
                      {"peer_id": "f", "name": "far", "chip": None, "mem_total_gb": None, "state": "seen",
                       "rtt_ms": None, "tokens": None, "slices": []}],
            "models": [{"model": "o/Qwen3-30B", "n_layers": 48, "state": "available", "redundancy": 1,
                        "coverage": [1] * 48, "gaps": [], "route": [["studio", 0, 24], ["halo-1", 24, 48]]}],
            **extra}


def test_rates_from_token_deltas():
    assert rates(snap(10, 100, 50), None) == {}
    r = rates(snap(12, 140, 50), snap(10, 100, 50))
    assert r == {"me": 20.0, "s": 0.0}           # far has no token count: no rate
    assert rates(snap(12, 90, 50), snap(10, 100, 50)) == {"s": 0.0}   # counter reset (restart): skipped


def test_render_shows_machine_models_route_and_peers():
    text = "\n".join(render(snap(12, 140, 90), snap(10, 100, 50), width=110))
    assert "PodTorrent · halo-1 · Radeon 8060S · 96 GB · 41.5 GB free for models" in text
    assert "1 connected of 2 other peers" in text
    assert "serving Qwen3-30B layers 24–47  ready" in text
    assert "20.0 tok/s" in text
    assert "network: not joined (./podtorrent join)" in text
    assert "available ×1" in text and "route studio 0–23 → halo-1 24–47" in text
    lines = text.splitlines()
    peers = lines[lines.index("PEERS") + 2:]
    assert peers[0].lstrip().startswith("studio") and "41ms" in peers[0] and "20.0" in peers[0]
    assert peers[1].lstrip().startswith("far") and peers[1].rstrip().endswith("nothing")
    assert peers[1].split()[1:3] == ["?", "–"]   # unknown chip and memory


def test_render_fits_the_width_and_handles_an_empty_swarm():
    s = snap(1, 0, 0)
    s["peers"], s["models"], s["me"]["slices"] = [], [], []
    s["network"] = {"joined": True, "node": "halo-1", "network": "staging", "agent_last": "x" * 500}
    lines = render(s, width=70)
    assert all(len(line) <= 70 for line in lines)
    text = "\n".join(lines)
    assert "serving nothing yet: ./podtorrent setup" in text
    assert "no other peers online" in text and "none yet" in text
    assert "network: node halo-1 on staging" in text


def test_fmt_slices():
    assert fmt_slices([]) == "nothing"
    assert fmt_slices([{"model": "a/B", "lo": 0, "hi": 8, "loaded": False}]) == "B 0–7 (loading)"


# ---- the commands, against a fake peer ----

@pytest.fixture
def fake():
    body = snap(1, 10, 20)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            b = json.dumps(body if self.path == "/api/swarm" else {"error": "nope"}).encode()
            self.send_response(200 if self.path == "/api/swarm" else 404)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()


def cli(*args, home):
    return subprocess.run([sys.executable, "-m", "podtorrent.cli", *args], cwd=ROOT, capture_output=True, text=True,
                          timeout=60, env={"PATH": "/usr/bin:/bin", "PODTORRENT_HOME": str(home)})


def test_status_json_adds_the_network_state_without_the_token(fake, tmp_path):
    (tmp_path / "network.json").write_text(json.dumps({"node": "halo-1", "network": "staging"}))
    (tmp_path / "node-token").write_text("SECRET-TOKEN")
    (tmp_path / "agent.log").write_text("starting\nconnected to staging\n")
    r = cli("status", "--json", "--port", str(fake), home=tmp_path)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["network"] == {"joined": True, "node": "halo-1", "network": "staging",
                              "agent_last": "connected to staging"}
    assert "SECRET-TOKEN" not in r.stdout


def test_status_text_and_top_without_a_terminal(fake, tmp_path):
    for cmd in ("status", "top"):   # top falls back to a single status when stdout isn't a terminal
        r = cli(cmd, "--port", str(fake), home=tmp_path)
        assert r.returncode == 0, r.stderr
        assert "PodTorrent · halo-1" in r.stdout and "PEERS" in r.stdout


def test_status_with_no_peer(tmp_path):
    r = cli("status", "--port", "1", home=tmp_path)
    assert r.returncode != 0 and "no peer running" in r.stderr
