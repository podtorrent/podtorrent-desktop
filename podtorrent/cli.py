import argparse
import os
import platform
from pathlib import Path

DEFAULT_REPO = "mlx-community/Qwen3-30B-A3B-4bit"


def default_dir(repo):
    return Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent")) / "models" / repo.split("/")[-1]


def parse_slice(spec: str) -> tuple[str | None, int, int]:
    """"0:24" or "mlx-community/Qwen3-30B-A3B-4bit:0:24" -> (model or None, lo, hi)."""
    parts = spec.rsplit(":", 2)
    if len(parts) < 2:
        raise argparse.ArgumentTypeError(f"expected [MODEL:]LO:HI, got {spec!r}")
    model = parts[0] if len(parts) == 3 else None
    try:
        return model, int(parts[-2]), int(parts[-1])
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected [MODEL:]LO:HI, got {spec!r}") from None


def local_api(path: str, body: dict | None, port: int) -> dict:
    """Call the running peer's local API."""
    import json
    import urllib.error
    import urllib.request
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=7200) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())
    except urllib.error.URLError as e:
        raise SystemExit(f"no peer running on 127.0.0.1:{port} ({e.reason}); start one with `podtorrent peer`")


def print_models(r: dict):
    for m in r.get("models", []):
        cov = "".join(" " if c == 0 else "▒" if c == 1 else "█" for c in m["coverage"])
        state = {"available": f"available · redundancy {m['redundancy']}",
                 "partial": "partial · " + ", ".join(f"layers {a}–{b - 1} missing" for a, b in m["gaps"]),
                 "offline": "offline"}[m["state"]]
        print(f"{m['model']}{' (default)' if m.get('default') else ''}: {state}")
        print(f"  |{cov}| {m['n_layers']} layers")
        if m["route"]:
            print("  route: " + " → ".join(f"{n} [{lo},{hi})" for n, lo, hi in m["route"]))
    mine = ", ".join(f"{s['model'].split('/')[-1]} [{s['lo']},{s['hi']}) {s['phase']}" for s in r.get("slices", []))
    print(f"this Mac serves: {mine or 'nothing'} · {r.get('mem_free_gb', '?')} GB free for models")


def main():
    ap = argparse.ArgumentParser(prog="podtorrent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    for cmd in ("peer", "host"):  # `host` is the pre-P2P name, kept for old app builds
        p = sub.add_parser(cmd, help="run this Mac's peer: serve layers, request completions, local API"
                           if cmd == "peer" else argparse.SUPPRESS)
        p.add_argument("--model", default=DEFAULT_REPO)
        p.add_argument("--model-dir")
        p.add_argument("--layers", type=int, help="total layers (default: from the model's config)")
        p.add_argument("--port", type=int, default=8000, help="local API port (127.0.0.1 only)")
        p.add_argument("--serve", action="append", type=parse_slice, metavar="[MODEL:]LO:HI",
                       help="a slice to serve, e.g. 0:24 or mlx-community/X:0:24; repeatable "
                            "(default: the slices saved from last time)")
        p.add_argument("--open", action="store_true", help="open the dashboard in a browser")
        p.add_argument("--no-open", action="store_true", help=argparse.SUPPRESS)

    d = sub.add_parser("download", help="download this Mac's layers only (no peer needed)")
    d.add_argument("role", choices=["host", "worker"])
    d.add_argument("--split", type=int, default=24, help="host gets layers [0, split), worker the rest")
    d.add_argument("--model", default=DEFAULT_REPO)
    d.add_argument("--model-dir")
    d.add_argument("--layers", type=int, default=48)

    for cmd, desc in (("serve", "ask the running peer to serve another slice (waits until loaded)"),
                      ("unserve", "ask the running peer to stop serving a slice, or a whole model")):
        c = sub.add_parser(cmd, help=desc)
        c.add_argument("slice", type=parse_slice if cmd == "serve" else str,
                       metavar="[MODEL:]LO:HI" if cmd == "serve" else "[MODEL:]LO:HI | MODEL")
        if cmd == "serve":
            c.add_argument("--peer", help="have this connected peer (name or id) serve it instead")
        c.add_argument("--port", type=int, default=8000)
    m = sub.add_parser("models", help="coverage of every model the swarm serves, as this peer sees it")
    m.add_argument("--port", type=int, default=8000)

    sw = sub.add_parser("swarm", help="list every PodTorrent peer online right now")
    sw.add_argument("--name", default=platform.node().split(".")[0])
    sw.add_argument("--watch", action="store_true", help="keep listening and print changes")

    a = ap.parse_args()
    if a.cmd in ("peer", "host"):
        from .peer import run_peer
        run_peer(a.model, a.model_dir or default_dir(a.model), a.layers, a.port, a.serve, a.open)
    elif a.cmd == "serve":
        model, lo, hi = a.slice
        r = local_api("/api/serve", {"model": model, "lo": lo, "hi": hi, "peer": a.peer, "wait": True}, a.port)
        if "error" in r:
            raise SystemExit(r["error"])
        print_models(local_api("/api/models", None, a.port))
    elif a.cmd == "unserve":
        try:
            model, lo, hi = parse_slice(a.slice)
            body = {"model": model, "lo": lo, "hi": hi}
        except argparse.ArgumentTypeError:
            body = {"model": a.slice}
        r = local_api("/api/unserve", body, a.port)
        if "error" in r:
            raise SystemExit(r["error"])
        print_models(local_api("/api/models", None, a.port))
    elif a.cmd == "models":
        print_models(local_api("/api/models", None, a.port))
    elif a.cmd == "download":
        from .download import run_download
        run_download(a.role, a.model, a.model_dir or default_dir(a.model), a.split, a.layers)
    elif a.cmd == "swarm":
        from .net.cli import run_swarm
        run_swarm(a.name, a.watch)


if __name__ == "__main__":
    main()
