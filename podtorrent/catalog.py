"""Model catalog: search MLX models on Hugging Face, see what's on this Mac, suggest a slice, delete."""
import json
import shutil
from pathlib import Path

import httpx
from huggingface_hub import hf_hub_url

from .cli import default_dir
from .slicer import LAYER_RE, _headers, local_tensors

HF_API = "https://huggingface.co/api/models"
REPO_FILE = ".repo"   # written next to a model's files so the folder maps back to its HF repo
GB = 1 << 30


def models_home() -> Path:
    return default_dir("x/x").parent


def search(q: str, limit: int = 24) -> list[dict]:
    """MLX text-generation models matching `q`, most downloaded first."""
    params = {"search": q, "filter": "mlx", "pipeline_tag": "text-generation", "sort": "downloads",
              "direction": "-1", "limit": str(limit)}
    r = httpx.get(HF_API, params=params, headers=_headers(), timeout=10, follow_redirects=True)
    r.raise_for_status()
    return [{"repo": m["id"], "downloads": m.get("downloads", 0), "likes": m.get("likes", 0),
             "updated": m.get("lastModified")} for m in r.json()]


def info(repo: str) -> dict:
    """Layer count and size from the repo's config and safetensors index (small files, nothing saved)."""
    def get(f):
        r = httpx.get(hf_hub_url(repo, f), headers=_headers(), timeout=15, follow_redirects=True)
        r.raise_for_status()
        return r.json()
    cfg = get("config.json")
    cfg = cfg.get("text_config", cfg) if "num_hidden_layers" not in cfg else cfg
    n = cfg.get("num_hidden_layers")
    if not n:
        raise ValueError(f"{repo} has no num_hidden_layers in config.json")
    try:
        total = get("model.safetensors.index.json").get("metadata", {}).get("total_size") or 0
    except httpx.HTTPStatusError:
        total = 0   # single-file model: size unknown up front
    return {"repo": repo, "n_layers": n, "size_bytes": total, "layer_bytes": total // n if total else 0,
            "model_type": cfg.get("model_type", "")}


def _repo_of(d: Path, known: list[str]) -> str | None:
    try:
        return (d / REPO_FILE).read_text().strip()
    except OSError:
        return next((r for r in known if r.split("/")[-1] == d.name), None)


def local(known: list[str] = ()) -> list[dict]:
    """Every model folder on this Mac: which layers it holds and how much disk it takes."""
    out = []
    home = models_home()
    if not home.is_dir():
        return out
    for d in sorted(p for p in home.iterdir() if p.is_dir()):
        repo = _repo_of(d, list(known))
        try:
            n = json.loads((d / "config.json").read_text()).get("num_hidden_layers")
        except (OSError, ValueError):
            n = None
        layers = sorted({int(m.group(1)) for t in local_tensors(d) if (m := LAYER_RE.match(t))})
        size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        out.append({"repo": repo or d.name, "dir": d.name, "n_layers": n, "layers": _runs(layers),
                    "complete": bool(n) and len(layers) == n, "disk_bytes": size})
    return out


def _runs(xs: list[int]) -> list[list[int]]:
    """[0,1,2,5,6] -> [[0,3],[5,7]] (half-open ranges)."""
    runs: list[list[int]] = []
    for x in xs:
        if runs and runs[-1][1] == x:
            runs[-1][1] += 1
        else:
            runs.append([x, x + 1])
    return runs


def suggest(n_layers: int, layer_bytes: int, free_gb: float, gaps: list, have: list,
            in_swarm: bool = False) -> dict:
    """A layer range for this Mac: inside the swarm's first gap if there is one, else from layer 0,
    sized to free memory (10% headroom), skipping layers already served here."""
    fit = int(free_gb * GB * 0.9 // layer_bytes) if layer_bytes else n_layers
    fit = max(min(fit, n_layers), 0)
    lo, hi = (gaps[0] if gaps else [0, n_layers])
    if have and not gaps:   # already serving some: extend after the last served layer
        lo = max(b for _, b in have)
        hi = n_layers
    hi = min(hi, lo + fit)
    return {"lo": lo, "hi": hi, "fits": fit, "fits_all": fit >= n_layers,
            "reason": ("Fills the swarm's missing layers" if gaps else "Extends what this machine serves" if have
                       else "Adds a second copy, so failures re-route" if in_swarm else "Starts the model in the swarm") if hi > lo else "Not enough free memory for one layer"}


def delete(dir_name: str):
    d = (models_home() / dir_name).resolve()
    if d.parent != models_home().resolve() or not d.is_dir():
        raise ValueError("not a model folder")
    shutil.rmtree(d)
