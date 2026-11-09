// Every user-facing action lives here so the sidebar, toolbar, menu bar, ⌘K palette and
// keyboard shortcuts all trigger the same thing.
import { state, settings, setSetting, emit, on, resetState, commit, selfNode } from "./store.js";
import * as engine from "./engine.js";
import { startDemo, stopDemo, presets } from "./demo.js";
import { toast } from "./ui.js";

export const VIEWS = ["swarm", "models", "playground", "node", "peers", "activity", "pod", "network", "settings"];
let route = "swarm";
export const currentRoute = () => route;
/** Open a view; `tab` picks its sub-tab (Models: "text" | "video", Playground: "text" | "video"). */
export function go(v, tab) {
  if (v === "video") v = "playground", tab = "video";  // old Video page: its studio is Playground's Video mode
  if (!VIEWS.includes(v)) return;
  if (tab) setSetting(`${v}Tab`, tab);
  route = v;
  emit("route", v);
}

export async function setDemo(on_) {
  if (on_ === (state.source === "demo")) return;
  if (on_ && state.engine.phase !== "stopped" && state.source === "live") {
    toast("Demo Mode is view-only", "info", "Your real node keeps running; turn Demo off to see it again.");
  }
  setSetting("demo", on_);
  if (on_) { engine.detach(); startDemo(settings.demoPreset); }
  else { stopDemo(); resetState({ source: "live" }); await engine.attachExisting(); }
  toast(on_ ? `Demo Mode on · ${presets[settings.demoPreset].label}` : "Demo Mode off", on_ ? "degraded" : "info");
}
export const toggleDemo = () => setDemo(state.source !== "demo");
export function setDemoPreset(p) {
  setSetting("demoPreset", p);
  if (state.source === "demo") startDemo(p);
}

/** Kept for the menu and ⌘K: there's no address to enter any more, so this just starts the peer. */
export function joinDialog() { go("node"); engine.startHost(); }

export async function copyText(t, what = "Copied") {
  try { await navigator.clipboard.writeText(t); toast(what, "serving"); } catch { toast("Couldn't copy", "gap"); }
}
/** Peers find each other by themselves; the peer ID is only useful for support and logs. */
export function copyNodeId() {
  const id = state.hostInfo?.peer_id;
  if (!id) return toast("No node running", "degraded");
  copyText(id, `Peer ID of ${state.self} copied`);
}

export const toggleSidebar = () => setSetting("sidebarCollapsed", !settings.sidebarCollapsed);
export const toggleInspector = () => { setSetting("inspector", !settings.inspector); if (route !== "playground") go("playground"); };
export const toggleSwarmLayout = () => { setSetting("swarmLayout", settings.swarmLayout === "graph" ? "grid" : "graph"); if (route !== "swarm") go("swarm"); };

export const actions = {
  startHost: () => { go("node"); engine.startHost(); },
  join: joinDialog,
  stop: () => engine.stopNode(),
  load: () => { go("models"); engine.loadModel(); },
  quit: () => engine.quitApp(),
};

// menu bar → actions
export function handleMenu(id) {
  if (id.startsWith("nav:")) return go(id.slice(4));
  ({
    settings: () => go("settings"), palette: () => emit("palette"), "toggle-sidebar": toggleSidebar,
    inspector: toggleInspector, "swarm-layout": toggleSwarmLayout, demo: toggleDemo, shortcuts: () => emit("shortcuts"),
    onboarding: () => emit("onboarding"), "node:start-host": actions.startHost, "node:join": actions.join,
    "node:load": actions.load, "node:stop": actions.stop,
  })[id]?.();
}
on("setting", () => commit());
