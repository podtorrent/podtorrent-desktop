// Visual-effects governor. The app exists to donate compute, so animation backs off whenever
// this Mac is working, on battery, hot, unfocused, hidden, or the user asked for less motion.
import { state, settings, isBusyLocally } from "./store.js";

const rm = matchMedia("(prefers-reduced-motion: reduce)");
let focused = document.hasFocus();
addEventListener("focus", () => { focused = true; });
addEventListener("blur", () => { focused = false; });

/** @returns {{fps:number, glow:boolean, motion:boolean, level:"full"|"reduced"|"minimal"|"paused", reasons:string[]}} */
export function perf() {
  const reasons = [];
  if (document.hidden) return { fps: 0, glow: false, motion: false, level: "paused", reasons: ["window hidden"] };
  const hl = state.health || {};
  if (rm.matches) reasons.push("Reduce Motion is on");
  if (settings.reduceEffects) reasons.push("Reduce visual effects is on");
  if (hl.power === "battery") reasons.push("on battery");
  if (hl.low_power) reasons.push("Low Power Mode");
  if (hl.thermal === "serious" || hl.thermal === "critical") reasons.push(`thermal state ${hl.thermal}`);
  if (isBusyLocally()) reasons.push("this machine is running inference");
  if (!focused) reasons.push("window in background");
  const motion = !rm.matches;
  if (!reasons.length) return { fps: 60, glow: true, motion, level: "full", reasons };
  const heavy = reasons.some(r => /battery|Low Power|thermal|Reduce visual/.test(r));
  if (!focused) return { fps: 12, glow: false, motion, level: "minimal", reasons };
  return { fps: heavy ? 20 : 30, glow: false, motion, level: heavy ? "minimal" : "reduced", reasons };
}
