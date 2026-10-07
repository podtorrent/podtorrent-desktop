// "Value created" estimates for My Node. Benchmark prices and energy profiles live in
// config/valuation.json (with a last_updated date); nothing here hardcodes a price.
import { commit } from "./store.js";

export let valuation = null;   // parsed config, or null until loaded / on failure
export let valuationError = "";

export async function loadValuation() {
  try {
    const r = await fetch("config/valuation.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    valuation = JSON.parse(await r.text());
  } catch (e) { valuationError = `Couldn't read config/valuation.json (${e.message})`; }
  commit();
}

/** All selectable bases: each benchmark plus the blended index. */
export function bases() {
  if (!valuation) return [];
  const list = valuation.benchmarks.map(b => ({ ...b }));
  const bl = valuation.blended;
  if (bl) {
    let w = 0, sum = 0;
    for (const b of valuation.benchmarks) { const x = bl.weights?.[b.id] || 0; w += x; sum += x * b.usd_per_mtok; }
    if (w > 0) list.push({ id: bl.id || "blended", label: bl.label, note: bl.note, usd_per_mtok: sum / w, blended: true });
  }
  return list;
}

export function basis(id) {
  const all = bases();
  return all.find(b => b.id === id) || all.find(b => b.id === valuation?.default_basis) || all[0] || null;
}

export const usdFor = (tokens, b) => b ? tokens / 1e6 * b.usd_per_mtok : null;

export function energyProfile(chip = "") {
  const ps = valuation?.energy?.profiles || [];
  return ps.find(p => chip.includes(p.match)) || null;
}
/** Estimated kWh from active and idle-online seconds. */
export function kwh(active_s, online_s, chip) {
  const p = energyProfile(chip);
  if (!p) return null;
  return (active_s * p.active_w + Math.max(0, online_s - active_s) * p.idle_w) / 3.6e6;
}

export const usd = x => x == null || !isFinite(x) ? "–" : x >= 1000 ? "$" + Math.round(x).toLocaleString("en-US") : x >= 1 ? "$" + x.toFixed(2) : x >= 0.01 ? "$" + x.toFixed(2) : x > 0 ? "<$0.01" : "$0";
