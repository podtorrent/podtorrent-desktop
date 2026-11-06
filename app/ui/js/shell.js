// Window shell: vibrancy sidebar with live badges, toolbar, banners, and view routing.
import { h, text, cls } from "./dom.js";
import { state, settings, subscribe, on, emit, swarmStats, models, selfNode, nodeState, nodeStateLabel, slicesLabel } from "./store.js";
import { icon } from "./icons.js";
import { kbd, button } from "./ui.js";
import { go, currentRoute, setDemo, actions, toggleSidebar } from "./actions.js";
import { fmt } from "./dom.js";
import { presets } from "./demo.js";
import swarm from "./views/swarm.js";
import modelsView from "./views/models.js";
import playground from "./views/playground.js";
import node from "./views/node.js";
import peers from "./views/peers.js";
import activity, { unseen } from "./views/activity.js";
import settingsView from "./views/settings.js";
import networkView, { networkState } from "./views/network.js";

const VIEWS = { swarm, models: modelsView, playground, node, peers, activity, network: networkView, settings: settingsView };
const NAV = [
  ["swarm", "Swarm", "swarm", "⌘1"], ["models", "Models", "models", "⌘2"], ["playground", "Playground", "playground", "⌘3"],
  ["node", "My Node", "node", "⌘4"], ["peers", "Peers", "peers", "⌘5"], ["activity", "Activity", "activity", "⌘6"],
];

