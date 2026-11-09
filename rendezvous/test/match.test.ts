// Run: node --experimental-strip-types test/match.test.ts
// The matchmaker's pod formation, head choice, repair and signing (src/match.ts).
import { formPods, matchmakerKey, newRoster, repair, reviseRoster, type Supply } from "../src/match.ts";
import { verifyRoster } from "../src/roster.ts";

let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) { failed++; console.error(`FAIL ${what}`); } };
const M = "mlx-community/Qwen3-30B-A3B-4bit";
// 48 layers of 0.5 GB each; capacity is floor((free*0.9 - 1.5) / 0.5) layers.
const sup = (id: string, free: number, o: Partial<Supply> = {}): Supply => ({
  peer_id: id, pubkey: "", name: id, chip: "M2", mem_total_gb: free, mem_free_gb: free, node: false,
  models: [{ model: M, layers: 48, gb: 24, held: [] }], ...o });

// One machine big enough serves alone; the others don't cover the model on their own.
let plans = formPods([sup("a", 40), sup("b", 5)]);
check(plans.length === 1 && plans[0].hops.length === 1 && plans[0].hops[0].peer === "a", "one big machine covers alone");

// Two halves: neither covers, both together do; the bigger goes first.
plans = formPods([sup("a", 16), sup("b", 16), sup("c", 2)]);
check(plans.length === 1 && plans[0].hops.map(h => h.peer).join() === "a,b" && plans[0].hops[1].hi === 48, "two machines cover");
check(plans[0].head === "a", "head holds layer 0 without tokens");

// A machine holding loaded layers keeps them; a node token makes the head.
plans = formPods([sup("a", 30), sup("b", 10, { node: true, models: [{ model: M, layers: 48, gb: 24, held: [[0, 20]] }] })]);
check(plans[0].hops[0].peer === "b", "holder of layer 0 goes first");
check(plans[0].head === "b", "tokened member is head");

// Not enough memory anywhere: no pod.
check(formPods([sup("a", 8), sup("b", 8)]).length === 0, "no cover, no pod");

// Repair replaces only the missing range.
const p = formPods([sup("a", 16), sup("b", 16)])[0];
const fixed = repair(p, new Set(["b"]), [sup("c", 30)], () => false);
check(!!fixed && fixed.hops[0].peer === "a" && fixed.hops[0].hi === p.hops[0].hi && fixed.hops.slice(1).every(h => h.peer === "c"), "repair keeps healthy hops");
check(repair(p, new Set(["b"]), [sup("c", 3)], () => false) === null, "repair fails without capacity");

// Signed rosters pass the room's check under that matchmaker key.
const seed = "11".repeat(32);
const mm = await matchmakerKey(seed);
const members = [{ peer_id: "", pubkey: mm.pubkey, name: "x" }];
const { peerIdOf } = await import("../src/roster.ts");
members[0].peer_id = await peerIdOf(mm.pubkey);
const plan = { model: M, layers: 48, head: members[0].peer_id, hops: [{ peer: members[0].peer_id, lo: 0, hi: 48 }] };
const r = await newRoster(plan, members, mm);
let ok = true;
try { await verifyRoster(r, Date.now() / 1000, [mm.pubkey]); } catch (e) { ok = false; console.error(e); }
check(ok, "public roster verifies");
const r2 = await reviseRoster(r, plan, members, mm);
try { await verifyRoster(r2, Date.now() / 1000, [mm.pubkey]); check(r2.version === 2 && r2.pod_id === r.pod_id, "revision"); }
catch (e) { check(false, `revision verifies: ${e}`); }
let threw = false;
try { await verifyRoster(r, Date.now() / 1000, []); } catch { threw = true; }
check(threw, "untrusted matchmaker refused");

console.log(failed ? `${failed} failed` : "ok: matchmaker");
process.exit(failed ? 1 : 0);
