// PodTorrent rendezvous: one global registry of online peers, plus hole-punch signaling.
// Every peer keeps a WebSocket to the single `Swarm` Durable Object. Sockets hibernate between
// messages, and "ping" is answered without waking the object, so idle peers cost nothing.
import { DurableObject } from "cloudflare:workers";

export interface Env {
  SWARM: DurableObjectNamespace<Swarm>;
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
    if (url.pathname !== "/v1/swarm") return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
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
