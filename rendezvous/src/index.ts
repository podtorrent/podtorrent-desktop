// PodTorrent rendezvous: peer registries plus hole-punch signaling, and a relay for pod members
// that can't hole-punch.
// - `Swarm` (one, "global"): the public swarm, for machines in no pod.
// - `Pod` (one per pod id): a pod's members only, gated by the pod's signed roster (docs/PODS_PLAN.md).
// - `Matchmaker` (one, "public"): the lobby where public machines offer supply and get put into
//   public pods, plus the read-only census of every pod and idle machine (/v1/census).
// The global `Swarm` room stays for machines from 0.1.24 and earlier; newer ones use the lobby instead.
// Sockets hibernate between messages, and "ping" is answered without waking the object, so idle
// peers cost nothing.
import { DurableObject } from "cloudflare:workers";
import { formPods, matchmakerKey, memberOf, newRoster, repair, reviseRoster, ROSTER_TTL_S, type Plan, type Supply } from "./match";
import { ed25519Verify, ownerId, peerIdOf, verifyRoster, type Roster } from "./roster";

export interface Env {
  SWARM: DurableObjectNamespace<Swarm>;
  POD: DurableObjectNamespace<Pod>;
  MATCH: DurableObjectNamespace<Matchmaker>;
  MATCHMAKER_SEED: string;
}

/** The public half of this Worker's MATCHMAKER_SEED: the one matchmaker its public rosters may come from.
 * Nothing is hard-coded, so a fork's Worker trusts only its own seed. */
let matchmakers: Promise<string[]> | undefined;
function matchmakersOf(env: Env): Promise<string[]> {
  if (!env.MATCHMAKER_SEED) return Promise.resolve([]);
  return (matchmakers ??= matchmakerKey(env.MATCHMAKER_SEED).then(k => [k.pubkey]));
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
    const lobby = url.pathname === "/v1/public" || url.pathname === "/v1/census";
    if (url.pathname !== "/v1/swarm" && !pod && !lobby) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (pod) return env.POD.get(env.POD.idFromName(pod[1])).fetch(req);
    if (lobby) return env.MATCH.get(env.MATCH.idFromName("public")).fetch(req);
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
const MAX_RELAY_B64 = 4_096;   // one QUIC packet (≤1500 bytes), base64

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
      case "relay": {
        // QUIC between two members whose NATs won't hole-punch: the room carries their packets.
        // Still end-to-end encrypted and authenticated by the peers; the room only checks both are members.
        if (!att.member || typeof msg.data !== "string" || msg.data.length > MAX_RELAY_B64) return;
        const target = this.sockets().find(s => s.att.member && s.att.peer_id === String(msg.to ?? ""));
        if (target) target.ws.send(JSON.stringify({ type: "relay", from: att.peer_id, data: msg.data }));
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
    try { roster = await verifyRoster(r, Date.now() / 1000, await matchmakersOf(this.env)); } catch { return; }
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
    else await this.report();
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
    this.ctx.waitUntil(this.report(exclude));
  }

  /** Tell the matchmaker who's online here and what the pod looks like, for repair and the census. */
  private async report(exclude?: WebSocket): Promise<void> {
    const roster = await this.roster();
    if (!roster) return;
    const recs = new Map(this.sockets(exclude).filter(s => s.att.member && s.att.record).map(s => [s.att.peer_id, s.att.record!]));
    try { await this.env.MATCH.get(this.env.MATCH.idFromName("public")).podReport(podSummary(roster, recs)); } catch { /* next change reports again */ }
  }

  // ---- called by the matchmaker, for public pods ----

  /** Store and broadcast a roster the matchmaker signed (a new pod, a renewal or a repair). */
  async install(roster: Roster): Promise<void> {
    await this.offerRoster(roster, roster.pod_id);
  }

  /** The matchmaker gave up on this pod: members go back to the lobby. */
  async dissolve(): Promise<void> {
    await this.ctx.storage.delete("roster");
    for (const { ws } of this.sockets()) {
      try { ws.send(JSON.stringify({ type: "dissolved" })); ws.close(4004, "dissolved"); } catch { /* gone */ }
    }
  }
}

/** A pod for the census: chips, memory and layer ranges, never machine names or keys. `online` is for
 *  the matchmaker only. */
