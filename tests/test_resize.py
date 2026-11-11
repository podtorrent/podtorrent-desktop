"""Resizing what this machine serves: grow or shrink a slice, download only layers not on disk, and
delete layers outside the served range from disk."""

import json
import struct

from podtorrent import catalog, peer, slicer


def _slices(tmp_path, monkeypatch, downloads=None):
    monkeypatch.setattr(peer, "fetch_meta", lambda m, d: {"model_type": next(iter(peer.SUPPORTED)), "num_hidden_layers": 48})
    monkeypatch.setattr(peer, "download_slice", lambda m, d, lo, hi, name, on_progress: (downloads or []).append((lo, hi)))
    monkeypatch.setattr(peer, "Shard", lambda d, lo, hi: object())
    monkeypatch.setattr(peer, "gb", lambda d, lo, hi: (hi - lo) * 0.3)
    monkeypatch.setattr(peer, "mem_free_gb", lambda: 100.0)
    return peer.Slices(lambda m: tmp_path)


def _ranges(s):
    return sorted((x["lo"], x["hi"]) for x in s.slices())


def test_grow_replaces_the_slice_it_contains(tmp_path, monkeypatch):
    s = _slices(tmp_path, monkeypatch)
    s.load("m", 36, 42)
    s.load("m", 36, 48)
    assert _ranges(s) == [(36, 48)]


def test_shrink_needs_replace(tmp_path, monkeypatch):
    s = _slices(tmp_path, monkeypatch)
    s.load("m", 36, 48)
    s.load("m", 38, 48)                 # covered already: nothing changes
    assert _ranges(s) == [(36, 48)]
    s.load("m", 38, 48, replace=True)   # a resize: the wider slice goes
    assert _ranges(s) == [(38, 48)]


def test_replace_drops_other_slices_of_the_model_only(tmp_path, monkeypatch):
    s = _slices(tmp_path, monkeypatch)
    s.load("m", 0, 10)
    s.load("m", 36, 42)
    s.load("other", 0, 4)
    s.load("m", 36, 42, replace=True)   # same range: just drops the rest of the model
    assert sorted((x["model"], x["lo"], x["hi"]) for x in s.slices()) == [("m", 36, 42), ("other", 0, 4)]


def _safetensors(f, names):
    hdr, off = {}, 0
    for n in names:
        hdr[n] = {"dtype": "U8", "shape": [4], "data_offsets": [off, off + 4]}
        off += 4
    h = json.dumps(hdr).encode()
    f.write_bytes(struct.pack("<Q", len(h)) + h + b"\0" * off)


def test_download_fetches_only_missing_layers(tmp_path, monkeypatch):
    names = [f"model.layers.{i}.w" for i in range(48)]
    _safetensors(tmp_path / "layers-41-48.safetensors", names[41:48])
    # The repo's one weights file, served by a fake Range-capable fetch.
    remote = tmp_path.parent / "remote.safetensors"
    _safetensors(remote, names)
    blob = remote.read_bytes()
    monkeypatch.setattr(slicer, "fetch_meta", lambda repo, d: {})
    monkeypatch.setattr(slicer, "weight_map", lambda repo, d: {n: "model.safetensors" for n in names})
    monkeypatch.setattr(slicer, "hf_hub_url", lambda repo, f: "https://example.test/" + f)
    fetched = []
    monkeypatch.setattr(slicer, "_fetch", lambda client, url, a, b, on_bytes=None: fetched.append((a, b)) or blob[a:b + 1])
    # Everything on disk already: no network at all.
    slicer.download_slice("r", tmp_path, 41, 48, name="layers-41b")
    assert fetched == [] and not (tmp_path / "layers-41b.safetensors").exists()
    # 36–47 with 41–47 here: the new file holds 36–40 only.
    out = slicer.download_slice("r", tmp_path, 36, 48, name="layers-36-48")
    hdr = json.loads(out.read_bytes()[8:8 + struct.unpack("<Q", out.read_bytes()[:8])[0]])
    assert sorted(int(n.split(".")[2]) for n in hdr if n != "__metadata__") == [36, 37, 38, 39, 40]


def test_trim_keeps_served_layers_and_drops_duplicates(tmp_path):
    names = [f"model.layers.{i}.w" for i in range(48)]
    _safetensors(tmp_path / "embed.safetensors", ["model.embed_tokens.weight"])
    _safetensors(tmp_path / "layers-41-48.safetensors", names[41:48])
    _safetensors(tmp_path / "layers-36-42.safetensors", names[36:42])   # layer 41 twice
    _safetensors(tmp_path / "layers-30-32.safetensors", names[30:32])
    freed = catalog.trim(tmp_path, [(38, 48)])
    assert freed > 0 and not (tmp_path / "layers-30-32.safetensors").exists()
    held = [n for f in sorted(tmp_path.glob("*.safetensors")) for n in json.loads(f.read_bytes()[8:8 + struct.unpack("<Q", f.read_bytes()[:8])[0]])]
    layers = sorted(int(n.split(".")[2]) for n in held if n.startswith("model.layers."))
    assert layers == list(range(38, 48))   # each once
    assert "model.embed_tokens.weight" in held
    assert catalog.trim(tmp_path, [(38, 48)]) == 0
