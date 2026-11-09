// Pod rosters, as the rendezvous checks them (podtorrent/pod.py is the reference; docs/PODS_PLAN.md).
// The room only needs who may be in it: the signature, the pod id, the signer rule and the member ids.
// Plan validity is the peers' business. Checked against tests/pod_vectors.json by test/roster.test.ts.

export type Member = { peer_id: string; pubkey: string; name: string; public?: boolean };
export type Roster = {
  pod_id: string; salt: string; kind: "private" | "public" | "alone"; name: string; version: number;
  signer: string; members: Member[]; plans: unknown[]; expires: number; sig: string;
};

// Public halves of the matchmaker keys allowed to sign public rosters; empty until the matchmaker exists.
export const MATCHMAKERS: string[] = [];
const ROSTER_DOMAIN = "podtorrent-roster|";

/** Sorted keys, no whitespace: the same bytes as pod.canonical in Python. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("bad-value");
  return JSON.stringify(v);
}

export const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");

export function unhex(s: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error("bad hex");
  return Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
}

export async function sha256(...parts: Uint8Array[]): Promise<string> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return hex(await crypto.subtle.digest("SHA-256", all));
}

export const peerIdOf = async (pubkey: string) => (await sha256(unhex(pubkey))).slice(0, 32);

export async function ed25519Verify(pubkey: string, sig: string, msg: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", unhex(pubkey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unhex(sig), msg);
  } catch {
    return false;
  }
}

const isHex = (x: unknown, n: number) => typeof x === "string" && x.length === n && /^[0-9a-f]*$/.test(x);

/** The roster if it's signed by an allowed signer, unexpired and well formed enough to gate a room;
 *  otherwise throws an Error whose message is one of pod.py's codes. */
export async function verifyRoster(r: any, now = Date.now() / 1000, matchmakers = MATCHMAKERS): Promise<Roster> {
  const fail = (code: string) => { throw new Error(code); };
  const keys = ["expires", "kind", "members", "name", "plans", "pod_id", "salt", "sig", "signer", "version"];
  if (!r || typeof r !== "object" || Object.keys(r).sort().join() !== keys.join()) fail("bad-shape");
  if (!["private", "public", "alone"].includes(r.kind)) fail("bad-kind");
  if (!Number.isInteger(r.version) || r.version < 1 || !Number.isInteger(r.expires) || r.expires < 0) fail("bad-shape");
  if (!isHex(r.signer, 64) || !isHex(r.salt, 32) || !isHex(r.sig, 128)) fail("bad-shape");
  if (r.pod_id !== (await sha256(unhex(r.signer), unhex(r.salt))).slice(0, 32)) fail("pod-id-mismatch");
  const { sig, ...body } = r;
  const msg = new TextEncoder().encode(ROSTER_DOMAIN + canonical(body));
  if (!(await ed25519Verify(r.signer, sig, msg))) fail("bad-signature");
  if (!Array.isArray(r.members) || !r.members.length) fail("bad-members");
  const ids = new Set<string>();
  for (const m of r.members) {
    if (!m || !isHex(m.pubkey, 64) || m.peer_id !== (await peerIdOf(m.pubkey)) || ids.has(m.peer_id)) fail("bad-members");
    ids.add(m.peer_id);
  }
  if (r.kind === "public") {
    if (!matchmakers.includes(r.signer)) fail("untrusted-signer");
    if (r.expires <= 0) fail("bad-shape");
  } else if (!ids.has(await peerIdOf(r.signer))) fail("untrusted-signer");
  if (r.kind === "alone" && r.members.length !== 1) fail("bad-members");
  if (r.expires && now >= r.expires) fail("expired");
  return r as Roster;
}

/** The owner machine's peer_id; null for a public pod, whose signer is the matchmaker. */
export const ownerId = (r: Roster) => (r.kind === "public" ? Promise.resolve(null) : peerIdOf(r.signer));
