"""`podtorrent setup`: pick a model and a layer slice for this machine, then download and load it.

Runs against the local peer's API (it must be running): the swarm's models and their coverage come from
/api/models, a slice sized to this machine's free GPU memory that fills the swarm's gaps from
/api/catalog/info, and the download and load from /api/serve. The headless launcher's `setup` command
starts the peer and then runs this. Everything here is also scriptable: --model, --serve, --yes.
"""
from __future__ import annotations

import sys
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

GB = 1 << 30


# ---- choosing (pure, tested in tests/test_setup_cli.py) ----

def rank(models: list[dict], infos: dict[str, dict], mine: list[dict]) -> list[dict]:
    """The swarm's models as choices, most useful first: filling missing layers, then adding a second
    copy where only one exists, then more copies, then starting a model nobody serves. Models this
    machine can't fit a layer of go last. Each choice carries the suggested slice from the peer."""
    out = []
    for m in models:
        inf = infos.get(m["model"]) or {}
        sug = inf.get("suggest") or {}
        fits = sug.get("hi", 0) > sug.get("lo", 0)
        serving = [[s["lo"], s["hi"]] for s in mine if s.get("model") == m["model"]]
        if m["state"] == "offline":
            tier, why = 3, "nobody serves it"
        elif m["state"] == "partial":
            tier, why = 0, "missing " + ", ".join(f"{a}–{b - 1}" for a, b in m["gaps"])
        elif m.get("redundancy", 0) <= 1:
            tier, why = 1, "one copy only"
        else:
            tier, why = 2, f"{m['redundancy']} copies"
        if not inf:
            tier, why = tier + 10, why + "; size unknown"
        elif unsupported(inf):
            tier, why, fits = tier + 30, unsupported(inf), False
        elif not fits:
            tier, why = tier + 20, "doesn't fit in free GPU memory"
        out.append({"model": m["model"], "n_layers": m["n_layers"], "state": m["state"], "why": why,
                    "peers": m.get("peers", []), "serving": serving, "fits": fits and bool(inf),
                    "suggest": sug, "info": inf, "tier": tier})
    out.sort(key=lambda c: (c["tier"], -len(c["peers"]), c["model"]))
    return out


def unsupported(info: dict) -> str | None:
    """Why this engine can't run the model, or None. Peers that don't say are trusted."""
    if info.get("supported") is False:
        runs = ", ".join(info.get("supported_types") or []) or "other models"
        return f"can't run here: it's a {info.get('model_type') or 'different'} model (PodTorrent runs {runs})"
    return None


def slice_gb(info: dict, lo: int, hi: int) -> float | None:
    lb = info.get("layer_bytes") or 0
    return lb * (hi - lo) / GB if lb else None


def check_slice(info: dict, lo: int, hi: int) -> str | None:
    """Why [lo, hi) can't be served here, or None when it can."""
    n = info.get("n_layers") or 0
    if not (0 <= lo < hi <= n):
        return f"layers must be within 0:{n} with LO < HI"
    need, room = slice_gb(info, lo, hi), info.get("room_gb")
    if need is not None and room is not None and need > room:
        return f"layers {lo}–{hi - 1} need about {need:.1f} GB; {room:.1f} GB is free for models here"
    return None


def parse_range(text: str) -> tuple[int, int] | None:
    """"0:24" or "0-23" (inclusive end, the way layers are shown) -> (lo, hi)."""
    t = text.strip().replace(" ", "")
    try:
        if ":" in t:
            a, b = t.split(":", 1)
            return int(a), int(b)
        if "-" in t:
            a, b = t.split("-", 1)
            return int(a), int(b) + 1
    except ValueError:
        return None
    return None


def bar(done: int, total: int, width: int = 24) -> str:
    if total <= 0:
        return "[" + " " * width + "]"
    k = min(width, int(width * done / total))
    return "[" + "#" * k + " " * (width - k) + f"] {100 * done // total:3d}%"


# ---- talking to the peer ----

def _api(path: str, body: dict | None, port: int) -> dict:
    from .cli import local_api
    return local_api(path, body, port)


def _infos(models: list[str], port: int) -> dict[str, dict]:
    def one(m):
        r = _api("/api/catalog/info?repo=" + urllib.parse.quote(m, safe="/"), None, port)
        return m, ({} if "error" in r else r)
    with ThreadPoolExecutor(max_workers=4) as ex:
        return dict(ex.map(one, models))


def _ask(prompt: str, default: str, yes: bool) -> str:
    if yes:
        print(f"{prompt} {default}")
        return default
    try:
        a = input(f"{prompt} [{default}] ").strip()
    except EOFError:
        a = ""
    return a or default


def _serve(model: str, lo: int, hi: int, port: int) -> str | None:
    """Download and load [lo, hi) of `model`, showing progress. The error, or None."""
    result: dict = {}
    t = threading.Thread(target=lambda: result.update(
        _api("/api/serve", {"model": model, "lo": lo, "hi": hi, "wait": True}, port)), daemon=True)
    t.start()
    tty, last = sys.stdout.isatty(), ""
    while t.is_alive():
        t.join(1.0)
        st = _api("/status", None, port)
        rec = next((s for s in st.get("slices", [])
                    if (s.get("model"), s.get("lo"), s.get("hi")) == (model, lo, hi)), None)
        if not rec:
            continue
        phase = rec.get("phase", "")
        line = f"  {phase:<11} {bar(rec.get('done', 0), rec.get('total', 0))}"
        if tty:
            print("\r" + line.ljust(60), end="", flush=True)
        elif phase != last:
            print(line, flush=True)
        last = phase
    if tty:
        print()
    return result.get("error")


