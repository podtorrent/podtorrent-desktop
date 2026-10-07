"""Client for the global rendezvous registry (rendezvous/ in this repo, a Cloudflare Worker).

Keeps one WebSocket open, publishes this peer's record, and reports every online peer."""
import asyncio
import json
import os
import re
import subprocess
import time
from typing import Callable

import aiohttp

from . import stun
from .identity import Identity

# Override with PODTORRENT_RENDEZVOUS, e.g. ws://localhost:8787 for `wrangler dev`.
DEFAULT_URL = "wss://podtorrent-rendezvous.workers.dev"
PING_S = 10
STUN_REFRESH_S = 120


def rendezvous_url() -> str:
    return os.environ.get("PODTORRENT_RENDEZVOUS", DEFAULT_URL).rstrip("/")


def lan_addresses() -> list[str]:
    """Private IPv4 addresses on this Mac, for peers behind the same router."""
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
    except Exception:  # noqa: BLE001
        return []
    ips = re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", out)
    # 100.64/10 is carrier-grade NAT or a VPN overlay, never a LAN another peer could reach.
    return [i for i in ips if not i.startswith(("127.", "169.254."))
            and not (i.startswith("100.") and 64 <= int(i.split(".")[1]) <= 127)]


class SwarmClient:
    """`record()` returns this peer's current public facts (name, chip, memory, slices...).
    `on_peers(list, status)` runs on every registry change and connection change."""

    def __init__(self, ident: Identity, record: Callable[[], dict],
                 on_peers: Callable[[list[dict], str], None], url: str | None = None):
        self.ident, self.record, self.on_peers = ident, record, on_peers
        self.url = url or rendezvous_url()
        self.status = "connecting"   # connecting | online | offline
        self.peers: list[dict] = []
        self.public: tuple[str, int] | None = None
        self.observed_ip = ""
        self._stun_ts = 0.0
        self._sent = ""

    def _set(self, status=None, peers=None):
        if status:
            self.status = status
        if peers is not None:
            self.peers = peers
        self.on_peers(self.peers, self.status)

    async def _endpoints(self) -> list[dict]:
        if time.time() - self._stun_ts > STUN_REFRESH_S:
            self.public = await asyncio.to_thread(stun.public_endpoint)
            self._stun_ts = time.time()
        eps = [{"kind": "lan", "ip": ip} for ip in lan_addresses()]
        if self.public:
            eps.insert(0, {"kind": "stun", "ip": self.public[0], "port": self.public[1]})
        return eps

    async def _full_record(self) -> dict:
        return {**self.record(), "endpoints": await self._endpoints(), "protocol": 1}

    async def run(self):
        backoff = 1
        while True:
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.ws_connect(f"{self.url}/v1/swarm?peer_id={self.ident.peer_id}",
                                               heartbeat=None, timeout=aiohttp.ClientWSTimeout(ws_close=5)) as ws:
                        backoff = 1
                        rec = await self._full_record()
                        self._sent = json.dumps(rec, sort_keys=True)
                        await ws.send_str(json.dumps({"type": "hello", "peer": rec}))
                        await self._session(ws)
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
                print(f"rendezvous {self.url}: {e}", flush=True)
            self._set("offline", [])
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
            self._set("connecting")

    async def _session(self, ws: aiohttp.ClientWebSocketResponse):
        async def pinger():
            n = 0
            while True:
                await asyncio.sleep(PING_S)
                await ws.send_str("ping")
                n += 1
                if n % 2 == 0:  # every other ping, and only if something changed
                    rec = await self._full_record()
                    blob = json.dumps(rec, sort_keys=True)
                    if blob != self._sent:
                        self._sent = blob
                        await ws.send_str(json.dumps({"type": "update", "peer": rec}))

        task = asyncio.create_task(pinger())
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT or msg.data == "pong":
                    continue
                ev = json.loads(msg.data)
                if ev.get("type") == "welcome":
                    self.observed_ip = ev.get("observed_ip", "")
                    self._set("online")
                elif ev.get("type") == "peers":
                    self._set(peers=ev.get("peers") or [])
                # "punch" / "punch_ack" arrive here too; handled from phase 2.
        finally:
            task.cancel()
