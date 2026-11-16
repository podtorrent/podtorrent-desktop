"""`podtorrent setup`: choosing a model and slice, and the wizard against a fake peer API."""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from podtorrent.setup_cli import bar, check_slice, parse_range, rank

GB = 1 << 30
ROOT = Path(__file__).resolve().parent.parent


def model(name, state, n=48, gaps=(), redundancy=0, peers=()):
    return {"model": name, "n_layers": n, "state": state, "gaps": [list(g) for g in gaps],
            "redundancy": redundancy, "peers": list(peers)}


def info(n=48, lo=0, hi=24, room=20.0, layer_gb=0.5, reason="r"):
    return {"n_layers": n, "layer_bytes": int(layer_gb * GB), "size_bytes": int(layer_gb * GB) * n,
            "room_gb": room, "suggest": {"lo": lo, "hi": hi, "reason": reason}}


def test_rank_gaps_first_then_single_copy_then_offline():
    ms = [model("o/full2", "available", redundancy=2, peers=["a", "b"]),
          model("o/off", "offline", gaps=[(0, 48)]),
          model("o/gappy", "partial", gaps=[(24, 48)], peers=["a"]),
          model("o/one", "available", redundancy=1, peers=["a"])]
    infos = {m["model"]: info() for m in ms}
    got = rank(ms, infos, [])
    assert [c["model"] for c in got] == ["o/gappy", "o/one", "o/full2", "o/off"]
    assert got[0]["why"] == "missing 24–47"
    assert got[3]["why"] == "nobody serves it"


def test_rank_puts_models_that_dont_fit_or_are_unknown_last():
    ms = [model("o/big", "partial", gaps=[(0, 10)]), model("o/unknown", "partial", gaps=[(0, 10)]),
          model("o/ok", "available", redundancy=3)]
    infos = {"o/big": info(lo=0, hi=0), "o/ok": info()}
    got = rank(ms, infos, [])
    assert [c["model"] for c in got] == ["o/ok", "o/unknown", "o/big"]
    assert not got[1]["fits"] and not got[2]["fits"]
    assert got[2]["why"] == "doesn't fit in free GPU memory"


def test_rank_puts_models_this_engine_cant_run_last():
    ms = [model("o/dense", "partial", gaps=[(0, 10)]), model("o/moe", "available", redundancy=3)]
    infos = {"o/dense": {**info(), "supported": False, "model_type": "qwen3", "supported_types": ["qwen3_moe"]},
             "o/moe": {**info(), "supported": True}}
    got = rank(ms, infos, [])
    assert [c["model"] for c in got] == ["o/moe", "o/dense"]
    assert not got[1]["fits"] and "it's a qwen3 model (PodTorrent runs qwen3_moe)" in got[1]["why"]


def test_rank_marks_slices_served_here():
    got = rank([model("o/m", "available", redundancy=1)], {"o/m": info()},
               [{"model": "o/m", "lo": 0, "hi": 8}, {"model": "o/x", "lo": 0, "hi": 4}])
    assert got[0]["serving"] == [[0, 8]]


@pytest.mark.parametrize("text,want", [("0:24", (0, 24)), ("0-23", (0, 24)), (" 8 : 16 ", (8, 16)),
                                       ("abc", None), ("4", None), ("a:b", None)])
def test_parse_range(text, want):
    assert parse_range(text) == want


def test_check_slice():
    inf = info(n=48, room=10.0, layer_gb=0.5)
    assert check_slice(inf, 0, 20) is None                  # 10 GB, exactly the room
    assert "need about 10.5 GB" in check_slice(inf, 0, 21)
    assert "within 0:48" in check_slice(inf, 40, 49)
    assert "within 0:48" in check_slice(inf, 5, 5)
    assert check_slice({**inf, "layer_bytes": 0}, 0, 48) is None   # size unknown: allowed


def test_bar():
    assert bar(0, 0).startswith("[ ")
    assert bar(50, 100).endswith(" 50%")
    assert bar(200, 100).count("#") == 24   # never wider than the bar


# ---- the wizard end to end, against a fake peer ----

