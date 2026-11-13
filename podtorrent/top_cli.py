"""`podtorrent top` (a live view of this machine and the swarm in the terminal) and `podtorrent status`
(the same once, or as JSON for scripts and monitoring). Reads the running peer's /api/swarm.

Standard library only: the backend's lockfile is pinned to ROCm / CUDA PyTorch, and a new dependency
would mean relocking it for every platform.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

# How the user runs PodTorrent, for hints: `podtorrent` when installed on PATH (the launcher says so).
CMD = os.environ.get("PODTORRENT_CMD", "./podtorrent")


# ---- reading ----

def snapshot(port: int) -> dict:
    from .cli import local_api
    snap = local_api("/api/swarm", None, port)
    if "me" not in snap:   # an older peer without /api/swarm
        raise SystemExit("this peer is too old for `top`; update PodTorrent and restart the peer")
    snap["network"] = network_state()
    return snap


def network_state() -> dict:
    """Whether this machine joined the PodTorrent network, from network.json (the token is never read)."""
    home = Path(os.environ.get("PODTORRENT_HOME", Path.home() / ".podtorrent"))
    try:
        n = json.loads((home / "network.json").read_text())
    except (OSError, ValueError):
        return {"joined": False}
    out = {"joined": True, "node": n.get("node"), "network": n.get("network", "production")}
    try:
        lines = (home / "agent.log").read_text(errors="replace").strip().splitlines()
        out["agent_last"] = lines[-1][-120:] if lines else ""
    except OSError:
        out["agent_last"] = None
    return out


# ---- rendering (pure, tested in tests/test_top_cli.py) ----

def short(model: str) -> str:
    return (model or "?").split("/")[-1]


def human(n) -> str:
    if n is None:
        return "–"
    n = float(n)
    for unit, d in (("G", 1e9), ("M", 1e6), ("k", 1e3)):
        if n >= d:
            return f"{n / d:.1f}{unit}"
    return f"{n:.0f}"


def cov_bar(coverage: list[int], width: int, ascii_only: bool = False) -> str:
    """Per-layer peer counts squeezed into `width` cells; each cell shows its weakest layer:
    blank = no peer, light = one copy, solid = two or more."""
    if not coverage:
        return " " * width
    glyphs = (" ", "-", "#") if ascii_only else (" ", "▒", "█")
    n, out = len(coverage), []
    for i in range(width):
        a, b = i * n // width, max((i + 1) * n // width, i * n // width + 1)
        c = min(coverage[a:b])
        out.append(glyphs[min(c, 2)])
    return "".join(out)


def rates(snap: dict, prev: dict | None) -> dict[str, float]:
    """Tokens per second for each machine (by peer_id) since the previous snapshot."""
    if not prev:
        return {}
    dt = snap.get("time", 0) - prev.get("time", 0)
    if dt <= 0:
        return {}
    before = {prev["me"]["peer_id"]: prev["me"].get("tokens")} | {p["peer_id"]: p.get("tokens") for p in prev["peers"]}
    out = {}
    for m in [snap["me"], *snap["peers"]]:
        a, b = before.get(m["peer_id"]), m.get("tokens")
        if a is not None and b is not None and b >= a:
            out[m["peer_id"]] = (b - a) / dt
    return out


def fmt_slices(slices: list[dict]) -> str:
    return ", ".join(f"{short(s['model'])} {s['lo']}–{s['hi'] - 1}" + ("" if s.get("loaded") else " (loading)")
                     for s in slices) or "nothing"


def render(snap: dict, prev: dict | None = None, width: int = 100, ascii_only: bool = False) -> list[str]:
    width = max(60, min(width, 140))
    me, tok_s = snap["me"], rates(snap, prev)
    out = []
    online = sum(1 for p in snap["peers"] if p["state"] == "direct")
    out.append(f"PodTorrent · {me['name']} · {me.get('chip') or '?'} · {me.get('mem_total_gb', '?')} GB"
               f" · {me.get('mem_free_gb', '?')} GB free for models")
    out.append(f"swarm {snap.get('status', '?')} · {online} connected of {len(snap['peers'])} other peers")
    out.append("")

    out.append("THIS MACHINE")
    for s in me.get("slices") or []:
        state = s.get("phase") or ("ready" if s.get("loaded") else "loading")
        prog = f" {100 * s['done'] // s['total']}%" if s.get("total") and state in ("downloading", "loading") else ""
        out.append(f"  serving {short(s['model'])} layers {s['lo']}–{s['hi'] - 1}  {state}{prog}")
    if not me.get("slices"):
        out.append(f"  serving nothing yet: {CMD} setup picks a model and layers")
    r = tok_s.get(me["peer_id"])
    out.append(f"  requests {human(me.get('requests'))} · tokens {human(me.get('tokens'))}"
               f" · {f'{r:.1f} tok/s' if r is not None else '– tok/s'} · active {me.get('active_requests', 0)}"
               f"{' · busy' if me.get('busy') else ''}")
    net = snap.get("network") or {}
    if net.get("joined"):
        out.append(f"  network: node {net.get('node')} on {net.get('network')}")
        if net.get("agent_last"):
            out.append(f"    agent: {net['agent_last'][:width - 11]}")
    else:
        out.append(f"  network: not joined ({CMD} join)")
    out.append("")

    out.append("MODELS")
    bar_w = max(16, min(48, width - 60))
    for m in snap.get("models") or []:
        state = {"available": f"available ×{m.get('redundancy', 0)}",
                 "partial": "missing " + ", ".join(f"{a}–{b - 1}" for a, b in m.get("gaps") or []),
                 "offline": "offline"}.get(m["state"], m["state"])
        out.append(f"  {short(m['model'])[:28]:<28} |{cov_bar(m.get('coverage') or [], bar_w, ascii_only)}|"
                   f" {m['n_layers']:>3}  {state}")
        if m.get("route"):
            out.append("    route " + " → ".join(f"{n} {lo}–{hi - 1}" for n, lo, hi in m["route"]))
    if not snap.get("models"):
        out.append("  none yet")
    out.append("")

    out.append("PEERS")
    if snap["peers"]:
        out.append(f"  {'name':<16} {'chip':<22} {'mem':>5}  {'link':<9} {'rtt':>6}  {'tok/s':>6}  serving")
    order = {"direct": 0, "relay": 1}
    for p in sorted(snap["peers"], key=lambda p: (order.get(p["state"], 2), p["name"])):
        rtt = f"{p['rtt_ms']:.0f}ms" if p.get("rtt_ms") is not None else "–"
        r = tok_s.get(p["peer_id"])
        mem = f"{p['mem_total_gb']:.0f}" if p.get("mem_total_gb") else "–"
        line = (f"  {p['name'][:16]:<16} {(p.get('chip') or '?')[:22]:<22} {mem:>5}  "
                f"{p['state'][:9]:<9} {rtt:>6}  {f'{r:.1f}' if r is not None else '–':>6}  {fmt_slices(p['slices'])}")
        out.append(line[:width])
    if not snap["peers"]:
        out.append("  no other peers online")
    return [line[:width] for line in out]


# ---- commands ----

def run_status(a) -> int:
    snap = snapshot(a.port)
    if a.json:
        print(json.dumps(snap, indent=2))
    else:
        print("\n".join(render(snap, width=shutil.get_terminal_size((100, 40)).columns, ascii_only=not _utf8())))
    return 0


def run_top(a) -> int:
    if not sys.stdout.isatty():
        return run_status(a)
    prev = None
    sys.stdout.write("\x1b[?25l")   # hide the cursor
    try:
        while True:
            snap = snapshot(a.port)
            cols, rows = shutil.get_terminal_size((100, 40))
            lines = render(snap, prev, cols, ascii_only=not _utf8())
            foot = f"updated {time.strftime('%H:%M:%S')} · every {a.interval:g}s · Ctrl-C to quit"
            body = lines[:max(rows - 2, 5)] + ["", foot[:cols]]
            sys.stdout.write("\x1b[H\x1b[2J" + "\n".join(body))
            sys.stdout.flush()
            prev = snap
            time.sleep(a.interval)
    except KeyboardInterrupt:
        return 0
    finally:
        sys.stdout.write("\x1b[?25h\n")
        sys.stdout.flush()


def _utf8() -> bool:
    return "utf" in (sys.stdout.encoding or "").lower()


def add_parsers(sub):
    from .cli import DEFAULT_PORT
    t = sub.add_parser("top", help="live view of this machine and the swarm (refreshes until Ctrl-C)")
    t.add_argument("--interval", type=float, default=2.0, help="seconds between refreshes (default 2)")
    t.add_argument("--port", type=int, default=DEFAULT_PORT)
    t.add_argument("--json", action="store_true", help=argparse.SUPPRESS)   # used when stdout is not a terminal
    s = sub.add_parser("status", help="this machine and the swarm, once (--json for scripts)")
    s.add_argument("--json", action="store_true", help="print the raw snapshot as JSON")
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
