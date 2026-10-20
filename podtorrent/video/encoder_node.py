"""This machine's share of the H3 prompt encoder: download layer slices, keep them, test them.

Backs the Encoder card in the Video view. Each slice is ~/.podtorrent/video/encoder/enc-LO-HI.safetensors,
fetched by range requests so a machine only downloads its own layers. "Test" encodes a prompt
with the layers this machine holds and reports time, memory and the output, so a Mac can try its
share live. Swarm jobs run these slices through video/swarm.py.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from pathlib import Path
from typing import Callable

from .. import backend
from ..net.identity import home
from .encoder_common import H3_ENCODER_REPO, H3_LAYERS

# Exact sizes from the 4-bit repo's headers: every layer is the same size.
LAYER_BYTES = 6_860_000_000 // 25
EMBED_BYTES = 440_000_000
# RAM the video engine keeps for itself while rendering a swarm job (video model + VAEs, no text encoder).
VIDEO_RAM_GB = 24.0
_SLICE = re.compile(r"^enc-(\d+)-(\d+)\.safetensors$")


def slice_bytes(lo: int, hi: int) -> int:
    return (hi - lo) * LAYER_BYTES + (EMBED_BYTES if lo == 0 else 0)


class EncoderNode:
    def __init__(self, emit: Callable):
        self.emit = emit
        self.dir = home() / "video" / "encoder"
        self.fetching: dict | None = None  # {lo, hi, done, total, error}
        self.testing = False
        self.last_test: dict | None = None
        self._shards: dict = {}  # (lo, hi) -> loaded shard, kept for the next test
        # Set by the peer: does this machine render video? Then its GPU belongs to the video engine,
        # and encoder slices run on the CPU from system RAM (a 12 GB card can't hold both).
        self.renders: Callable[[], bool] = lambda: False
        self.text_gb: Callable[[], float] = lambda: 0.0  # memory held by text-model slices (set by the peer)

    def shares_budget(self) -> bool:
        """Do encoder layers use the same memory as text-model slices? Not when they run on the CPU."""
        return self.device() != "cpu"

    def held_gb(self) -> float:
        return sum(slice_bytes(s["lo"], s["hi"]) for s in self.slices()) / backend.GB

    def reserved_gb(self) -> float:
        """Encoder layers on disk that will load on the next video job: text slices must leave room."""
        if not self.shares_budget():
            return 0.0
        return sum(slice_bytes(s["lo"], s["hi"]) for s in self.slices() if not s["loaded"]) / backend.GB

    def device(self) -> str:
        """Where encoder slices run: "mlx", "cuda" or "cpu" (PODTORRENT_ENCODER_DEVICE overrides)."""
        if backend.NAME == "mlx":
            return "mlx"
        if forced := os.environ.get("PODTORRENT_ENCODER_DEVICE"):
            return forced
        from ..shard_torch import default_device
        return "cpu" if self.renders() else default_device()

    def mem_budget_gb(self) -> float:
        """Memory for encoder slices: the model budget, or on a CPU render machine the RAM the video
        engine leaves free."""
        if self.device() == "cpu" and self.renders():
            import psutil
            return max(psutil.virtual_memory().total / backend.GB * 0.75 - VIDEO_RAM_GB, 0.0)
        return backend.mem_budget_gb()

    def slices(self) -> list[dict]:
        out = []
        for f in sorted(self.dir.glob("enc-*.safetensors")):
            if m := _SLICE.match(f.name):
                out.append({"lo": int(m[1]), "hi": int(m[2]), "bytes": f.stat().st_size,
                            "loaded": (int(m[1]), int(m[2])) in self._shards})
        return sorted(out, key=lambda s: s["lo"])

    def status(self) -> dict:
        self.dir.mkdir(parents=True, exist_ok=True)
        return {"repo": H3_ENCODER_REPO, "n_layers": H3_LAYERS, "layer_bytes": LAYER_BYTES,
                "embed_bytes": EMBED_BYTES, "backend": backend.NAME, "slices": self.slices(),
                "fetching": self.fetching, "testing": self.testing, "last_test": self.last_test,
                "disk_free": shutil.disk_usage(self.dir).free, "mem_budget_gb": round(self.mem_budget_gb(), 1),
                "device": self.device(), "shares_budget": self.shares_budget(),
                "text_gb": round(self.text_gb(), 1) if self.shares_budget() else 0.0, "held_gb": round(self.held_gb(), 1)}

    def _event(self):
        self.emit("video_encoder", key="video_encoder", **self.status())

    # ---- download ----
    def check(self, lo: int, hi: int) -> str | None:
        """Why this slice can't be fetched, or None."""
        if not 0 <= lo < hi <= H3_LAYERS:
            return f"Pick layers between 0 and {H3_LAYERS - 1}."
        if self.fetching and not self.fetching.get("error"):
            return "A download is already running."
        for s in self.slices():
            if s["lo"] < hi and lo < s["hi"]:
                return f"This machine already has layers {s['lo']}–{s['hi'] - 1}. Remove them first to pick a different range."
        need = slice_bytes(lo, hi)
        if need > shutil.disk_usage(self.dir).free - 2 * backend.GB:
            return f"Not enough disk space: needs {need / backend.GB:.1f} GB plus 2 GB to spare."
        have = sum(slice_bytes(s["lo"], s["hi"]) for s in self.slices())
        text = self.text_gb() if self.shares_budget() else 0.0
        left = self.mem_budget_gb() - text - have / backend.GB
        if need / backend.GB > left:
            return (f"Too big for this machine's memory: these layers need {need / backend.GB:.1f} GB and "
                    f"{max(left, 0):.1f} GB is left"
                    + (f" ({text:.1f} GB is used by text-model layers: stop serving some in My Node to make room)" if text >= 0.1 else "")
                    + ". Pick fewer layers.")
        return None

    def check_load(self, lo: int, hi: int):
        """Before a video job loads a slice: refuse clearly instead of running out of memory (chats
        on text-model layers can grow past what was planned at download time)."""
        if (lo, hi) in self._shards or not self.shares_budget():
            return
        need, free = slice_bytes(lo, hi) / backend.GB, backend.mem_free_gb()
        if need + 0.5 > free:
            raise RuntimeError(f"Not enough free memory on this machine for its video encoder layers {lo}–{hi - 1}: "
                               f"they need {need:.1f} GB and {free:.1f} GB is free. Stop serving some text-model "
                               "layers (My Node) or keep fewer encoder layers (Video).")

    def start_fetch(self, lo: int, hi: int) -> dict:
        if why := self.check(lo, hi):
            raise RuntimeError(why)
        self.fetching = {"lo": lo, "hi": hi, "done": 0, "total": slice_bytes(lo, hi), "error": None}
        self._event()
        asyncio.get_running_loop().create_task(self._fetch(lo, hi))
        return self.status()

    async def _fetch(self, lo: int, hi: int):
        from .encoder_common import download_slice
        loop = asyncio.get_running_loop()
        last = [0.0]

        def progress(done, total):
            self.fetching.update(done=done, total=total)
            if time.monotonic() - last[0] > 0.5:
                last[0] = time.monotonic()
                loop.call_soon_threadsafe(self._event)

        try:
            await asyncio.to_thread(download_slice, self.dir, lo, hi, H3_ENCODER_REPO, progress)
            self.fetching = None
        except Exception as e:  # noqa: BLE001
            for f in self.dir.glob(f"enc-{lo}-{hi}.*"):
                f.unlink(missing_ok=True)
            self.fetching["error"] = f"Download failed: {e}"
        self._event()

    async def remove(self, lo: int, hi: int) -> dict:
        """Delete layers [lo, hi) from this machine. A slice that's only partly inside the range is
        split: the layers outside it are copied into their own slice files first."""
        from ..slicer import split_slice
        if not 0 <= lo < hi <= H3_LAYERS:
            raise ValueError(f"Pick layers between 0 and {H3_LAYERS - 1}.")
        if self.testing:
            raise RuntimeError("A test is running. Remove layers after it finishes.")
        if self.fetching and not self.fetching.get("error") and self.fetching["lo"] < hi and lo < self.fetching["hi"]:
            raise RuntimeError("These layers are still downloading.")
        hit = [s for s in self.slices() if s["lo"] < hi and lo < s["hi"]]
        if not hit:
            raise ValueError("This machine has none of these layers.")
        for s in hit:
            keep = [(a, b) for a, b in ((s["lo"], lo), (hi, s["hi"])) if a < b]
            need = sum(slice_bytes(a, b) for a, b in keep)
            if need > shutil.disk_usage(self.dir).free - backend.GB:
                raise RuntimeError(f"Not enough disk space to keep layers outside {lo}–{hi - 1}: needs "
                                   f"{need / backend.GB:.1f} GB free while it copies them. Remove all of layers {s['lo']}–{s['hi'] - 1} instead.")
            src = self.dir / f"enc-{s['lo']}-{s['hi']}.safetensors"
            self._shards.pop((s["lo"], s["hi"]), None)
            if keep:
                await asyncio.to_thread(split_slice, src, self.dir, keep, "enc")
            src.unlink(missing_ok=True)
        self._event()
        return self.status()

    # ---- test ----
    async def test(self, prompt: str) -> dict:
        if self.testing:
            raise RuntimeError("A test is already running.")
        if not self.slices():
            raise RuntimeError("Download some encoder layers first.")
        self.testing = True
        self._event()
        try:
            self.last_test = await asyncio.to_thread(self._test, prompt)
        except Exception as e:  # noqa: BLE001
            self.last_test = {"ok": False, "error": str(e), "at": time.time()}
        finally:
            self.testing = False
            self._event()
        return self.last_test

    def _shard(self, lo, hi):
        if (lo, hi) not in self._shards:
            if backend.NAME == "mlx":
                from .encoder_mlx import EncoderShard
                self._shards[(lo, hi)] = EncoderShard(self.dir, lo, hi, embed=lo == 0)
            else:
                from .encoder_torch import TorchEncoderShard
                self._shards[(lo, hi)] = TorchEncoderShard(self.dir, lo, hi, embed=lo == 0, device=self.device())
        return self._shards[(lo, hi)]

    def _test(self, prompt: str) -> dict:
        """Run this machine's slices in layer order. Contiguous slices pass the hidden state along;
        a slice that doesn't start at layer 0 and has no slice before it here gets a stand-in input
        (what the previous machine would send), so its speed and memory are still real."""
        import numpy as np

        from .encoder_common import text_config, tokenize
        ids = tokenize(self.dir, prompt)
        hidden = text_config(self.dir)["hidden_size"]
        mlx = backend.NAME == "mlx"
        if mlx:
            import mlx.core as mx
            mx.reset_peak_memory()
        else:
            import torch
        t0, h, prev_hi, runs = time.time(), None, None, []
        stand_in = False
        for s in self.slices():
            t = time.time()
            shard = self._shard(s["lo"], s["hi"])
            load_s = time.time() - t
            if h is None or s["lo"] != prev_hi:
                if s["lo"] == 0:
                    h = shard.embed(mx.array([ids]) if mlx else [ids])
                else:
                    stand_in = True
                    rnd = np.random.default_rng(0).standard_normal((1, len(ids), hidden)).astype(np.float32)
                    h = mx.array(rnd).astype(mx.bfloat16) if mlx else torch.from_numpy(rnd)
            t = time.time()
            h = shard.run_layers(h)
            if mlx:
                mx.eval(h)
            runs.append({"lo": s["lo"], "hi": s["hi"], "load_s": round(load_s, 2), "run_s": round(time.time() - t, 2)})
            prev_hi = s["hi"]
        out = np.array(h.astype(mx.float32)) if mlx else h.float().cpu().numpy()
        full = not stand_in and runs[0]["lo"] == 0 and prev_hi == H3_LAYERS and \
            all(a["hi"] == b["lo"] for a, b in zip(runs, runs[1:]))
        return {"ok": bool(np.isfinite(out).all()), "at": time.time(), "prompt": prompt, "tokens": len(ids),
                "runs": runs, "seconds": round(time.time() - t0, 2), "shape": list(out.shape),
                "peak_gb": round((mx.get_peak_memory() if mlx else 0) / 1e9, 2),
                "mean_abs": float(np.abs(out).mean()), "max_abs": float(np.abs(out).max()),
                "stand_in": stand_in, "complete": full,
                "error": None if np.isfinite(out).all() else "The output has NaN or infinite values."}
