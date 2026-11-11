"""`podtorrent pod ...`: make and edit this machine's pod by hand, until invites land in the app.

Edits ~/.podtorrent/pod.json; a running peer picks the change up within a few seconds. Rosters move
between machines as files: `pod export > home.json` on the owner, `pod import home.json` on the member."""
import json
import os
import platform
import sys
from pathlib import Path

from . import pod
from .net.identity import load_identity


def machine_name() -> str:
    try:
        name = json.loads((pod.roster_path().parent / "config.json").read_text()).get("name")
    except (OSError, ValueError):
        name = None
    return os.environ.get("PODTORRENT_NAME") or name or platform.node().split(".")[0]


def _current() -> dict:
    r = pod.load_roster()
    if r is None:
        raise SystemExit("this machine is in no pod: `podtorrent pod new NAME`, or `podtorrent pod import FILE`")
    return r


def _owned() -> tuple[dict, object]:
    r, me = _current(), load_identity()
    if pod.owner_id(r) != me.peer_id:
        raise SystemExit("only the pod's owner can change it")
    return r, me


def _peer(r: dict, who: str) -> str:
    hits = [m["peer_id"] for m in r["members"] if who in (m["peer_id"], m["name"])]
    if len(hits) != 1:
        raise SystemExit(f"{who!r} is {'not a member' if not hits else 'ambiguous'}")
    return hits[0]


def _save(r: dict) -> dict:
    try:
        pod.verify(r)
    except pod.RosterError as e:
        raise SystemExit(f"not saved: {e}")
    pod.save_roster(r)
    return r


def show(r: dict | None):
    me = load_identity()
    print(f"this machine: {machine_name()}  peer_id {me.peer_id}  pubkey {me.public.hex()}")
    if r is None:
        print("pod: none (public swarm)")
        return
    names = {m["peer_id"]: m["name"] for m in r["members"]}
    owner = pod.owner_id(r)
    print(f"pod: {r['name']} ({r['kind']}) v{r['version']}  id {r['pod_id']}")
    for m in r["members"]:
        tags = [t for t, on in (("owner", m["peer_id"] == owner), ("you", m["peer_id"] == me.peer_id),
                                ("public", m.get("public"))) if on]
        print(f"  {m['name']:<20} {m['peer_id']}" + (f"  ({', '.join(tags)})" if tags else ""))
    for p in r["plans"]:
        hops = " → ".join(f"{names[h['peer']]} [{h['lo']},{h['hi']})" for h in p["hops"])
        print(f"  plan {p['model']} ({p['layers']} layers), head {names[p['head']]}: {hops}")


def run(a):
    me = load_identity()
    if a.pod_cmd == "show":
        show(pod.load_roster())
    elif a.pod_cmd == "new":
        if pod.load_roster() and not a.force:
            raise SystemExit("this machine is already in a pod: `podtorrent pod leave` first, or pass --force")
        show(_save(pod.new_pod(me, a.name, machine_name(), kind="alone" if a.alone else "private")))
    elif a.pod_cmd == "add":
        r, me = _owned()
        show(_save(pod.sign(pod.add_member(r, pod.member(a.pubkey, a.name, public=a.public)), me)))
    elif a.pod_cmd == "remove":
        r, me = _owned()
        pid = _peer(r, a.machine)
        if pid == me.peer_id:
            raise SystemExit("the owner can't remove itself: `podtorrent pod leave` drops the pod on this machine")
        show(_save(pod.sign(pod.remove_member(r, pid), me)))
    elif a.pod_cmd == "plan":
        r, me = _owned()
        hops = []
        for spec in a.hops:
            who, _, rng = spec.rpartition(":")
            who, lo = who.rsplit(":", 1) if who.count(":") else (who, None)
            if lo is None:
                raise SystemExit(f"expected MACHINE:LO:HI, got {spec!r}")
            hops.append((_peer(r, who), int(lo), int(rng)))
        head = _peer(r, a.head) if a.head else hops[0][0]
        show(_save(pod.sign(pod.set_plan(r, a.model, a.layers, head, hops), me)))
    elif a.pod_cmd == "export":
        json.dump(_current(), sys.stdout, indent=2, sort_keys=True)
        print()
    elif a.pod_cmd == "import":
        incoming = json.loads(Path(a.file).read_text())
        try:
            pod.verify(incoming)
        except pod.RosterError as e:
            raise SystemExit(f"not a valid pod roster: {e}")
        if not pod.is_member(incoming, me.peer_id):
            raise SystemExit("this machine isn't a member of that pod: the owner must `podtorrent pod add` it first")
        cur = pod.load_roster()
        if cur and cur["pod_id"] == incoming["pod_id"] and incoming["version"] <= cur["version"]:
            raise SystemExit(f"already have version {cur['version']} of this pod")
        show(_save(incoming))
    elif a.pod_cmd == "leave":
        pod.roster_path().unlink(missing_ok=True)
        print("left the pod: this machine is back in the public swarm")


def add_parser(sub):
    p = sub.add_parser("pod", help="this machine's pod: the machines it serves with (see docs/PODS_PLAN.md)")
    ps = p.add_subparsers(dest="pod_cmd", required=True)
    ps.add_parser("show", help="this machine's id and pod")
    n = ps.add_parser("new", help="start a pod with this machine as owner")
    n.add_argument("name")
    n.add_argument("--alone", action="store_true", help="a pod of one: serve whole models by itself")
    n.add_argument("--force", action="store_true", help="replace the current pod")
    ad = ps.add_parser("add", help="owner: add a machine by its pubkey (from `pod show` on it)")
    ad.add_argument("pubkey")
    ad.add_argument("name")
    ad.add_argument("--public", action="store_true", help="a public machine filling a gap")
    rm = ps.add_parser("remove", help="owner: remove a machine (name or peer_id)")
    rm.add_argument("machine")
    pl = ps.add_parser("plan", help="owner: split a model's layers, e.g. plan MODEL 48 studio:0:24 air:24:48")
    pl.add_argument("model")
    pl.add_argument("layers", type=int)
    pl.add_argument("hops", nargs="+", metavar="MACHINE:LO:HI")
    pl.add_argument("--head", help="the machine that serves this model on the network (default: the first hop's)")
    ps.add_parser("export", help="print the roster, to copy to the other machines")
    im = ps.add_parser("import", help="install a roster exported by the owner")
    im.add_argument("file")
    ps.add_parser("leave", help="forget the pod on this machine")
