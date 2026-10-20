"""Download only the tensors a node needs, via HTTP range requests on HF safetensors files."""
import json
import re
import struct
from pathlib import Path
from typing import Callable, Optional

import httpx
from huggingface_hub import get_token, hf_hub_download, hf_hub_url

# Language-model keys: "model.layers.N." (Qwen3), "model.language_model.layers.N." or
# "language_model.model.layers.N." (Qwen3-VL). Vision-tower tensors are never selected.
LAYER_RE = re.compile(r"^(?:model\.|language_model\.)*layers\.(\d+)\.")
EMBED_RE = re.compile(r"^(?:model\.|language_model\.)*embed_tokens\.")
NORM_RE = re.compile(r"^(?:model\.|language_model\.)*norm\.weight$")


def select_tensors(weight_map: dict, lo: int, hi: int, host: bool, tail: bool) -> list[str]:
    """Tensor names for layers [lo, hi). host=embeddings; tail=final norm + lm_head."""
    names = []
    for name in weight_map:
        m = LAYER_RE.match(name)
        if m:
            if lo <= int(m.group(1)) < hi:
                names.append(name)
        elif EMBED_RE.match(name) and host:
            names.append(name)
        elif (name.startswith("lm_head.") or NORM_RE.match(name)) and tail:
            names.append(name)
    return names


def local_tensors(out_dir: Path) -> set[str]:
    """Names of every tensor already in out_dir/*.safetensors (reads headers only)."""
    names: set[str] = set()
    for f in Path(out_dir).glob("*.safetensors"):
        try:
            with open(f, "rb") as fh:
                (n,) = struct.unpack("<Q", fh.read(8))
                names |= set(json.loads(fh.read(n))) - {"__metadata__"}
        except (OSError, ValueError, struct.error):
            continue
    return names


def _headers() -> dict:
    tok = get_token()  # HF_TOKEN env var or ~/.cache/huggingface/token
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def _fetch(client: httpx.Client, url: str, start: int, end: int) -> bytes:
    """Inclusive byte range [start, end]."""
    r = client.get(url, headers={**_headers(), "Range": f"bytes={start}-{end}"})
    r.raise_for_status()
    if r.status_code != 206:
        raise RuntimeError(f"server ignored Range request for {url}")
    return r.content


META_FILES = ("config.json", "model.safetensors.index.json", "tokenizer.json",
              "tokenizer_config.json", "generation_config.json")


def fetch_meta(repo: str, out_dir: str | Path) -> dict:
    """Fetch the small config/index/tokenizer files (no weights) and return config.json."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / ".repo").write_text(repo)  # lets the catalog map this folder back to its repo
    for f in META_FILES:
        if (out_dir / f).exists():
            continue
        try:
            hf_hub_download(repo, f, local_dir=out_dir)
        except Exception:
            pass  # optional files
    return json.loads((out_dir / "config.json").read_text())


def weight_map(repo: str, out_dir: str | Path) -> dict:
    """tensor name -> file, from the repo's index if it matches the repo's files. Some repos ship a
    stale index (mlx-community/Qwen3-VL-32B-Instruct-4bit lists 14 files but has 4); then read the
    real files' headers instead and cache the result as weight_map.json."""
    from huggingface_hub import HfApi
    out_dir = Path(out_dir)
    cached = out_dir / "weight_map.json"
    if cached.exists():
        return json.loads(cached.read_text())
    files = [f for f in HfApi().list_repo_files(repo) if f.endswith(".safetensors")]
    idx = out_dir / "model.safetensors.index.json"
    wm = json.loads(idx.read_text())["weight_map"] if idx.exists() else {}
    if not wm or not set(wm.values()) <= set(files):
        wm = {}
        with httpx.Client(follow_redirects=True, timeout=120) as client:
            for f in files:
                url = hf_hub_url(repo, f)
                (hlen,) = struct.unpack("<Q", _fetch(client, url, 0, 7))
                wm.update({k: f for k in json.loads(_fetch(client, url, 8, 8 + hlen - 1)) if k != "__metadata__"})
    cached.write_text(json.dumps(wm))
    return wm