class FakePeer:
    """Serves the local API shapes setup uses: /api/models, /api/catalog/info, /status, /api/serve."""

    def __init__(self):
        self.served: list[dict] = []
        self.slices: list[dict] = []
        peer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, obj, code=200):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                u = urlparse(self.path)
                if u.path == "/api/models":
                    self._json({"mem_free_gb": 40.0, "slices": peer.slices, "models": [
                        model("o/full", "available", redundancy=2, peers=["a", "b"]),
                        model("o/gappy", "partial", gaps=[(24, 48)], peers=["a"])]})
                elif u.path == "/api/catalog/info":
                    repo = parse_qs(u.query)["repo"][0]
                    if repo == "o/missing":
                        self._json({"error": "404"}, 502)
                    elif repo == "o/dense":
                        self._json({**info(n=28, lo=0, hi=28, room=30.0), "model_type": "qwen3", "supported": False,
                                    "supported_types": ["qwen3_moe"]})
                    elif repo == "o/gappy":
                        self._json(info(lo=24, hi=48, room=30.0, reason="Fills the swarm's missing layers"))
                    else:
                        self._json(info(lo=0, hi=24, room=30.0))
                elif u.path == "/status":
                    self._json({"slices": peer.slices})
                else:
                    self._json({"error": "nope"}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/api/serve":
                    peer.served.append(body)
                    peer.slices.append({"model": body["model"], "lo": body["lo"], "hi": body["hi"],
                                        "phase": "ready", "done": 1, "total": 1, "loaded": True})
                    self._json({"ok": True, "slices": peer.slices})
                else:
                    self._json({"error": "nope"}, 404)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def peer():
    p = FakePeer()
    yield p
    p.close()


def setup(port, *args, stdin=None):
    return subprocess.run([sys.executable, "-m", "podtorrent.cli", "setup", "--port", str(port), *args],
                          cwd=ROOT, input=stdin, capture_output=True, text=True, timeout=60)


def test_yes_picks_the_gap_filler_and_its_suggested_slice(peer):
    r = setup(peer.port, "--yes")
    assert r.returncode == 0, r.stderr
    assert peer.served == [{"model": "o/gappy", "lo": 24, "hi": 48, "wait": True}]
    assert "Serving layers 24–47 of o/gappy" in r.stdout


def test_explicit_model_and_slice(peer):
    r = setup(peer.port, "--yes", "--model", "o/full", "--serve", "0:8")
    assert r.returncode == 0, r.stderr
    assert peer.served == [{"model": "o/full", "lo": 0, "hi": 8, "wait": True}]


def test_out_of_range_slice_is_refused(peer):
    r = setup(peer.port, "--yes", "--model", "o/full", "--serve", "0:60")
    assert r.returncode != 0 and "within 0:48" in r.stderr
    assert peer.served == []


def test_unknown_model_is_refused(peer):
    r = setup(peer.port, "--yes", "--model", "o/missing")
    assert r.returncode != 0 and "couldn't read o/missing" in r.stderr
    assert peer.served == []


def test_model_the_engine_cant_run_is_refused_before_downloading(peer):
    r = setup(peer.port, "--yes", "--model", "o/dense")
    assert r.returncode != 0 and "o/dense can't run here: it's a qwen3 model" in r.stderr
    assert peer.served == []


def test_already_serving_is_a_no_op(peer):
    assert setup(peer.port, "--yes").returncode == 0
    peer.served.clear()
    r = setup(peer.port, "--yes", "--model", "o/gappy", "--serve", "30:40")
    assert r.returncode == 0 and "nothing to do" in r.stdout
    assert peer.served == []


def test_non_interactive_without_yes_is_refused(peer):
    r = setup(peer.port, stdin="")
    assert r.returncode != 0 and "--yes" in r.stderr


def test_no_peer_running():
    r = setup(1, "--yes")
    assert r.returncode != 0 and "no peer running" in r.stderr


# ---- the peer side: /api/catalog/info says whether this engine can run the model ----

@pytest.mark.parametrize("model_type,ok", [("qwen3_moe", True), ("qwen3_5_moe", True), ("qwen3", False),
                                           ("qwen3_5_moe_text", False), ("llama", False)])
def test_catalog_info_reports_support(tmp_path, monkeypatch, model_type, ok):
    import asyncio

    from podtorrent import catalog
    from podtorrent.net import identity
    monkeypatch.setenv("PODTORRENT_HOME", str(tmp_path))
    identity.load_identity.cache_clear()
    from podtorrent.peer import PeerApp
    app = PeerApp("o/default", tmp_path / "model", 48)
    monkeypatch.setattr(catalog, "info", lambda repo: {"repo": repo, "n_layers": 28, "size_bytes": 28 * GB,
                                                       "layer_bytes": GB, "model_type": model_type})

    class Req:
        query = {"repo": "o/thing"}
    body = json.loads(asyncio.run(app.catalog_info(Req())).body)
    assert body["supported"] is ok and body["supported_types"] == ["qwen3_5_moe", "qwen3_moe"]
    identity.load_identity.cache_clear()
