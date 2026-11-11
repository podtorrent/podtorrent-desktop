"""Find out how much memory a GPU can really hold, instead of trusting what the driver reports.

Integrated GPUs (AMD Ryzen AI Max "Strix Halo", other APUs) share system RAM. PyTorch reports only the
slice the BIOS set aside, often a few GB on a machine with 64 to 192 GB, so a budget taken from that
number would hold almost no layers. Allocating a big block succeeds or fails the same way a real
slice would, so we ask the device itself and remember the answer. This module has no torch import:
the caller passes the allocation test, which keeps it testable without a GPU.
"""
import json
import os
from pathlib import Path

GB = 2**30
# On a shared-memory machine the OS, the model loader and the UI still need RAM.
RAM_SHARE = 0.85
TOLERANCE_GB = 1.0


def find_limit(try_alloc, known_ok_gb: float, ceiling_gb: float, tol_gb: float = TOLERANCE_GB) -> float:
    """The largest size in GB (to within tol_gb) for which try_alloc(gb) succeeds, from known_ok_gb up
    to ceiling_gb. known_ok_gb is what the driver reports, assumed to work."""
    if ceiling_gb <= known_ok_gb + tol_gb:
        return known_ok_gb
    if try_alloc(ceiling_gb):
        return ceiling_gb
    lo, hi = known_ok_gb, ceiling_gb
    while hi - lo > tol_gb:
        mid = (lo + hi) / 2
        if try_alloc(mid):
            lo = mid
        else:
            hi = mid
    return lo


def _cache_path() -> Path:
    return Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent")) / "gpu-probe.json"


def probe_cached(key: str, probe) -> float:
    """probe() once per key (device, PyTorch version, RAM size), then reuse the answer. A new driver,
    PyTorch or BIOS memory split changes the key, so the probe runs again."""
    path = _cache_path()
    try:
        saved = json.loads(path.read_text())
        if saved.get("key") == key:
            return float(saved["gb"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    gb = probe()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"key": key, "gb": gb}))
    except OSError:
        pass  # read-only home: just probe again next time
    return gb
