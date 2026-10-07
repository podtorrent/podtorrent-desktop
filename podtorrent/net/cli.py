"""`podtorrent swarm`: join the registry as an observer, punch through to every peer and print who is online."""
import asyncio

from ..common import CHIP
from .identity import load_identity
from .quic import PeerNet
from .rendezvous import SwarmClient

LINK = {"direct": "direct", "connecting": "connecting…", "unreachable": "UNREACHABLE"}


def fmt_link(l: dict | None) -> str:
    if not l:
        return "—"
    s = LINK.get(l["state"], l["state"])
    if l["state"] == "direct":
        s += f" via {l['via']} {l['addr']}" + (f"  rtt {l['rtt_ms']:.1f} ms" if l.get("rtt_ms") is not None else "")
    elif l.get("error"):
        s += f" ({l['error']})"
    return s


def fmt_peer(p: dict, me: str) -> str:
    slices = ", ".join(f"{s['model'].split('/')[-1]} [{s['lo']},{s['hi']})" for s in p.get("slices", [])) or "nothing"
    eps = " ".join(e["ip"] + (f":{e['port']}" if e.get("port") else "") for e in p.get("endpoints", []))
    if p["peer_id"] == me:
        return f"  {p.get('name', '?')} (you)  {p.get('chip', '')}  serves {slices}  ·  {eps}"
    return f"  {p.get('name', '?')}  {p.get('chip', '')}  serves {slices}  ·  {eps}\n      link: {fmt_link(p.get('link'))}"


def run_swarm(name: str, watch: bool, wait_s: float = 8):
    ident = load_identity()

    async def main():
        net = await PeerNet(ident).start()
        last = ""
        online = asyncio.Event()

        def on_peers(peers, status):
            nonlocal last
            if status != "online" or not peers:
                return
            online.set()
            # Print when membership or link states change, not on every RTT sample.
            key = repr(sorted((p["peer_id"], (p.get("link") or {}).get("state")) for p in peers))
            if key == last:
                return
            last = key
            print(f"{len(peers)} peer(s) online:", flush=True)
            for p in sorted(peers, key=lambda p: p.get("name", "")):
                print(fmt_peer(p, ident.peer_id), flush=True)

        client = SwarmClient(ident, lambda: {"name": name, "chip": CHIP, "role": "observer", "slices": []},
                             on_peers, net=net)
        task = asyncio.create_task(client.run())
        if watch:
            while True:  # also print RTTs every 10 s
                await asyncio.sleep(10)
                for p in client.peers:
                    if p["peer_id"] != ident.peer_id:
                        print(f"  {p.get('name', '?')}: {fmt_link(net.snapshot().get(p['peer_id']))}", flush=True)
        try:
            await asyncio.wait_for(online.wait(), 15)
        except asyncio.TimeoutError:
            print(f"no answer from {client.url} ({client.status})")
            return
        await asyncio.sleep(wait_s)  # give hole punching a chance
        print("final:", flush=True)
        for p in client.peers:
            if p["peer_id"] != ident.peer_id:
                print(f"  {p.get('name', '?')}: {fmt_link(net.snapshot().get(p['peer_id']))}", flush=True)
        task.cancel()

    asyncio.run(main())
