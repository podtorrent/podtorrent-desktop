"""Standalone slice download: each Mac can fetch its own layers without the other being online."""
import json
import os
import time
from pathlib import Path

from .slicer import download_slice


def progress_path() -> Path:
    return Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent")) / "download.json"


def run_download(role: str, repo: str, model_dir, split: int, n_layers: int):
    """role 'host' fetches layers [0, split) + embeddings + head; 'worker' fetches [split, n_layers)."""
    out = progress_path()
    out.parent.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, tuple[int, int]] = {}

    def write(phase, msg=""):
        done = sum(v[0] for v in sizes.values())
        total = sum(v[1] for v in sizes.values())
        out.write_text(json.dumps({"role": role, "split": split, "phase": phase, "done": done,
                                   "total": total, "message": msg, "ts": time.time()}))

    def prog(part):
        last = [0.0]

        def f(d, t):
            sizes[part] = (d, t)
            if time.time() - last[0] > 0.3 or d == t:
                last[0] = time.time()
                write("downloading")
        return f

    try:
        write("downloading")
        if role == "host":
            download_slice(repo, model_dir, 0, split, host=True, name=f"host-0-{split}", on_progress=prog("body"))
            download_slice(repo, model_dir, 0, 0, tail=True, name="head", on_progress=prog("head"))
        else:
            download_slice(repo, model_dir, split, n_layers, name=f"layers-{split}-{n_layers}",
                           on_progress=prog("body"))
        write("done")
    except Exception as e:  # noqa: BLE001
        write("error", str(e))
        raise
