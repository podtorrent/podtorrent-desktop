import argparse
import os
from pathlib import Path

DEFAULT_REPO = "mlx-community/Qwen3-30B-A3B-4bit"


def default_dir(repo):
    return Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent")) / "models" / repo.split("/")[-1]


def main():
    ap = argparse.ArgumentParser(prog="podtorrent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    h = sub.add_parser("host", help="run the dashboard + engine")
    h.add_argument("--model", default=DEFAULT_REPO)
    h.add_argument("--model-dir")
    h.add_argument("--layers", type=int, default=48, help="total layers in the model")
    h.add_argument("--port", type=int, default=8000)
    h.add_argument("--no-open", action="store_true")

    j = sub.add_parser("join", help="join a host as a worker")
    j.add_argument("addr", help="host address, e.g. 192.168.1.5:8000")
    j.add_argument("--model", default=DEFAULT_REPO)
    j.add_argument("--model-dir")
    j.add_argument("--name", default=os.uname().nodename.split(".")[0])
    j.add_argument("--grpc-port", type=int, default=50051)
    j.add_argument("--status-port", type=int, default=8001)
    j.add_argument("--advertise", help="IP the host should dial (default: auto)")

    d = sub.add_parser("download", help="download this Mac's layers only (no peer needed)")
    d.add_argument("role", choices=["host", "worker"])
    d.add_argument("--split", type=int, default=24, help="host gets layers [0, split), worker the rest")
    d.add_argument("--model", default=DEFAULT_REPO)
    d.add_argument("--model-dir")
    d.add_argument("--layers", type=int, default=48)

    w = sub.add_parser("worker-static", help="(tests) serve a preloaded layer range")
    w.add_argument("--model-dir", required=True)
    w.add_argument("--lo", type=int, required=True)
    w.add_argument("--hi", type=int, required=True)
    w.add_argument("--port", type=int, default=50051)

    a = ap.parse_args()
    if a.cmd == "host":
        from .server import run_host
        run_host(a.model, a.model_dir or default_dir(a.model), a.layers, a.port, not a.no_open)
    elif a.cmd == "download":
        from .download import run_download
        run_download(a.role, a.model, a.model_dir or default_dir(a.model), a.split, a.layers)
    elif a.cmd == "join":
        from .worker import run_join
        run_join(a.addr, a.model_dir or default_dir(a.model), a.name, a.grpc_port, a.status_port, a.advertise)
    else:
        from .worker import serve_static
        serve_static(a.model_dir, a.lo, a.hi, a.port)


if __name__ == "__main__":
    main()