export type PodSummary = {
  pod_id: string; kind: Roster["kind"]; models: string[]; on_network: boolean; online: string[];
  head: Machine | null; satellites: Machine[]; ts: number;
};
type Machine = { chip: string; mem_gb: number; layers: [number, number][]; busy: boolean; tok_s: number; online: boolean };

function podSummary(r: Roster, recs: Map<string, Record<string, unknown>>): PodSummary {
  const plans = r.plans as Plan[];
  const head = plans[0]?.head ?? r.members[0].peer_id;
  const machine = (id: string): Machine => {
    const rec = recs.get(id) ?? {};
    return { chip: String(rec.chip ?? ""), mem_gb: Number(rec.mem_total_gb ?? 0), online: recs.has(id),
      layers: plans.flatMap(p => p.hops.filter(h => h.peer === id).map(h => [h.lo, h.hi] as [number, number])),
      busy: !!rec.busy, tok_s: Number(rec.tok_s ?? 0) };
  };
  return { pod_id: r.pod_id, kind: r.kind, models: plans.map(p => p.model), online: [...recs.keys()],
    on_network: !!recs.get(head)?.on_network, head: machine(head),
    satellites: r.members.filter(m => m.peer_id !== head).map(m => machine(m.peer_id)), ts: Date.now() };
}

// ---------------------------------------------------------------- the matchmaker

const GONE_MS = 60_000;     // a public pod member missing from its room this long is replaced
const CENSUS_STALE_MS = 60_000; // pod rooms report at least every sweep; older reports are dropped
const MATCH_SWEEP_MS = 20_000;

type LobbyAttachment = { nonce: string; since: number; authed: boolean; peer_id: string; pubkey: string; supply: Supply | null };
type PublicPod = { roster: Roster; absent: Record<string, number>; nodes: string[] };

/** The public lobby and the census. Public machines prove their key, offer supply (models on disk,
 *  free memory) and wait; the matchmaker covers models with them, signs a public roster for each new
 *  pod, installs it in the pod's room and tells the members, who move there. It renews rosters while
 *  a pod is healthy, replaces a member that stays gone, and dissolves a pod it can't repair. */
export class Matchmaker extends DurableObject<Env> {
  private mm: Promise<{ key: CryptoKey; pubkey: string }> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private key() {
    if (!this.env.MATCHMAKER_SEED) throw new Error("MATCHMAKER_SEED is not set");
    return (this.mm ??= matchmakerKey(this.env.MATCHMAKER_SEED));
  }

  async fetch(req: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    if (new URL(req.url).pathname === "/v1/census") {
      this.ctx.acceptWebSocket(server, ["census"]);
      server.send(await this.census());
    } else {
      this.ctx.acceptWebSocket(server, ["lobby"]);
      const nonce = hex16();
      server.serializeAttachment({ nonce, since: Date.now(), authed: false, peer_id: "", pubkey: "", supply: null } satisfies LobbyAttachment);
      server.send(JSON.stringify({ type: "challenge", nonce, protocol: ROOM_PROTOCOL }));
    }
    await this.ensureSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_RECORD_BYTES || !this.ctx.getTags(ws).includes("lobby")) return;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() as LobbyAttachment;
    if (!att.authed) {
      if (msg.type !== "auth") return;
      const pubkey = String(msg.pubkey ?? "");
      const proof = new TextEncoder().encode(`podtorrent-room|public|${att.nonce}`);
      if (!/^[0-9a-f]{64}$/.test(pubkey) || !(await ed25519Verify(pubkey, String(msg.sig ?? ""), proof))) {
        ws.close(4002, "bad auth");
        return;
      }
      att.authed = true;
      att.pubkey = pubkey;
      att.peer_id = await peerIdOf(pubkey);
      for (const s of this.lobby()) if (s.ws !== ws && s.att.peer_id === att.peer_id) s.ws.close(4000, "replaced");
      ws.serializeAttachment(att);
      ws.send(JSON.stringify({ type: "welcome", protocol: ROOM_PROTOCOL, peer_id: att.peer_id, lobby: true }));
      // Already in a live public pod (it lost its copy): send it back there.
      const mine = Object.values(await this.pods()).find(p => p.roster.members.some(m => m.peer_id === att.peer_id));
      if (mine) ws.send(JSON.stringify({ type: "assign", roster: mine.roster }));
      return;
    }
    if (msg.type === "supply" && msg.supply && typeof msg.supply === "object") {
      att.supply = cleanSupply(msg.supply, att);
      ws.serializeAttachment(att);
      await this.match();
      await this.broadcastCensus();
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
    if (this.ctx.getTags(ws).includes("lobby")) await this.broadcastCensus(ws);
  }

