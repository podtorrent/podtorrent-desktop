// Bridge to the Tauri shell. Everything degrades to a no-op in a plain browser (dev preview).
import { state, settings, on, emit, commit, swarmStats, selfNode, slicesLabel } from "./store.js";
import { fmt } from "./dom.js";

export const T = window.__TAURI__;
export const isTauri = !!T?.core;
// Only the macOS app has a native menu bar (it owns the shortcuts) and a vibrant, transparent window.
export const isMacApp = isTauri && /Mac/.test(navigator.platform);
if (isMacApp) document.documentElement.classList.add("tauri");

export async function invoke(cmd, args) {
  if (!isTauri) throw new Error("Not running inside the PodTorrent app");
  return T.core.invoke(cmd, args);
}
export async function listen(evt, fn) { if (isTauri) return T.event.listen(evt, e => fn(e.payload)); }

export function setNativeTheme(theme) {
  if (!isTauri) return;
  try { T.window.getCurrentWindow().setTheme(theme === "system" ? null : theme); } catch { /* older runtime */ }
}

// ---- system health (read-only; drives health tiles and the perf governor) ----
export async function pollHealth() {
  try { state.health = await invoke("system_health"); commit(); } catch { /* browser */ }
}

// ---- notifications: meaningful events only, and only when the window isn't in front ----
function notify(title, body) {
  if (!settings.notifications) return;
  if (document.hasFocus()) { emit("toast", { text: title, detail: body, kind: "info" }); return; }
  invoke("notify", { title, body }).catch(() => {});
}

// ---- tray: live sparkline + status ----
let lastTray = "";
function updateTray() {
  if (!isTauri) return;
  const me = selfNode();
  const online = state.engine.phase === "running";
  const st = swarmStats();
  let status = "Not running";
  if (state.engine.phase === "starting") status = "Starting…";
  else if (online) status = `${state.slices.length ? `Serving ${slicesLabel(state.slices)}` : "Peer · serving nothing"} · ${fmt.fixed(st.tps ?? 0)} tok/s`;
  const samples = state.tps.slice(-24);
  const key = status + samples.join(",") + online;
  if (key === lastTray) return;
  lastTray = key;
  invoke("tray_update", { samples, online, status }).catch(() => {});
}

export function initNative() {
  if (!isTauri) return;
  pollHealth();
  setInterval(pollHealth, 5000);
  setInterval(updateTray, 2000);
  on("signal", s => {
    if (s.kind === "joined") notify(`${s.node} joined your swarm`, "It can now serve layers and carry your prompts.");
    if (s.kind === "lost") notify(`${s.node} went offline`, "Its layers have no peer until it reconnects.");
    if (s.kind === "ready") notify("Model fully covered", "Every layer is loaded. The Playground is ready.");
    if (s.kind === "video") notify("Your video is ready", "Open PodTorrent › Playground › Video to watch it.");
    if (s.kind === "milestone") notify(`${fmt.compact(s.tokens)} tokens contributed`, "This machine has processed that many tokens for the swarm.");
  });
  let hiddenOnce = false;
  listen("window-hidden", () => {
    if (hiddenOnce || state.engine.phase !== "running") return;
    hiddenOnce = true;
    invoke("notify", { title: "PodTorrent is still running", body: "Your node keeps contributing from the menu bar. Quit with ⌘Q." }).catch(() => {});
  });
}
