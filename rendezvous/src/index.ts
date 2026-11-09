// PodTorrent rendezvous: peer registries plus hole-punch signaling.
// - `Swarm` (one, "global"): the public swarm, for machines in no pod.
// - `Pod` (one per pod id): a pod's members only, gated by the pod's signed roster (docs/PODS_PLAN.md).
// Sockets hibernate between messages, and "ping" is answered without waking the object, so idle
// peers cost nothing.
import { DurableObject } from "cloudflare:workers";
import { ed25519Verify, ownerId, peerIdOf, verifyRoster, type Roster } from "./roster";

export interface Env {
  SWARM: DurableObjectNamespace<Swarm>;
  POD: DurableObjectNamespace<Pod>;
}

const PROTOCOL = 1;
const STALE_MS = 30_000; // no ping for this long: the peer is gone
const SWEEP_MS = 15_000;
const MAX_RECORD_BYTES = 8_192;

type Attachment = { peer_id: string; observed_ip: string; record: Record<string, unknown> | null };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("podtorrent rendezvous\n");
    const pod = url.pathname.match(/^\/v1\/pod\/([0-9a-f]{32})$/);
    if (url.pathname !== "/v1/swarm" && !pod) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (pod) return env.POD.get(env.POD.idFromName(pod[1])).fetch(req);
    return env.SWARM.get(env.SWARM.idFromName("global")).fetch(req);
  },
};