def estimate_slice_bytes(out_dir: str | Path, lo: int, hi: int) -> int:
    """Rough size of layers [lo, hi) from the index's total size, ignoring embeddings and head
    (fetch_meta first). Good enough for a memory check before downloading."""
    out_dir = Path(out_dir)
    cfg = json.loads((out_dir / "config.json").read_text())
    index = json.loads((out_dir / "model.safetensors.index.json").read_text())
    total = index.get("metadata", {}).get("total_size") or 0
    extra = 2 * cfg.get("vocab_size", 0) * cfg.get("hidden_size", 0) // 2  # embed + head, ~4-bit + scales
    return max(total - extra, 0) * (hi - lo) // max(cfg["num_hidden_layers"], 1)


def download_slice(
    repo: str,
    out_dir: str | Path,
    lo: int,
    hi: int,
    host: bool = False,
    tail: bool = False,
    on_progress: Optional[Callable[[int, int], None]] = None,
    name: str = "slice",
) -> Path:
    """Write out_dir/<name>.safetensors holding only the requested tensors.

    Also fetches config/tokenizer files. on_progress(bytes_done, bytes_total).
    """
    out_dir = Path(out_dir)
    fetch_meta(repo, out_dir)

    out_path = out_dir / f"{name}.safetensors"
    index = {"weight_map": weight_map(repo, out_dir)}
    wanted = select_tensors(index["weight_map"], lo, hi, host, tail)
    if out_path.exists() or set(wanted) <= local_tensors(out_dir):  # already fetched, maybe as another slice
        size = out_path.stat().st_size if out_path.exists() else 1
        if on_progress:
            on_progress(size, size)
        return out_path
    by_file: dict[str, list[str]] = {}
    for n in wanted:
        by_file.setdefault(index["weight_map"][n], []).append(n)

    tmp_data = out_dir / f"{name}.data.tmp"
    header: dict = {}
    pos = 0
    total = 0
    done = 0
    with httpx.Client(follow_redirects=True, timeout=120) as client, open(tmp_data, "wb") as data:
        plans = []  # (url, [(name, meta, abs_start, abs_end)])
        for fname, names in sorted(by_file.items()):
            url = hf_hub_url(repo, fname)
            (hlen,) = struct.unpack("<Q", _fetch(client, url, 0, 7))
            fh = json.loads(_fetch(client, url, 8, 8 + hlen - 1))
            base = 8 + hlen
            items = sorted(
                ((n, fh[n], base + fh[n]["data_offsets"][0], base + fh[n]["data_offsets"][1] - 1)
                 for n in names),
                key=lambda t: t[2],
            )
            plans.append((url, items))
            total += sum(e - s + 1 for _, _, s, e in items)

        for url, items in plans:
            # coalesce adjacent tensors into one request
            i = 0
            while i < len(items):
                j = i
                while j + 1 < len(items) and items[j + 1][2] == items[j][3] + 1 \
                        and items[j + 1][3] - items[i][2] < 256 * 2**20:
                    j += 1
                blob = _fetch(client, url, items[i][2], items[j][3])
                for n, meta, s, e in items[i:j + 1]:
                    chunk = blob[s - items[i][2]: e - items[i][2] + 1]
                    data.write(chunk)
                    header[n] = {"dtype": meta["dtype"], "shape": meta["shape"],
                                 "data_offsets": [pos, pos + len(chunk)]}
                    pos += len(chunk)
                done += len(blob)
                if on_progress:
                    on_progress(done, total)
                i = j + 1

    header["__metadata__"] = {"format": "mlx"}
    hb = json.dumps(header).encode()
    hb += b" " * (-len(hb) % 8)
    with open(out_path, "wb") as out, open(tmp_data, "rb") as data:
        out.write(struct.pack("<Q", len(hb)))
        out.write(hb)
        while chunk := data.read(64 * 2**20):
            out.write(chunk)
    tmp_data.unlink()
    return out_path
