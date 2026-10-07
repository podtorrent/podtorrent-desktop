// Every user-facing action lives here so the sidebar, toolbar, menu bar, ⌘K palette and
// keyboard shortcuts all trigger the same thing.
import { state, settings, setSetting, emit, on, resetState, commit, selfNode } from "./store.js";
import * as engine from "./engine.js";
import { startDemo, stopDemo, presets } from "./demo.js";
import { h } from "./dom.js";
import { sheet, button, toast } from "./ui.js";

export const VIEWS = ["swarm", "models", "playground", "node", "peers", "activity", "settings"];
let route = "swarm";
export const currentRoute = () => route;
export function go(v) {
  if (!VIEWS.includes(v)) return;
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

export function joinDialog() {
  const input = h("input.input.mono", { placeholder: "100.x.y.z:8000", value: settings.hostAddr || "", autofocus: true, "aria-label": "Host address" });
  const go_ = () => { s.close(); engine.joinHost(input.value); };
  input.addEventListener("keydown", e => { if (e.key === "Enter") go_(); });
  const s = sheet({
    title: "Join a host",
    body: h("div.col", { style: { gap: "12px" } },
      h("p.muted", "Enter the host Mac's Tailscale address. This Mac will serve layers 24–47 for it."),
      h("div.field", h("label", "Host address"), input),
      h("p.small.faint", "Find it on the host: My Node shows its addresses, or run tailscale ip -4. Port 8000 is added if you leave it off.")),
    footer: [button("Cancel", { onclick: () => s.close() }), button("Join", { variant: "primary", onclick: go_ })],
  });
}

export async function copyText(t, what = "Copied") {
  try { await navigator.clipboard.writeText(t); toast(what, "serving"); } catch { toast("Couldn't copy", "gap"); }
}
export function copyNodeId() {
  const me = selfNode();
  const addr = state.role === "host" && state.hostInfo?.addresses?.length ? `${state.hostInfo.addresses[0]}:${state.hostInfo.port}` : me?.address;
  if (!me && !addr) return toast("No node running", "degraded");
  copyText(state.role === "host" && addr ? addr : me?.name || addr, state.role === "host" ? "Host address copied: give it to the worker" : "Node name copied");
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
