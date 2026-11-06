"""Unserving a slice while it downloads stops the download and drops its partial file."""

import threading

import pytest

from podtorrent import peer


def test_unserve_cancels_download(tmp_path, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def fake_download(model, d, lo, hi, name, on_progress):
        (d / f"{name}.data.tmp").write_bytes(b"partial")
        on_progress(1, 10)
        started.set()
        release.wait(5)
        on_progress(2, 10)  # raises Cancelled once unserved
        raise AssertionError("download kept going after cancel")

    monkeypatch.setattr(peer, "fetch_meta", lambda m, d: {"model_type": next(iter(peer.SUPPORTED)), "num_hidden_layers": 48})
    monkeypatch.setattr(peer, "download_slice", fake_download)
    monkeypatch.setattr(peer, "gb", lambda *a: 1.0)
    monkeypatch.setattr(peer, "mem_free_gb", lambda: 100.0)
    slices = peer.Slices(lambda m: tmp_path)
    phases, err = [], []

    def load():
        try:
            slices.load("example/model", 0, 24, lambda p, *a: phases.append(p))
        except peer.Cancelled as e:
            err.append(e)
    t = threading.Thread(target=load)
    t.start()
    assert started.wait(5)
    assert slices.slices()[0]["loaded"] is False and slices.phase == "downloading"
    slices.unserve("example/model", 0, 24)
    release.set()
    t.join(5)
    assert err and "loading" not in phases and "ready" not in phases
    assert not slices.items and slices.wait_idle(1)
    assert not (tmp_path / "layers-0-24.data.tmp").exists()



def test_fetch_streams_and_stops():
    import httpx

    from podtorrent import slicer
    body = bytes(range(256)) * (40 * 2**20 // 256)  # 10 chunks of 4 MB
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(206, content=body)))
    seen = []
    assert slicer._fetch(client, "https://example.test/f", 0, len(body) - 1, seen.append) == body
    assert len(seen) >= 2 and seen[-1] == len(body)

    def stop(n):
        if n >= 8 * 2**20:
            raise peer.Cancelled("stop")
    with pytest.raises(peer.Cancelled):
        slicer._fetch(client, "https://example.test/f", 0, len(body) - 1, stop)
