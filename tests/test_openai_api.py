"""OpenAI-compatible API over a fake peer (no model, no network)."""

import asyncio
import json
import threading

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from podtorrent import openai_api


class Tok:
    def apply_chat_template(self, msgs, **_):
        return " ".join(m["content"] for m in msgs)

    def encode(self, text):
        return list(range(len(text.split())))


class FakePeer:
    repo = "example/model"

    def __init__(self, covered=True, fail=False):
        self.covered, self.fail = covered, fail
        self.active, self.active_lock = 0, threading.Lock()
        self.stats = {"requests": 0, "prompt_tokens": 0, "generated_tokens": 0}

    def models(self):
        return [{"model": self.repo, "state": "available" if self.covered else "partial"}]

    def route(self, _model):
        return ([object()] if self.covered else [], [])

    def ensure_head(self, _model):
        return None, Tok()

    def generate(self, ids, max_tokens, _model):
        if self.fail:
            raise RuntimeError("hop failed")
        for i, piece in enumerate(["Hel", "lo", "!"][:max_tokens]):
            yield i, piece, {}


def run(peer, fn):
    async def go():
        app = web.Application()
        app.add_routes(openai_api.routes(peer))
        async with TestClient(TestServer(app)) as c:
            return await fn(c)
    return asyncio.run(go())


BODY = {"model": "example/model", "messages": [{"role": "user", "content": "say hi"}]}


def test_models_lists_available_only():
    async def fn(c):
        return await (await c.get("/v1/models")).json()
    assert [m["id"] for m in run(FakePeer(), fn)["data"]] == ["example/model"]
    assert run(FakePeer(covered=False), fn)["data"] == []


def test_non_stream():
    async def fn(c):
        r = await c.post("/v1/chat/completions", json=BODY)
        return r.status, await r.json()
    status, b = run(FakePeer(), fn)
    assert status == 200
    assert b["choices"][0]["message"]["content"] == "Hello!"
    assert b["choices"][0]["finish_reason"] == "stop"
    assert b["usage"] == {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}


def test_stream_with_usage_and_length():
    async def fn(c):
        r = await c.post("/v1/chat/completions",
                         json={**BODY, "stream": True, "max_tokens": 2, "stream_options": {"include_usage": True}})
        return r.headers["Content-Type"], await r.text()
    ctype, text = run(FakePeer(), fn)
    assert ctype.startswith("text/event-stream")
    events = [line[6:] for line in text.split("\n") if line.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert "".join(c["choices"][0]["delta"].get("content", "") for c in chunks if c["choices"]) == "Hello"
    assert chunks[-2]["choices"][0]["finish_reason"] == "length"
    assert chunks[-1]["usage"]["completion_tokens"] == 2


def test_errors():
    async def fn(c):
        a = await c.post("/v1/chat/completions", json={"model": "example/model"})
        b = await c.post("/v1/chat/completions", json=BODY)
        return a.status, b.status
    assert run(FakePeer(), fn)[0] == 400
    assert run(FakePeer(covered=False), fn)[1] == 503
    assert run(FakePeer(fail=True), fn)[1] == 502


def test_network_manifest(tmp_path):
    from podtorrent.route import Hop

    peer = FakePeer()
    peer.models = lambda: [{"model": "example/model", "state": "available", "n_layers": 48},
                           {"model": "example/other", "state": "partial", "n_layers": 32}]
    peer.route = lambda _m: ([Hop("a", "mac-a", 0, 24), Hop("b", "win-b", 24, 48)], [])
    openai_api.write_network_manifest(peer, tmp_path)
    assert not (tmp_path / "network-manifest.json").exists()  # not joined yet
    (tmp_path / "network.json").write_text(json.dumps({"node": "example-node-01"}))
    openai_api.write_network_manifest(peer, tmp_path)
    m = json.loads((tmp_path / "network-manifest.json").read_text())
    assert m == {"node": "example-node-01", "models": [{
        "id": "example/model", "slots": 1,
        "pipeline": {"layers": 48, "hops": [{"peer": "mac-a", "lo": 0, "hi": 24},
                                             {"peer": "win-b", "lo": 24, "hi": 48}]}}]}