export function mountShell() {
  const items = {};
  const navItem = ([id, label, ic, k]) => {
    const nb = h("span.nb"), el = h("button.nav-item", { type: "button", onclick: () => go(id) }, icon(ic), h("span", label), nb, h("span.nk", k));
    items[id] = { el, nb };
    return el;
  };
  const nodeCard = h("button.node-card", { type: "button", onclick: () => go("node") },
    h("div.top", h("span.you-chip", icon("person")), h("span.nc-name.ellipsis.grow"), h("span.statedot")),
    h("div.bot", h("span", h("b.nc-layers"), " layers"), h("span", h("b.nc-tps"), " tok/s")));
  const demoPill = h("button.badge.demo.demo-pill", { type: "button", "data-tip": "Demo Mode · ⌥⌘D to turn off", onclick: () => setDemo(false) }, "Demo");
  const sidebar = h("aside.sidebar", { "aria-label": "Sidebar" },
    h("div.sidebar-top", { "data-tauri-drag-region": "" }, demoPill),
    h("div.brand", { "data-tauri-drag-region": "" }, h("div.logo", h("img", { src: "favicon.svg", alt: "" })), h("div", h("b", "PodTorrent"), h("div.sub", "Many machines, one swarm"))),
    h("nav.nav", NAV.map(navItem), h("div.sect", " "), navItem(["network", "Network", "link", ""]), navItem(["settings", "Settings", "settings", "⌘,"])),
    nodeCard);

  const title = h("h1"), subtitle = h("span.muted");
  const viewActions = h("div.row");
  const paletteBtn = h("button.palette-btn", { type: "button", onclick: () => emit("palette"), "aria-label": "Command palette" }, icon("search"), h("span", "Search or run a command"), kbd("⌘ K"));
  const sideBtn = h("button.icon-btn", { type: "button", "aria-label": "Toggle sidebar", "data-tip": "Toggle sidebar  ⌘\\", onclick: toggleSidebar }, icon("sidebar"));
  const toolbar = h("header.toolbar", { "data-tauri-drag-region": "" }, sideBtn, h("div.title", { "data-tauri-drag-region": "" }, title, subtitle), h("div.actions", viewActions, paletteBtn));
  const banners = h("div.banners");
  const viewEl = h("div.view", { role: "main", tabIndex: -1 });
  const content = h("main.content", toolbar, banners, viewEl);
  const shell = h("div.shell", sidebar, content);
  document.getElementById("app").replaceChildren(shell);

  // ---- routing ----
  let cur = null, curId = null;
  function mount(id) {
    if (curId === id && cur) return;
    cur?.unmount?.();
    viewEl.replaceChildren();
    const page = h("div.view-in");
    viewEl.append(page);
    curId = id;
    cur = VIEWS[id].mount(page);
    viewActions.replaceChildren(...(VIEWS[id].toolbar?.() || []));
    viewEl.scrollTop = 0;
    Object.entries(items).forEach(([k, v]) => k === id ? v.el.setAttribute("aria-current", "page") : v.el.removeAttribute("aria-current"));
    render(state);
    if (id === "playground") requestAnimationFrame(() => cur?.focus?.());
  }
  on("route", mount);

  // ---- per-frame render ----
  let bannerKey = "";
  function render(s) {
    cls(shell, "collapsed", settings.sidebarCollapsed);
    const V = VIEWS[curId];
    text(title, V.title);
    text(subtitle, V.subtitle?.(s) || "");
    cur?.update?.(s);
    // sidebar badges
    const st = swarmStats(s), ms = models(s), m = ms[0];
    const me = selfNode(s), meSt = me ? nodeState(me, s) : null;
    // One badge per row, flush with the right edge: a label (tinted by the state, if any) or a dot.
    const setNb = (id, label = "", cls = "") => {
      const html = label !== "" ? `<span class="nbl ${cls}">${label}</span>` : cls ? `<span class="statedot ${cls}"></span>` : "";
      if (items[id].nb.innerHTML !== html) items[id].nb.innerHTML = html;
    };
    setNb("swarm", st.total ? st.online : "", st.online < st.total ? "degraded" : "");
    setNb("models", "", m ? (m.runnable ? "serving" : m.verdict.level === "gap" ? "gap" : m.verdict.level === "degraded" ? "degraded" : "off") : "");
    const vj = Object.values(s.video.jobs);
    setNb("playground", "", s.chat.busy || vj.some(j => !["done", "failed", "cancelled"].includes(j.state)) ? "active" : "");
    setNb("node", "", s.engine.phase === "starting" ? "active" : me ? (meSt === "idle" ? "off" : meSt) : s.engine.error ? "gap" : "");
    setNb("peers", st.total ? String(st.total) : "");
    const fresh = curId === "activity" ? 0 : s.feed.length - unseen.at;
    setNb("activity", fresh > 0 ? String(Math.min(99, fresh)) : "");
    const net = networkState();
    setNb("network", net === "online" ? "Online" : "", net === "online" ? "serving" : net === "connecting" ? "degraded" : "");
    // node card
    nodeCard.hidden = !s.role && s.source !== "demo";
    if (!nodeCard.hidden) {
      text(nodeCard.querySelector(".nc-name"), me ? `${me.name} · peer` : s.engine.phase === "starting" ? "Starting…" : s.role || "");
      nodeCard.querySelector(".statedot").className = `statedot ${me ? (meSt === "idle" ? "off" : meSt) : "active"}`;
      const nl = s.slices.filter(x => x.loaded).reduce((a, x) => a + x.hi - x.lo, 0);
      text(nodeCard.querySelector(".nc-layers"), nl ? String(nl) : "–");
      nodeCard.querySelector(".nc-layers").dataset.tip = s.slices.length ? slicesLabel(s.slices) : "Serving nothing";
      const tps = me?.tps.slice(-5) || [];
      text(nodeCard.querySelector(".nc-tps"), tps.length ? fmt.fixed(tps.reduce((a, b) => a + b, 0) / tps.length) : "0.0");
      nodeCard.setAttribute("aria-label", me ? `This machine: ${nodeStateLabel(me, s)}` : "This machine");
    }
    demoPill.hidden = s.source !== "demo";
    // banners: demo, offline, engine trouble
    const b = [];
    if (s.source === "demo") b.push(["demo", "sparkle", `Demo Mode · ${presets[settings.demoPreset]?.label}. Numbers are simulated.`, ["Turn off", () => setDemo(false)]]);
    else if (s.engine.phase === "unreachable") b.push(["gap", "alert", "The engine isn't responding.", ["Restart", () => actions.startHost()]]);
    else if (s.role && s.conn === "down") b.push(["degraded", "wifioff", "Disconnected from the engine. Reconnecting…", null]);
    const key = JSON.stringify(b.map(x => x.slice(0, 3)));
    if (key !== bannerKey) {
      bannerKey = key;
      banners.replaceChildren(...b.map(([tone, ic, msg, act]) => h(`div.banner.${tone}`, { role: "status" }, icon(ic), h("span", msg), act ? button(act[0], { size: "sm", onclick: act[1] }) : null)));
    }
  }
  subscribe(render);
  mount(currentRoute());
}