# ---- the wizard ----

def run(a) -> int:
    port, yes = a.port, a.yes
    if not yes and not sys.stdin.isatty():
        raise SystemExit("setup asks questions; for a non-interactive run pass --yes (and --model / --serve)")

    print("Looking at the swarm…")
    r = _api("/api/models", None, port)
    models, mine = r.get("models", []), r.get("slices", [])
    names = [m["model"] for m in models]
    if a.model and a.model not in names:
        if "/" not in a.model:
            raise SystemExit(f"--model expects a Hugging Face repo like owner/name, got {a.model!r}")
        names.append(a.model)
    infos = _infos(names, port)
    known = {m["model"] for m in models}
    extra = [{"model": n, "n_layers": infos.get(n, {}).get("n_layers", 0), "state": "offline", "gaps": [],
              "redundancy": 0, "peers": []} for n in names if n not in known]
    choices = rank(models + extra, infos, mine)
    if not choices:
        raise SystemExit("no models found: is this machine online? check `podtorrent swarm`")

    print(f"\nThis machine has about {r.get('mem_free_gb', '?')} GB free for models.\n")
    print("   model                                      layers  peers  status")
    for i, c in enumerate(choices, 1):
        here = "  (serving here)" if c["serving"] else ""
        flag = "" if c["fits"] else "  ✗"
        print(f"{i:>2}. {c['model'][:42]:<42} {c['n_layers']:>6}  {len(c['peers']):>5}  {c['why']}{here}{flag}")

    if a.model:
        choice = next(c for c in choices if c["model"] == a.model)
    else:
        default = next((i for i, c in enumerate(choices, 1) if c["fits"]), 1)
        while True:
            pick = _ask("\nWhich model? Enter a number or a Hugging Face repo (owner/name):", str(default), yes)
            if pick.isdigit() and 1 <= int(pick) <= len(choices):
                choice = choices[int(pick) - 1]
                break
            if "/" in pick:
                a.model = pick
                return run(a)
            print("  pick a number from the list, or type owner/name")

    info, sug = choice["info"], choice["suggest"]
    if not info:
        raise SystemExit(f"couldn't read {choice['model']} from Hugging Face; check the name and the network")
    if unsupported(info):
        raise SystemExit(f"{choice['model']} {unsupported(info)}; pick another model")
    n = info["n_layers"]
    print(f"\n{choice['model']}: {n} layers, about {info.get('size_bytes', 0) / GB:.1f} GB in all; "
          f"{info.get('room_gb', 0):.1f} GB of room here.")
    if choice["serving"]:
        print("  already serving here: " + ", ".join(f"{lo}–{hi - 1}" for lo, hi in choice["serving"]))

    if a.serve:
        lo, hi = a.serve
    elif sug.get("hi", 0) > sug.get("lo", 0):
        lo, hi = sug["lo"], sug["hi"]
        need = slice_gb(info, lo, hi)
        print(f"  suggested: layers {lo}–{hi - 1} ({hi - lo} of {n}"
              f"{f', about {need:.1f} GB' if need is not None else ''}): {sug.get('reason', '')}")
        while not yes:
            t = _ask("  Press Enter to accept, or type a range like 0:24 or 0-23:", f"{lo}:{hi}", False)
            rng = parse_range(t)
            err = "type a range like 0:24" if rng is None else check_slice(info, *rng)
            if err:
                print("  " + err)
                continue
            lo, hi = rng
            break
    else:
        raise SystemExit(f"  {sug.get('reason') or 'no room for a layer of this model'}; "
                         "free memory or pick a smaller model")

    err = check_slice(info, lo, hi)
    if err:
        raise SystemExit(err)
    if any(s_lo <= lo and hi <= s_hi for s_lo, s_hi in choice["serving"]):
        print(f"\nAlready serving layers {lo}–{hi - 1} of {choice['model']}; nothing to do.")
        return 0

    print(f"\nDownloading and loading layers {lo}–{hi - 1} of {choice['model']}…")
    err = _serve(choice["model"], lo, hi, port)
    if err:
        print(f"failed: {err}", file=sys.stderr)
        return 1
    print(f"Serving layers {lo}–{hi - 1} of {choice['model']}. "
          "The peer keeps serving them after a restart.")
    return 0


def add_parser(sub):
    from .cli import DEFAULT_PORT
    p = sub.add_parser("setup", help="pick a model and layers for this machine, then download and serve them")
    p.add_argument("--model", help="Hugging Face repo to serve (default: the swarm's most useful one that fits)")
    p.add_argument("--serve", type=_lo_hi, metavar="LO:HI", help="layers to serve (default: the suggested slice)")
    p.add_argument("--yes", action="store_true", help="accept the defaults without asking")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)


def _lo_hi(s: str) -> tuple[int, int]:
    import argparse
    r = parse_range(s)
    if r is None:
        raise argparse.ArgumentTypeError(f"expected LO:HI, got {s!r}")
    return r
