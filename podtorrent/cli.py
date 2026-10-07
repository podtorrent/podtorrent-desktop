import argparse
import os
from pathlib import Path

DEFAULT_REPO = "mlx-community/Qwen3-30B-A3B-4bit"


def default_dir(repo):
    return Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent")) / "models" / repo.split("/")[-1]


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
        p.add_argument("--serve", help="layer range to serve, e.g. 0:24 (default: last one served)")
        p.add_argument("--open", action="store_true", help="open the dashboard in a browser")
        p.add_argument("--no-open", action="store_true", help=argparse.SUPPRESS)

    d = sub.add_parser("download", help="download this Mac's layers only (no peer needed)")
    d.add_argument("role", choices=["host", "worker"])
    d.add_argument("--split", type=int, default=24, help="host gets layers [0, split), worker the rest")
    d.add_argument("--model", default=DEFAULT_REPO)
    d.add_argument("--model-dir")
    d.add_argument("--layers", type=int, default=48)

    sw = sub.add_parser("swarm", help="list every PodTorrent peer online right now")
    sw.add_argument("--name", default=os.uname().nodename.split(".")[0])
    sw.add_argument("--watch", action="store_true", help="keep listening and print changes")

    a = ap.parse_args()
    if a.cmd in ("peer", "host"):
        from .peer import run_peer
        serve = tuple(int(x) for x in a.serve.split(":")) if a.serve else None
        run_peer(a.model, a.model_dir or default_dir(a.model), a.layers, a.port, serve, a.open)
    elif a.cmd == "download":
        from .download import run_download
        run_download(a.role, a.model, a.model_dir or default_dir(a.model), a.split, a.layers)
    elif a.cmd == "swarm":
        from .net.cli import run_swarm
        run_swarm(a.name, a.watch)


if __name__ == "__main__":
    main()
