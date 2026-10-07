"""`podtorrent swarm`: join the registry as an observer and print who is online."""
import asyncio

from ..worker import CHIP
from .identity import load_identity
from .rendezvous import SwarmClient


def fmt_peer(p: dict, me: str) -> str:
    slices = ", ".join(f"{s['model'].split('/')[-1]} [{s['lo']},{s['hi']})" for s in p.get("slices", [])) or "nothing"
    eps = " ".join(e["ip"] + (f":{e['port']}" if e.get("port") else "") for e in p.get("endpoints", []))
    you = " (you)" if p["peer_id"] == me else ""
    return f"  {p.get('name', '?')}{you}  {p.get('chip', '')}  serves {slices}  ·  {eps}"


def run_swarm(name: str, watch: bool):
    ident = load_identity()

    async def main():
        done = asyncio.Event()

        def on_peers(peers, status):
            if status != "online" or not peers:
                return
            print(f"{len(peers)} peer(s) online:", flush=True)
            for p in sorted(peers, key=lambda p: p.get("name", "")):
                print(fmt_peer(p, ident.peer_id), flush=True)
            done.set()

        client = SwarmClient(ident, lambda: {"name": name, "chip": CHIP, "role": "observer", "slices": []}, on_peers)
        task = asyncio.create_task(client.run())
        if watch:
            await task
        try:
            await asyncio.wait_for(done.wait(), 15)
        except asyncio.TimeoutError:
            print(f"no answer from {client.url} ({client.status})")
        task.cancel()

    asyncio.run(main())
