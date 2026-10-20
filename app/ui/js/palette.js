// ⌘K command palette: navigate, node actions, models, peers, Demo Mode, copy, logs, theme.
import { h, text, fmt } from "./dom.js";
import { openServe } from "./serve.js";
import { state, settings, setSetting, emit, nodeList, models, nodeSlices, slicesLabel } from "./store.js";
import { icon } from "./icons.js";
import { kbd } from "./ui.js";
import { go, actions, toggleDemo, setDemoPreset, copyNodeId, toggleSidebar, toggleInspector, toggleSwarmLayout } from "./actions.js";
import { presets } from "./demo.js";
import { peerSheet } from "./views/peers.js";

function commands() {
  const live = state.source === "live", running = state.engine.phase !== "stopped";
  const c = [
    ...[["swarm", "Swarm", "⌘1"], ["models", "Models", "⌘2"], ["playground", "Playground", "⌘3"], ["node", "My Node", "⌘4"], ["peers", "Peers", "⌘5"], ["activity", "Activity", "⌘6"], ["video", "Video", "⌘7"], ["settings", "Settings", "⌘,"]]
      .map(([id, t, k]) => ({ group: "Go to", title: t, icon: id === "node" ? "node" : id, kbd: k, run: () => go(id) })),
    { group: "Node", title: "Start My Node", icon: "play", kbd: "⇧⌘H", run: actions.startHost, hide: !live || running },
    { group: "Node", title: "Load model", icon: "download", kbd: "⇧⌘L", run: actions.load, hide: state.ready || (live && !running) },
    { group: "Node", title: "Serve text-model layers…", icon: "download", run: () => openServe(), hide: live && !running, keywords: "slice model add text" },
    { group: "Node", title: "Stop node", icon: "stop", kbd: "⇧⌘.", run: actions.stop, hide: !live || !running },
    { group: "Node", title: "Copy peer ID", icon: "copy", run: copyNodeId, hide: !running && live, keywords: "id share" },
    { group: "Node", title: "Open raw logs", icon: "logs", run: () => { go("activity"); }, keywords: "engine.log debug" },
    { group: "View", title: settings.sidebarCollapsed ? "Show sidebar" : "Hide sidebar", icon: "sidebar", kbd: "⌘\\", run: toggleSidebar },
    { group: "View", title: "Toggle inspector", icon: "sliders", kbd: "⌘I", run: toggleInspector },
    { group: "View", title: settings.swarmLayout === "graph" ? "Swarm: grid view" : "Swarm: graph view", icon: settings.swarmLayout === "graph" ? "grid" : "graph", kbd: "⌘G", run: toggleSwarmLayout },
    { group: "View", title: "Theme: System", icon: "settings", run: () => setSetting("theme", "system") },
    { group: "View", title: "Theme: Light", icon: "sun", run: () => setSetting("theme", "light") },
    { group: "View", title: "Theme: Dark", icon: "moon", run: () => setSetting("theme", "dark") },
    { group: "View", title: settings.reduceEffects ? "Restore visual effects" : "Reduce visual effects", icon: "sparkle", run: () => setSetting("reduceEffects", !settings.reduceEffects) },
    { group: "Developer", title: state.source === "demo" ? "Turn off Demo Mode" : "Turn on Demo Mode", icon: "sparkle", kbd: "⌥⌘D", run: toggleDemo },
    ...Object.entries(presets).map(([k, p]) => ({ group: "Developer", title: `Demo preset: ${p.label}`, sub: p.hint, icon: "sparkle", run: () => { setDemoPreset(k); if (state.source !== "demo") toggleDemo(); } })),
    { group: "Help", title: "Keyboard shortcuts", icon: "keyboard", kbd: "?", run: () => emit("shortcuts") },
    { group: "Help", title: "Welcome tour", icon: "info", run: () => emit("onboarding") },
  ];
  for (const m of models()) c.push({ group: "Models", title: m.name, sub: m.verdict.title + " · " + m.verdict.reason, icon: "models", run: () => go(m.runnable ? "playground" : "models") });
  for (const n of nodeList(state)) c.push({ group: "Peers", title: n.name, sub: `${n.name === state.self ? "you" : "peer"} · ${slicesLabel(nodeSlices(n.name), "serves nothing")}${n.chip ? " · " + n.chip : ""}`, icon: n.name === state.self ? "person" : "node", run: () => { go("peers"); peerSheet(n.name); } });
  return c.filter(x => !x.hide);
}

function score(q, s) {
  if (!q) return 1;
  s = s.toLowerCase();
  const i = s.indexOf(q);
  if (i >= 0) return 100 - i;
  let j = 0, pts = 0;
  for (const ch of s) if (ch === q[j]) { j++; pts++; }
  return j === q.length ? pts : 0;
}

let open = null;
export function openPalette() {
  if (open) return open.close();
  const prev = document.activeElement;
  const input = h("input.pal-input", { placeholder: "Type a command or search…", "aria-label": "Command", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-list", autocomplete: "off", spellcheck: false });
  const list = h("div.pal-list", { id: "pal-list", role: "listbox" });
  const scrim = h("div.scrim.light", { onclick: () => close() });
  const box = h("div.palette.glass", { role: "dialog", "aria-label": "Command palette" }, h("div.pal-h", icon("search"), input, kbd("esc")), list);
  document.body.append(scrim, box);
  requestAnimationFrame(() => { scrim.classList.add("show"); box.classList.add("show"); });
  input.focus();
  let sel = 0, shown = [];
  const all = commands();
  function paint() {
    const q = input.value.trim().toLowerCase();
    shown = all.map(c => ({ c, s: Math.max(score(q, c.title), score(q, `${c.group} ${c.title} ${c.keywords || ""} ${c.sub || ""}`) * 0.5) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.c);
    if (!q) shown = all;
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    const out = []; let g = null;
    shown.forEach((c, i) => {
      if (!q && c.group !== g) { g = c.group; out.push(h("div.pal-group", g)); }
      out.push(h("div.pal-item", { role: "option", id: "pal-" + i, "aria-selected": String(i === sel), onclick: () => run(i), onpointermove: () => { if (sel !== i) { sel = i; mark(); } } },
        icon(c.icon), h("div.grow", h("div.ellipsis", c.title), c.sub ? h("div.pal-sub.ellipsis", c.sub) : null), c.kbd ? kbd(c.kbd.split("")) : null));
    });
    if (!shown.length) out.push(h("div.pal-empty", `No commands match "${input.value}"`));
    list.replaceChildren(...out);
    mark();
  }
  function mark() {
    list.querySelectorAll(".pal-item").forEach(el => el.setAttribute("aria-selected", String(el.id === "pal-" + sel)));
    const el = list.querySelector(`#pal-${sel}`);
    el?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", el ? el.id : "");
  }
  function run(i) { const c = shown[i]; close(); c?.run(); }
  input.addEventListener("input", () => { sel = 0; paint(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { sel = Math.min(shown.length - 1, sel + 1); mark(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); mark(); e.preventDefault(); }
    else if (e.key === "Enter") { run(sel); e.preventDefault(); }
    else if (e.key === "Escape") { close(); e.preventDefault(); }
  });
  function close() {
    scrim.classList.remove("show"); box.classList.remove("show");
    setTimeout(() => { scrim.remove(); box.remove(); }, 160);
    open = null;
    if (document.activeElement === input || !document.activeElement || document.activeElement === document.body) prev?.focus?.();
  }
  paint();
  open = { close };
}
export const paletteOpen = () => !!open;
