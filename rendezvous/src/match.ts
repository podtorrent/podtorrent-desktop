// The matchmaker's decisions, kept pure so test/match.test.ts can run them (docs/PODS_PLAN.md, 3).
// Forms public pods by a greedy cover of each model's layers, picks the head and repairs a pod that
// lost a machine. It never moves layers between healthy members: downloads and reloads are expensive.
import { canonical, hex, peerIdOf, sha256, unhex, type Member, type Roster } from "./roster.ts";

/** What a public machine in the lobby offers: the models it has on disk and its free memory. */
export type Supply = {
  peer_id: string; pubkey: string; name: string; chip: string; mem_total_gb: number; mem_free_gb: number;
  node: boolean; // it holds a network node token, so it may be a head
  models: { model: string; layers: number; gb: number; held: [number, number][] }[];
};
export type Hop = { peer: string; lo: number; hi: number };
export type Plan = { model: string; layers: number; head: string; hops: Hop[] };

export const ROSTER_TTL_S = 600;
const HEADROOM = 0.9; // leave 10% of free memory alone, as catalog.suggest does
const HEAD_GB = 1.5;  // embeddings, head and KV cache on the head machine, roughly

type Cand = { s: Supply; cap: number; held: [number, number][] };

function candidates(model: string, idle: Supply[]): (Cand & { layers: number })[] {
  const out: (Cand & { layers: number })[] = [];
  for (const s of idle) {
    const m = s.models.find(x => x.model === model);
    if (!m || m.layers <= 0 || m.gb <= 0) continue;
    // Layers it already serves are already in its used memory.
    const heldN = m.held.reduce((n, [lo, hi]) => n + Math.max(0, hi - lo), 0);
    const cap = Math.floor(Math.max(0, s.mem_free_gb * HEADROOM - HEAD_GB) / (m.gb / m.layers)) + heldN;
    if (cap > 0) out.push({ s, cap, held: m.held, layers: m.layers });
  }
  return out;
}

/** Hops covering [lo, hi) from `cands`, or null if they can't. At each layer, a machine already
 *  holding it goes first, then the one with the most room (fewest hops). Each machine is used once. */
function cover(lo: number, hi: number, cands: Cand[]): Hop[] | null {
  const left = [...cands];
  const hops: Hop[] = [];
  for (let at = lo; at < hi;) {
    const holds = (c: Cand) => c.held.some(([a, b]) => a <= at && at < b);
    left.sort((a, b) => Number(holds(b)) - Number(holds(a)) || b.cap - a.cap || (a.s.peer_id < b.s.peer_id ? -1 : 1));
    const c = left.shift();
    if (!c) return null;
    const end = Math.min(hi, at + c.cap);
    hops.push({ peer: c.s.peer_id, lo: at, hi: end });
    at = end;
  }
  return hops;
}

/** A member with a node token (the one with the most layers), else whoever holds layer 0. */
export function pickHead(hops: Hop[], node: (peer: string) => boolean): string {
  const tokened = hops.filter(h => node(h.peer)).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));
  return (tokened[0] ?? hops[0]).peer;
}

/** New pods from idle public machines: per model, most-held first, one greedy cover each, until no
 *  model can be covered by the machines left. A machine lands in at most one pod. */
export function formPods(idle: Supply[]): Plan[] {
  const free = new Map(idle.map(s => [s.peer_id, s]));
  const plans: Plan[] = [];
  const models = [...new Set(idle.flatMap(s => s.models.map(m => m.model)))];
  const holders = (m: string) => idle.filter(s => s.models.some(x => x.model === m && x.held.length)).length;
  models.sort((a, b) => holders(b) - holders(a) || (a < b ? -1 : 1));
  for (const model of models) {
    for (;;) {
      const cands = candidates(model, [...free.values()]);
      if (!cands.length) break;
      const layers = cands[0].layers;
      const hops = cover(0, layers, cands.filter(c => c.layers === layers));
      if (!hops) break;
      plans.push({ model, layers, head: pickHead(hops, p => free.get(p)!.node), hops });
      for (const h of hops) free.delete(h.peer);
    }
  }
  return plans;
}

/** `plan` without the machines in `gone`: their ranges re-covered from `idle`, or null if they can't be. */
export function repair(plan: Plan, gone: Set<string>, idle: Supply[], node: (peer: string) => boolean): Plan | null {
  const cands = candidates(plan.model, idle).filter(c => c.layers === plan.layers);
  const hops: Hop[] = [];
  for (const h of plan.hops) {
    if (!gone.has(h.peer)) { hops.push(h); continue; }
    const fill = cover(h.lo, h.hi, cands);
    if (!fill) return null;
    for (const f of fill) cands.splice(cands.findIndex(c => c.s.peer_id === f.peer), 1);
    hops.push(...fill);
  }
  const head = gone.has(plan.head) ? pickHead(hops, node) : plan.head;
  return { ...plan, head, hops };
}

// ---------------------------------------------------------------- signing

/** The matchmaker's Ed25519 key from its 32-byte seed (the MATCHMAKER_SEED secret). */
export async function matchmakerKey(seedHex: string): Promise<{ key: CryptoKey; pubkey: string }> {
  // PKCS#8 wrapper for an Ed25519 seed (RFC 8410).
  const pkcs8 = new Uint8Array([...unhex("302e020100300506032b657004220420"), ...unhex(seedHex)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const pub = Uint8Array.from(atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  return { key, pubkey: hex(pub) };
}

async function sign(body: Omit<Roster, "sig">, key: CryptoKey): Promise<Roster> {
  const msg = new TextEncoder().encode("podtorrent-roster|" + canonical(body));
  return { ...body, sig: hex(await crypto.subtle.sign({ name: "Ed25519" }, key, msg)) };
}

/** A version-1 public roster for `plan`, expiring ROSTER_TTL_S from `now`. */
export async function newRoster(plan: Plan, members: Member[], mm: { key: CryptoKey; pubkey: string },
                                now = Date.now() / 1000): Promise<Roster> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const pod_id = (await sha256(unhex(mm.pubkey), unhex(salt))).slice(0, 32);
  return sign({ pod_id, salt, kind: "public", name: `pub-${pod_id.slice(0, 4)}`, version: 1, signer: mm.pubkey,
    members, plans: [plan], expires: Math.floor(now) + ROSTER_TTL_S }, mm.key);
}

/** `r` one version newer, with `plan` (and members trimmed to its hops), expiring ROSTER_TTL_S from `now`. */
export async function reviseRoster(r: Roster, plan: Plan, members: Member[], mm: { key: CryptoKey; pubkey: string },
                                   now = Date.now() / 1000): Promise<Roster> {
  const { sig: _, ...body } = r;
  return sign({ ...body, version: r.version + 1, members, plans: [plan], expires: Math.floor(now) + ROSTER_TTL_S }, mm.key);
}

export async function memberOf(s: Pick<Supply, "pubkey" | "name">): Promise<Member> {
  return { peer_id: await peerIdOf(s.pubkey), pubkey: s.pubkey, name: s.name.slice(0, 64) || "machine" };
}