  /** Pod rooms call this on every change and sweep. */
  async podReport(s: PodSummary): Promise<void> {
    const reports = await this.reports();
    if (!s.online.length && s.kind !== "public") delete reports[s.pod_id];
    else reports[s.pod_id] = s;
    await this.ctx.storage.put("reports", reports);
    await this.broadcastCensus();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets("lobby")) {
      const att = ws.deserializeAttachment() as LobbyAttachment;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? att.since;
      if (now - Math.max(last, att.since) > STALE_MS) { try { ws.close(4001, "stale"); } catch { /* gone */ } }
    }
    await this.tend(now);
    const reports = await this.reports();
    for (const [id, r] of Object.entries(reports)) if (now - r.ts > CENSUS_STALE_MS) delete reports[id];
    await this.ctx.storage.put("reports", reports);
    await this.match();
    await this.broadcastCensus();
    if (this.ctx.getWebSockets().length || Object.keys(await this.pods()).length) await this.ctx.storage.setAlarm(now + MATCH_SWEEP_MS);
  }

  /** Renew healthy public pods, repair ones missing a member, dissolve the rest. */
  private async tend(now: number): Promise<void> {
    const pods = await this.pods();
    const reports = await this.reports();
    const idle = await this.idle(pods);
    for (const [id, p] of Object.entries(pods)) {
      if (p.roster.expires * 1000 <= now) { delete pods[id]; continue; }
      const online = new Set(reports[id]?.online ?? []);
      for (const m of p.roster.members) {
        if (online.has(m.peer_id)) delete p.absent[m.peer_id];
        else p.absent[m.peer_id] ??= now;
      }
      const gone = new Set(p.roster.members.filter(m => now - (p.absent[m.peer_id] ?? now) > GONE_MS).map(m => m.peer_id));
      const plan = p.roster.plans[0] as Plan;
      if (gone.size === p.roster.members.length) { await this.dissolve(id, pods); continue; }
      if (gone.size) {
        const nodes = new Set([...p.nodes, ...idle.filter(s => s.node).map(s => s.peer_id)]);
        const fixed = repair(plan, gone, idle, peer => nodes.has(peer));
        if (!fixed) { await this.dissolve(id, pods); continue; }
        const used = new Set(fixed.hops.map(h => h.peer));
        const added = idle.filter(s => used.has(s.peer_id) && !p.roster.members.some(m => m.peer_id === s.peer_id));
        const members = [...p.roster.members.filter(m => used.has(m.peer_id)), ...(await Promise.all(added.map(memberOf)))];
        p.roster = await reviseRoster(p.roster, fixed, members, await this.key(), now / 1000);
        p.nodes = [...p.nodes.filter(n => used.has(n)), ...added.filter(s => s.node).map(s => s.peer_id)];
        for (const s of added) { p.absent[s.peer_id] = now; idle.splice(idle.indexOf(s), 1); }
        for (const g of gone) delete p.absent[g];
        await this.publish(p.roster, added.map(s => s.peer_id));
      } else if (p.roster.expires * 1000 - now < (ROSTER_TTL_S * 1000) / 2) {
        p.roster = await reviseRoster(p.roster, plan, p.roster.members, await this.key(), now / 1000);
        await this.publish(p.roster, []);
      }
    }
    await this.ctx.storage.put("pods", pods);
  }

  /** New public pods from the lobby's idle machines. */
  private async match(): Promise<void> {
    if (!this.env.MATCHMAKER_SEED) return;
    const pods = await this.pods();
    const idle = await this.idle(pods);
    const plans = formPods(idle);
    if (!plans.length) return;
    const bySupply = new Map(idle.map(s => [s.peer_id, s]));
    for (const plan of plans) {
      const sup = plan.hops.map(h => bySupply.get(h.peer)!);
      const roster = await newRoster(plan, await Promise.all(sup.map(memberOf)), await this.key());
      const now = Date.now();
      pods[roster.pod_id] = { roster, absent: Object.fromEntries(sup.map(s => [s.peer_id, now])),
        nodes: sup.filter(s => s.node).map(s => s.peer_id) };
      await this.publish(roster, sup.map(s => s.peer_id));
    }
    await this.ctx.storage.put("pods", pods);
  }

  /** Install `roster` in its pod's room and send it to the lobby sockets of `assign`. */
  private async publish(roster: Roster, assign: string[]): Promise<void> {
    await this.env.POD.get(this.env.POD.idFromName(roster.pod_id)).install(roster);
    const out = JSON.stringify({ type: "assign", roster });
    for (const s of this.lobby()) if (assign.includes(s.att.peer_id)) { try { s.ws.send(out); } catch { /* gone */ } }
  }

  /** Forget pod `id` (saved first, so members coming back to the lobby aren't sent to it again) and
   *  send its members back to the lobby. */
  private async dissolve(id: string, pods: Record<string, PublicPod>): Promise<void> {
    delete pods[id];
    await this.ctx.storage.put("pods", pods);
    try { await this.env.POD.get(this.env.POD.idFromName(id)).dissolve(); } catch { /* it expires anyway */ }
    const reports = await this.reports();
    delete reports[id];
    await this.ctx.storage.put("reports", reports);
  }

  /** Lobby machines with supply that aren't in a public pod yet. */
  private async idle(pods: Record<string, PublicPod>): Promise<Supply[]> {
    const taken = new Set(Object.values(pods).flatMap(p => p.roster.members.map(m => m.peer_id)));
    return this.lobby().map(s => s.att.supply).filter((s): s is Supply => !!s && !taken.has(s.peer_id));
  }

  private lobby(exclude?: WebSocket): { ws: WebSocket; att: LobbyAttachment }[] {
    return this.ctx.getWebSockets("lobby").filter(ws => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map(ws => ({ ws, att: ws.deserializeAttachment() as LobbyAttachment })).filter(s => s.att.authed);
  }

  private async pods(): Promise<Record<string, PublicPod>> {
    return (await this.ctx.storage.get<Record<string, PublicPod>>("pods")) ?? {};
  }

  private async reports(): Promise<Record<string, PodSummary>> {
    return (await this.ctx.storage.get<Record<string, PodSummary>>("reports")) ?? {};
  }

  private async census(exclude?: WebSocket): Promise<string> {
    const reports = Object.values(await this.reports()).map(({ online: _, ...r }) => r);
    const idle = (await this.idle(await this.pods())).map(s => ({ chip: s.chip, mem_gb: s.mem_total_gb, models: s.models.map(m => m.model) }));
    // Lobby machines that haven't offered supply yet still count as online.
    const waiting = this.lobby(exclude).filter(s => !s.att.supply).length;
    return JSON.stringify({ type: "census", pods: reports, idle, waiting, ts: Date.now() });
  }

  private async broadcastCensus(exclude?: WebSocket): Promise<void> {
    const socks = this.ctx.getWebSockets("census").filter(ws => ws.readyState === WebSocket.OPEN);
    if (!socks.length) return;
    const msg = await this.census(exclude);
    for (const ws of socks) { try { ws.send(msg); } catch { /* closing */ } }
  }

  private async ensureSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + MATCH_SWEEP_MS);
  }
}

const hex16 = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

/** A supply message with only the fields the matchmaker uses, sane types and the socket's own key. */
function cleanSupply(s: any, att: LobbyAttachment): Supply {
  const num = (x: unknown) => (typeof x === "number" && isFinite(x) && x >= 0 ? x : 0);
  const models = (Array.isArray(s.models) ? s.models : []).slice(0, 32).flatMap((m: any) =>
    typeof m?.model === "string" && Number.isInteger(m.layers) && m.layers > 0
      ? [{ model: m.model.slice(0, 200), layers: m.layers, gb: num(m.gb),
           held: (Array.isArray(m.held) ? m.held : []).filter((r: any) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] < r[1])
             .slice(0, 16).map((r: number[]) => [r[0], r[1]] as [number, number]) }]
      : []);
  return { peer_id: att.peer_id, pubkey: att.pubkey, name: String(s.name ?? "").slice(0, 64), chip: String(s.chip ?? "").slice(0, 64),
    mem_total_gb: num(s.mem_total_gb), mem_free_gb: num(s.mem_free_gb), node: !!s.node, models };
}
