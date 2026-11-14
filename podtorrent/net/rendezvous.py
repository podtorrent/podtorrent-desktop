"""Client for the rendezvous (rendezvous/ in this repo, a Cloudflare Worker).

Keeps one WebSocket open, publishes this peer's record, and reports every online peer. A machine in
a pod uses that pod's room, proving its key and exchanging the pod's signed roster there. A machine in
no pod waits in the matchmaker's public lobby, offering what it can serve, until the matchmaker puts it
in a public pod (docs/PODS_PLAN.md). A rendezvous without the lobby (before the matchmaker deploy) gets the
global swarm room instead."""
import asyncio
import base64
import json
import re
import ssl
import subprocess
import time
from typing import TYPE_CHECKING, Callable

import aiohttp
import certifi

from .. import endpoints
from . import stun
from .identity import Identity

if TYPE_CHECKING:
    from .quic import PeerNet

PING_S = 10
STUN_REFRESH_S = 120
OWNER_RETRY_S = 3  # a join request that found the owner offline is sent again after this long...
OWNER_WAIT_S = 12  # ...until this long has passed
# python.org builds ship without system CAs; certifi's bundle works everywhere.
SSL_CTX = ssl.create_default_context(cafile=certifi.where())


def rendezvous_url() -> str:
    """This build's rendezvous (podtorrent/endpoints.py), or "" when it has none."""
    return endpoints.rendezvous()


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
    `on_peers(list, status)` runs on every registry change and connection change.
    With a `net`, STUN runs on its QUIC socket, punch signals reach it, and each peer gets a `link`.
    `room()` returns this machine's pod roster, or None for the public swarm; `reconnect()` after it
    changes pods. In a pod room, `on_roster(roster)` gets every roster the room sends (unchecked) and
    `on_owner_request(msg)` every join or leave request relayed to this machine (as the owner).
    In the lobby, `supply()` is what this machine offers the matchmaker, the roster of an assignment
    goes to `on_roster`, and `on_dissolved()` runs when the matchmaker gives up on its public pod."""

    def __init__(self, ident: Identity, record: Callable[[], dict],
                 on_peers: Callable[[list[dict], str], None], url: str | None = None, net: "PeerNet | None" = None,
                 room: Callable[[], dict | None] = lambda: None, on_roster: Callable[[dict], None] = lambda r: None,
                 on_owner_request: Callable[[dict], None] = lambda m: None,
                 supply: Callable[[], dict] | None = None, on_dissolved: Callable[[], None] = lambda: None):
        self.ident, self.record, self.on_peers, self.net = ident, record, on_peers, net
        self.room, self.on_roster, self.on_owner_request = room, on_roster, on_owner_request
        self.supply, self.on_dissolved = supply, on_dissolved
        self.legacy = supply is None   # the global swarm room instead of the lobby
        self.in_lobby = False
        self.url = url or rendezvous_url()
        self.status = "connecting"   # connecting | online | offline
        self.peers: list[dict] = []
        self.public: tuple[str, int] | None = None
        self.observed_ip = ""
        self._stun_ts = 0.0
        self._sent = ""
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        if net:
            net.signal = self._signal
            net.on_change = lambda: self._set()

    async def _signal(self, msg: dict):
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_str(json.dumps(msg))
        elif msg.get("type") == "relay":
            pass   # a lost packet: QUIC retransmits once the rendezvous is back
        elif self.net:
            self.net.on_signal({"type": "punch_failed", "to": msg.get("to"), "reason": "unreachable: rendezvous offline"})

    def _set(self, status=None, peers=None):
        if status:
            self.status = status
        if peers is not None:
            self.peers = peers
            if self.net:
                self.net.on_peers(peers)
        if self.net:
            links = self.net.snapshot()
            self.on_peers([{**p, "link": links.get(p["peer_id"])} for p in self.peers], self.status)
        else:
            self.on_peers(self.peers, self.status)

    async def _endpoints(self) -> list[dict]:
        if time.time() - self._stun_ts > STUN_REFRESH_S:
            self.public = await (self.net.stun() if self.net else asyncio.to_thread(stun.public_endpoint))
            self._stun_ts = time.time()
        port = {"port": self.net.port} if self.net else {}
        eps = [{"kind": "lan", "ip": ip, **port} for ip in lan_addresses()]
        if self.public:
            eps.insert(0, {"kind": "stun", "ip": self.public[0], "port": self.public[1]})
        return eps

    async def _full_record(self) -> dict:
        return {**self.record(), "endpoints": await self._endpoints(), "protocol": 2 if self.net else 1}

    def _supply_msg(self) -> str:
        return json.dumps({"type": "supply", "supply": self.supply()}, sort_keys=True)

    async def send(self, msg: dict) -> bool:
        if self._ws is None or self._ws.closed:
            return False
        await self._ws.send_str(json.dumps(msg))
        return True

    async def reconnect(self):
        """Leave the current room (this machine changed pods); `run` joins the right one."""
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()

    async def run(self):
        if not self.url:
            print("no rendezvous configured (podtorrent/endpoints.json or PODTORRENT_RENDEZVOUS): "
                  "running alone, with no swarm", flush=True)
            self._set("offline", [])
            return
        backoff = 1
        while True:
            roster = self.room()
            lobby = not roster and not self.legacy
            url = (f"{self.url}/v1/pod/{roster['pod_id']}" if roster else f"{self.url}/v1/public" if lobby
                   else f"{self.url}/v1/swarm?peer_id={self.ident.peer_id}")
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.ws_connect(url, ssl=SSL_CTX, heartbeat=None,
                                               timeout=aiohttp.ClientWSTimeout(ws_close=5)) as ws:
                        backoff = 1
                        self._ws = ws
                        self.in_lobby = lobby
                        if roster:
                            welcome = await room_auth(ws, self.ident, roster["pod_id"], roster)
                            self._room_welcome(welcome)
                        if lobby:
                            # Linked to nobody until the matchmaker assigns a pod.
                            welcome = await room_auth(ws, self.ident, "public")
                            self.observed_ip = welcome.get("observed_ip", "")
                            self._set("online", [])
                            self._sent = self._supply_msg()
                            await ws.send_str(self._sent)
                        else:
                            rec = await self._full_record()
                            self._sent = json.dumps(rec, sort_keys=True)
                            await ws.send_str(json.dumps({"type": "hello", "peer": rec}))
                        await self._session(ws)
            except aiohttp.WSServerHandshakeError as e:
                if lobby and e.status == 404:
                    print("rendezvous has no public lobby yet: using the global swarm room", flush=True)
                    self.legacy = True
                    continue
                print(f"rendezvous {url.split('?')[0]}: {e}", flush=True)
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError, RoomError) as e:
                print(f"rendezvous {url.split('?')[0]}: {e}", flush=True)
            self._ws = None
            self.in_lobby = False
            if self.room() != roster:   # assigned to, or dropped from, a pod: go to the right room now
                continue
            # Keep the last peer list: direct QUIC links don't need the rendezvous, and heartbeats drop dead ones.
            self._set("offline")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
            self._set("connecting")

    def _room_welcome(self, welcome: dict):
        self.observed_ip = welcome.get("observed_ip", "")
        self._set("online")
        if isinstance(welcome.get("roster"), dict):
            self.on_roster(welcome["roster"])

    async def publish(self):
        """Send this peer's record now if it changed (e.g. a slice finished loading)."""
        if self._ws is None or self._ws.closed:
            return
        if self.in_lobby:
            blob = self._supply_msg()
            if blob != self._sent:
                self._sent = blob
                await self._ws.send_str(blob)
            return
        rec = await self._full_record()
        blob = json.dumps(rec, sort_keys=True)
        if blob != self._sent:
            self._sent = blob
            await self._ws.send_str(json.dumps({"type": "update", "peer": rec}))

    async def _session(self, ws: aiohttp.ClientWebSocketResponse):
        async def pinger():
            n = 0
            while True:
                await asyncio.sleep(PING_S)
                await ws.send_str("ping")
                n += 1
                if n % 2 == 0 and self.in_lobby:
                    await self.publish()
                elif n % 2 == 0:  # every other ping, and only if something changed
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
                elif ev.get("type") in ("punch", "punch_ack", "punch_failed") and self.net:
                    self.net.on_signal(ev)
                elif ev.get("type") == "relay" and self.net:
                    try:
                        self.net.relay_in(str(ev.get("from", "")), base64.b64decode(ev.get("data", "")))
                    except ValueError:
                        pass
                elif ev.get("type") in ("roster", "assign") and isinstance(ev.get("roster"), dict):
                    self.on_roster(ev["roster"])
                elif ev.get("type") == "dissolved":
                    self.on_dissolved()
                elif ev.get("type") in ("join_request", "leave_request"):
                    self.on_owner_request(ev)
        finally:
            task.cancel()


