import argparse
import os
import platform
from pathlib import Path

DEFAULT_REPO = "mlx-community/Qwen3-30B-A3B-4bit"


# Deliberately uncommon so we never fight dev tools (8000, 3000, ...) for the port.
DEFAULT_PORT = int(os.environ.get("PODTORRENT_PORT", "27183"))


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


def parse_serve(spec: str):
    """A layer slice ([MODEL:]LO:HI) or a video role (h3-encoder:LO:HI, h3-video)."""
    if spec.startswith("h3-"):
        from .route import parse_role
        if spec != "h3-video" and not (parse_role(spec) or ("",))[0] == "encoder":
            raise argparse.ArgumentTypeError(f"expected h3-encoder:LO:HI or h3-video, got {spec!r}")
        return spec
    return parse_slice(spec)


def serve_video_role(role: str, port: int, remove: bool = False):
    """Take on (or drop) a video role on the running peer, waiting for the download."""
    import time
    if role == "h3-video":
        if remove:
            raise SystemExit("To stop rendering, delete the video engine folder shown in the Video view.")
        r = local_api("/api/video/setup", {}, port)
        if "error" in r:
            raise SystemExit(r["error"])
        last = ""
        while True:
            st = local_api("/api/video/status", None, port)
            su = st.get("setup") or {}
            if st.get("installed") and st.get("models_ready"):
                break
            if su.get("phase") == "error":
                raise SystemExit(su.get("message") or "setup failed")
            line = su.get("message", "") + (f" {100 * su['done'] // su['total']}%" if su.get("total") else "")
            if line != last:
                print(line, flush=True)
                last = line
            time.sleep(2)
    else:
        lo, hi = (int(x) for x in role.split(":")[1:])
        r = local_api("/api/video/encoder/" + ("remove" if remove else "fetch"), {"lo": lo, "hi": hi}, port)
        if "error" in r:
            raise SystemExit(r["error"])
        last = -1
        while not remove:
            st = local_api("/api/video/encoder", None, port)
            f = st.get("fetching")
            if any(x["lo"] == lo and x["hi"] == hi for x in st.get("slices", [])) and not f:
                break
            if f and f.get("error"):
                raise SystemExit(f["error"])
            pct = 100 * f["done"] // max(f["total"], 1) if f else 0
            if pct // 5 != last:
                print(f"downloading encoder layers {lo}–{hi - 1}: {pct}%", flush=True)
                last = pct // 5
            time.sleep(2)
    print_video(local_api("/api/video/swarm", None, port))


def print_video(r: dict):
    for m in r.get("machines", []):
        enc = ", ".join(f"[{lo},{hi})" for lo, hi in m["encoder"]) or "–"
        vid = "renders" if m["video"] else (m["video_why"] or "–")
        print(f"{m['name']}: encoder {enc} · video {vid}")
    if r.get("route"):
        rt = r["route"]
        print("video route: " + " → ".join(f"{n} [{lo},{hi})" for n, lo, hi in rt["encoder"]) + f" → render on {rt['video']}")
    else:
        print(f"video route: none. {r.get('reason', '')}")


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
    print(f"this machine serves: {mine or 'nothing'} · {r.get('mem_free_gb', '?')} GB free for models")


def main():
    ap = argparse.ArgumentParser(prog="podtorrent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    for cmd in ("peer", "host"):  # `host` is the pre-P2P name, kept for old app builds
        p = sub.add_parser(cmd, help="run this machine's peer: serve layers, request completions, local API"
                           if cmd == "peer" else argparse.SUPPRESS)
        p.add_argument("--model", default=DEFAULT_REPO)
        p.add_argument("--model-dir")
        p.add_argument("--layers", type=int, help="total layers (default: from the model's config)")
        p.add_argument("--port", type=int, default=DEFAULT_PORT,
                       help=f"local API port, 127.0.0.1 only (default {DEFAULT_PORT}; env PODTORRENT_PORT)")
        p.add_argument("--serve", action="append", type=parse_slice, metavar="[MODEL:]LO:HI",
                       help="a slice to serve, e.g. 0:24 or mlx-community/X:0:24; repeatable "
                            "(default: the slices saved from last time)")
        p.add_argument("--open", action="store_true", help="open the dashboard in a browser")
        p.add_argument("--no-open", action="store_true", help=argparse.SUPPRESS)

    d = sub.add_parser("download", help="download this machine's layers only (no peer needed)")
    d.add_argument("role", choices=["host", "worker"])
    d.add_argument("--split", type=int, default=24, help="host gets layers [0, split), worker the rest")
    d.add_argument("--model", default=DEFAULT_REPO)
    d.add_argument("--model-dir")
    d.add_argument("--layers", type=int, default=48)

    for cmd, desc in (("serve", "ask the running peer to serve another slice (waits until loaded)"),
                      ("unserve", "ask the running peer to stop serving a slice, or a whole model")):
        c = sub.add_parser(cmd, help=desc)
        c.add_argument("slice", type=parse_serve if cmd == "serve" else str,
                       metavar="[MODEL:]LO:HI | h3-encoder:LO:HI | h3-video" if cmd == "serve"
                       else "[MODEL:]LO:HI | MODEL | h3-encoder:LO:HI")
        if cmd == "serve":
            c.add_argument("--peer", help="have this connected peer (name or id) serve it instead")
        c.add_argument("--port", type=int, default=DEFAULT_PORT)
    v = sub.add_parser("video", help="video roles of every machine and the route a video job would take")
    v.add_argument("--port", type=int, default=DEFAULT_PORT)
    m = sub.add_parser("models", help="coverage of every model the swarm serves, as this peer sees it")
    m.add_argument("--port", type=int, default=DEFAULT_PORT)

    sw = sub.add_parser("swarm", help="list every PodTorrent peer online right now")
    sw.add_argument("--name", default=platform.node().split(".")[0])
    sw.add_argument("--watch", action="store_true", help="keep listening and print changes")

    a = ap.parse_args()
    if a.cmd in ("peer", "host"):
        from .peer import run_peer
        run_peer(a.model, a.model_dir or default_dir(a.model), a.layers, a.port, a.serve, a.open)
    elif a.cmd == "serve" and isinstance(a.slice, str):
        if a.peer:
            raise SystemExit("--peer works for model slices only; run `podtorrent serve` on that machine")
        serve_video_role(a.slice, a.port)
    elif a.cmd == "unserve" and a.slice.startswith("h3-"):
        serve_video_role(a.slice, a.port, remove=True)
    elif a.cmd == "video":
        print_video(local_api("/api/video/swarm", None, a.port))
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
