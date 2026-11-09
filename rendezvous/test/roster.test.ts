// Run: node --experimental-strip-types test/roster.test.ts
// The room's roster check must agree with podtorrent/pod.py on every shared vector.
import { readFileSync } from "node:fs";
import { canonical, verifyRoster } from "../src/roster.ts";

const v = JSON.parse(readFileSync(new URL("../../tests/pod_vectors.json", import.meta.url), "utf8"));
let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) { failed++; console.error(`FAIL ${what}`); } };

for (const c of v.canonical) check(canonical(c.value) === c.utf8, `canonical ${c.utf8}`);
// The room skips plan checks (peers do those), so plan-only failures pass here.
const PEER_ONLY = new Set(["bad-plan"]);
for (const c of v.rosters) {
  let got: string | null = null;
  try { await verifyRoster(c.roster, v.now, v.matchmakers); } catch (e) { got = (e as Error).message; }
  const want = PEER_ONLY.has(c.error) ? null : c.error;
  check(got === want, `${c.case}: got ${got}, want ${want}`);
}
console.log(failed ? `${failed} failed` : `ok: ${v.canonical.length + v.rosters.length} vectors`);
process.exit(failed ? 1 : 0);