# ---- pod rooms ----

class RoomError(Exception):
    pass


async def _next_event(ws: aiohttp.ClientWebSocketResponse, timeout: float) -> dict:
    while True:
        msg = await asyncio.wait_for(ws.receive(), timeout)
        if msg.type == aiohttp.WSMsgType.TEXT and msg.data != "pong":
            return json.loads(msg.data)
        if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
            raise RoomError(f"the room closed the connection ({ws.close_code}: {msg.extra or 'no reason'})")


async def room_auth(ws: aiohttp.ClientWebSocketResponse, ident: Identity, pod_id: str,
                    roster: dict | None = None, timeout: float = 15) -> dict:
    """Answer a pod room's challenge with this machine's key (and offer `roster`); returns the welcome."""
    ev = await _next_event(ws, timeout)
    if ev.get("type") != "challenge":
        raise RoomError(f"expected a challenge, got {ev.get('type')!r}")
    sig = ident.key.sign(f"podtorrent-room|{pod_id}|{ev['nonce']}".encode()).hex()
    auth = {"type": "auth", "pubkey": ident.public.hex(), "sig": sig}
    if roster:
        auth["roster"] = roster
    await ws.send_str(json.dumps(auth))
    while True:
        ev = await _next_event(ws, timeout)
        if ev.get("type") == "welcome":
            return ev