export class Swarm extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const peerId = new URL(req.url).searchParams.get("peer_id") ?? "";
    if (!/^[0-9a-f]{16,64}$/.test(peerId)) return new Response("bad peer_id", { status: 400 });
    // A reconnecting peer replaces its old socket.
    for (const old of this.ctx.getWebSockets(peerId)) old.close(4000, "replaced");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [peerId]);
    const att: Attachment = { peer_id: peerId, observed_ip: req.headers.get("CF-Connecting-IP") ?? "", record: null };
    server.serializeAttachment(att);
    // Snapshot for the newcomer: lets a not-yet-started app show who's online without registering.
    server.send(JSON.stringify({ type: "peers", peers: this.records(), ts: Date.now() }));
    await this.ensureSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_RECORD_BYTES) return;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() as Attachment;
    switch (msg.type) {
      case "hello":
      case "update": {
        if (typeof msg.peer !== "object" || msg.peer === null) return;
        att.record = { ...msg.peer, peer_id: att.peer_id, observed_ip: att.observed_ip, seen_ms: Date.now() };
        ws.serializeAttachment(att);
        if (msg.type === "hello") ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, peer_id: att.peer_id, observed_ip: att.observed_ip }));
        this.broadcast();
        break;
      }
      case "punch": {
        // Ask `to` to start hole punching towards the sender; both sides then probe each other.
        const target = this.ctx.getWebSockets(String(msg.to ?? ""))[0];
        if (!target || !att.record) { ws.send(JSON.stringify({ type: "punch_failed", to: msg.to, reason: "offline" })); return; }
        const t = target.deserializeAttachment() as Attachment;
        const nonce = String(msg.nonce ?? "").slice(0, 64);
        target.send(JSON.stringify({ type: "punch", from: att.peer_id, peer: att.record, nonce }));
        ws.send(JSON.stringify({ type: "punch_ack", to: t.peer_id, peer: t.record, nonce }));
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
    this.broadcast(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast(ws);
  }

  /** Drop sockets that stopped pinging (dead NAT mappings, sleeping laptops). */
  async alarm(): Promise<void> {
    const now = Date.now();
    let dropped = false;
    for (const ws of this.ctx.getWebSockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const att = ws.deserializeAttachment() as Attachment;
      // A peer that never pinged yet gets one full window from its last hello or update.
      const seen = Math.max(last, (att.record?.seen_ms as number) ?? 0);
      if (now - seen > STALE_MS) { try { ws.close(4001, "stale"); } catch { /* gone */ } dropped = true; }
    }
    if (dropped) this.broadcast();
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  private async ensureSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  private records(exclude?: WebSocket): Record<string, unknown>[] {
    return this.ctx.getWebSockets().filter(ws => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map(ws => (ws.deserializeAttachment() as Attachment).record).filter((r): r is Record<string, unknown> => !!r);
  }

  private broadcast(exclude?: WebSocket): void {
    const socks = this.ctx.getWebSockets().filter(ws => ws !== exclude && ws.readyState === WebSocket.OPEN);
    const peers = this.records(exclude);
    const msg = JSON.stringify({ type: "peers", peers, ts: Date.now() });
    for (const ws of socks) { try { ws.send(msg); } catch { /* closing */ } }
  }
}

// ---------------------------------------------------------------- pods

const ROOM_PROTOCOL = 3;
const GUEST_MS = 60_000; // a machine that isn't a member gets this long to have its join request answered
const MAX_MSG_BYTES = 64_000; // rosters of large pods outgrow the record limit

type PodAttachment = {
  pod_id: string; nonce: string; since: number; observed_ip: string;
  peer_id: string; pubkey: string; authed: boolean; member: boolean; record: Record<string, unknown> | null;
};

/** One pod's room. A socket proves its key by signing a nonce; the stored roster says whether it's a
 *  member. Members see each other and can punch; anyone else may only send join requests, which go
 *  to the owner (as do members' leave requests). A newer valid roster (from the owner) replaces the stored one and is broadcast:
 *  removed members are disconnected, newly added ones are let in. */
export class Pod extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const podId = new URL(req.url).pathname.split("/").pop()!;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    const att: PodAttachment = { pod_id: podId, nonce, since: Date.now(), observed_ip: req.headers.get("CF-Connecting-IP") ?? "",
      peer_id: "", pubkey: "", authed: false, member: false, record: null };
    server.serializeAttachment(att);
    server.send(JSON.stringify({ type: "challenge", nonce, protocol: ROOM_PROTOCOL }));
    await this.ensureSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() as PodAttachment;
    if (!att.authed) {
      if (msg.type === "auth") await this.auth(ws, att, msg);
      return;
    }
    switch (msg.type) {
      case "hello":
      case "update": {
        if (!att.member || typeof msg.peer !== "object" || msg.peer === null) return;
        att.record = { ...msg.peer, peer_id: att.peer_id, observed_ip: att.observed_ip, seen_ms: Date.now() };
        ws.serializeAttachment(att);
        this.broadcastPeers();
        break;
      }
      case "punch": {
        if (!att.member) return;
        const target = this.sockets().find(s => s.att.member && s.att.peer_id === String(msg.to ?? ""));
        if (!target || !att.record) { ws.send(JSON.stringify({ type: "punch_failed", to: msg.to, reason: "offline" })); return; }
        const nonce = String(msg.nonce ?? "").slice(0, 64);
        target.ws.send(JSON.stringify({ type: "punch", from: att.peer_id, peer: att.record, nonce }));
        ws.send(JSON.stringify({ type: "punch_ack", to: target.att.peer_id, peer: target.att.record, nonce }));
        break;
      }
      case "roster":
        await this.offerRoster(msg.roster, att.pod_id);
        break;
      case "join_request": {
        if (att.member) return;
        const roster = await this.roster();
        const owner = roster && (await ownerId(roster));
        const owners = this.sockets().filter(s => s.att.member && s.att.peer_id === owner);
        if (!owners.length) {
          ws.send(JSON.stringify({ type: "join_failed", offline: true,
            reason: roster ? "the pod's owner is offline" : "no such pod, or its owner hasn't come online yet" }));
          return;
        }
        const fwd = JSON.stringify({ type: "join_request", from: att.peer_id, pubkey: att.pubkey,
          name: String(msg.name ?? "").slice(0, 64), proof: String(msg.proof ?? "").slice(0, 128) });
        for (const o of owners) o.ws.send(fwd);
        break;
      }
      case "leave": {
        // A member leaving: ask the owner to sign it out of the roster.
        const roster = await this.roster();
        const owner = roster && (await ownerId(roster));
        if (!att.member || att.peer_id === owner) return;
        const fwd = JSON.stringify({ type: "leave_request", from: att.peer_id });
        for (const o of this.sockets().filter(s => s.att.member && s.att.peer_id === owner)) o.ws.send(fwd);
        break;
      }
      case "join_failed": {
        // The owner refusing a join request: tell that guest.
        const roster = await this.roster();
        if (!roster || att.peer_id !== (await ownerId(roster))) return;
        for (const g of this.sockets().filter(s => !s.att.member && s.att.peer_id === String(msg.to ?? "")))
          g.ws.send(JSON.stringify({ type: "join_failed", reason: String(msg.reason ?? "refused").slice(0, 200) }));
        break;
      }
    }
  }

  private async auth(ws: WebSocket, att: PodAttachment, msg: any): Promise<void> {
    const pubkey = String(msg.pubkey ?? "");
    const proof = new TextEncoder().encode(`podtorrent-room|${att.pod_id}|${att.nonce}`);
    if (!/^[0-9a-f]{64}$/.test(pubkey) || !(await ed25519Verify(pubkey, String(msg.sig ?? ""), proof))) {
      ws.close(4002, "bad auth");
      return;
    }
    att.authed = true;
    att.pubkey = pubkey;
    att.peer_id = await peerIdOf(pubkey);
    // A reconnecting peer replaces its old socket.
    for (const s of this.sockets()) if (s.ws !== ws && s.att.peer_id === att.peer_id) s.ws.close(4000, "replaced");
    ws.serializeAttachment(att);
    if (msg.roster) await this.offerRoster(msg.roster, att.pod_id);
    const roster = await this.roster();
    const fresh = ws.deserializeAttachment() as PodAttachment;
    fresh.member = !!roster && roster.members.some(m => m.peer_id === fresh.peer_id);
    ws.serializeAttachment(fresh);
    ws.send(JSON.stringify({ type: "welcome", protocol: ROOM_PROTOCOL, peer_id: fresh.peer_id, observed_ip: fresh.observed_ip,
      member: fresh.member, roster }));
    if (fresh.member) ws.send(JSON.stringify({ type: "peers", peers: this.records(), ts: Date.now() }));
  }

  /** Store `r` if it's a valid, newer roster of this pod, then re-gate every socket. */
  private async offerRoster(r: unknown, podId: string): Promise<void> {
    let roster: Roster;
    try { roster = await verifyRoster(r); } catch { return; }
    const cur = await this.roster();
    if (roster.pod_id !== podId || (cur && roster.version <= cur.version)) return;
    await this.ctx.storage.put("roster", roster);
    const ids = new Set(roster.members.map(m => m.peer_id));
    const out = JSON.stringify({ type: "roster", roster });
    for (const { ws, att } of this.sockets()) {
      if (!att.authed) continue;
      const member = ids.has(att.peer_id);
      ws.send(out);
      if (att.member && !member) { ws.close(4003, "not-a-member"); continue; }
      if (member !== att.member) { att.member = member; ws.serializeAttachment(att); }
    }
    this.broadcastPeers();
  }

  private async roster(): Promise<Roster | null> {
    const r = (await this.ctx.storage.get<Roster>("roster")) ?? null;
    if (r && r.expires && Date.now() / 1000 >= r.expires) return null;
    return r;
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
    this.broadcastPeers(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPeers(ws);
  }

  /** Drop sockets that stopped pinging, and guests whose join wasn't answered in time. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let dropped = false;
    for (const { ws, att } of this.sockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const seen = Math.max(last, (att.record?.seen_ms as number) ?? 0, att.since);
      if (now - seen > STALE_MS || (!att.member && now - att.since > GUEST_MS)) {
        try { ws.close(4001, att.member ? "stale" : "join timed out"); } catch { /* gone */ }
        dropped = true;
      }
    }
    if (dropped) this.broadcastPeers();
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  private async ensureSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  private sockets(exclude?: WebSocket): { ws: WebSocket; att: PodAttachment }[] {
    return this.ctx.getWebSockets().filter(ws => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map(ws => ({ ws, att: ws.deserializeAttachment() as PodAttachment }));
  }

  private records(exclude?: WebSocket): Record<string, unknown>[] {
    return this.sockets(exclude).filter(s => s.att.member && s.att.record).map(s => s.att.record!);
  }

  private broadcastPeers(exclude?: WebSocket): void {
    const msg = JSON.stringify({ type: "peers", peers: this.records(exclude), ts: Date.now() });
    for (const { ws, att } of this.sockets(exclude)) if (att.member) { try { ws.send(msg); } catch { /* closing */ } }
  }
}