async def join_pod(ident: Identity, pod_id: str, proof: str, name: str, url: str | None = None,
                   timeout: float = 45) -> dict:
    """Ask a pod's owner (through the pod's room) to add this machine. Returns the first roster the
    room sends that lists this machine; raises RoomError when the owner refuses or doesn't answer.
    The caller verifies the roster."""
    base = url or rendezvous_url()
    if not base:
        raise RoomError("no rendezvous configured (podtorrent/endpoints.json or PODTORRENT_RENDEZVOUS)")
    url = base + f"/v1/pod/{pod_id}"
    deadline = time.time() + timeout
    give_up = time.time() + OWNER_WAIT_S

    def lists_me(r) -> bool:
        return isinstance(r, dict) and any(m.get("peer_id") == ident.peer_id for m in r.get("members") or [])

    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(url, ssl=SSL_CTX, heartbeat=None, timeout=aiohttp.ClientWSTimeout(ws_close=5)) as ws:
            welcome = await room_auth(ws, ident, pod_id)
            if welcome.get("member") and lists_me(welcome.get("roster")):
                return welcome["roster"]
            await ws.send_str(json.dumps({"type": "join_request", "name": name, "proof": proof}))
            while True:
                left = deadline - time.time()
                if left <= 0:
                    raise RoomError("the pod's owner didn't answer; is it online?")
                try:
                    ev = await _next_event(ws, left)
                except asyncio.TimeoutError:
                    continue
                if ev.get("type") == "join_failed":
                    if not ev.get("offline") or time.time() + OWNER_RETRY_S > min(deadline, give_up):
                        raise RoomError(ev.get("reason") or "refused")
                    # The owner may be moving into the room (it just made the pod): ask again shortly.
                    await asyncio.sleep(OWNER_RETRY_S)
                    await ws.send_str(json.dumps({"type": "join_request", "name": name, "proof": proof}))
                if ev.get("type") == "roster" and lists_me(ev.get("roster")):
                    return ev["roster"]
