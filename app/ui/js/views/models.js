// Models: can it run right now, and why not? Verdict first, then the full Model Strip,
// then the concrete steps (the old readiness checklist) and the one action that helps.
import { h, text, fmt, reconcile } from "../dom.js";
import { models } from "../store.js";
import { empty, button } from "../ui.js";
import { icon } from "../icons.js";
import { modelStrip } from "../viz/strip.js";
import { actions, go, copyNodeId } from "../actions.js";
import { loadModel, SPLIT } from "../engine.js";

const VIcon = { serving: "check", gap: "alert", degraded: "download", planned: "layers", info: "info" };

function steps(s, m) {
  const host = Object.values(s.nodes).find(n => n.role === "host");
  const w = Object.values(s.nodes).find(n => n.role === "worker");
  const wlost = w?.status === "lost";
  const loadStep = (title, n) => {
    if (!n?.load) return s.loadRequested ? { s: "active", b: "Starting", t: title, d: "Waiting for progress…" } : { s: "todo", b: "Not started", t: title, d: "Starts when you load the model" };
    const l = n.load;
    if (l.phase === "ready") return { s: "done", b: "Loaded", t: title, d: n.mem ? `In memory: ${fmt.gb(n.mem.active_gb)}` : "In memory" };
    if (l.phase === "error") return { s: "bad", b: "Error", t: title, d: s.lastError || "Load failed" };
    if (l.phase === "downloading") { const pc = l.total ? l.done / l.total : 0; return { s: "active", b: `Downloading ${fmt.pct(pc)}`, t: title, d: `${fmt.bytes(l.done)} of ${fmt.bytes(l.total)}`, pc }; }
    return { s: "active", b: "Loading", t: title, d: "Reading layers into memory" };
  };
  const k = m.assignments[1]?.lo ?? SPLIT;
  const started = s.loadRequested || s.ready || !!s.layerMap;
  return [
    { s: s.conn === "live" ? "done" : "bad", b: s.conn === "live" ? "Running" : "Offline", t: "Host engine", d: "Dashboard, tokenizer and the first layers" },
    w ? { s: wlost ? "bad" : "done", b: wlost ? "Unreachable" : "Joined", t: "Worker connected", d: `${w.name} · ${w.address}` } : { s: "wait", b: "Waiting", t: "Worker connected", d: "No worker has joined yet" },
    started ? { s: "done", b: "Requested", t: "Model load", d: `Split at layer ${k}` } : { s: "todo", b: w && !wlost ? "Ready" : "Blocked", t: "Model load", d: w && !wlost ? "Click Load model" : "Needs a worker first" },
    loadStep(`Host layers 0–${k - 1}`, host),
    w ? loadStep(`Worker layers ${k}–${m.n_layers - 1} (${w.name})`, w) : { s: "todo", b: "Blocked", t: `Worker layers ${k}–${m.n_layers - 1}`, d: "Needs a worker to join first" },
    { s: s.ready ? "done" : "todo", b: s.ready ? "Ready" : "Locked", t: "Playground", d: s.ready ? "Type a prompt" : "Unlocks when every layer is loaded" },
  ];
}

function nextHint(s) {
  const w = Object.values(s.nodes).find(n => n.role === "worker");
  if (s.ready) return { ok: true, text: "Ready. Open the Playground and type a prompt.", action: button("Open Playground", { variant: "primary", icon: "playground", onclick: () => go("playground") }) };
  if (s.lastError) return { text: "Error: " + s.lastError, action: button("Try again", { onclick: () => loadModel() }) };
  if (!w) {
    const a = s.hostInfo?.addresses?.length ? `${s.hostInfo.addresses[0]}:${s.hostInfo.port}` : "<this Mac's IP>:8000";
    return { text: `Waiting for a worker. On the other Mac, open PodTorrent → Join a Host, and enter ${a}.`, action: button("Copy address", { icon: "copy", onclick: copyNodeId }) };
  }
  if (w.status === "lost") return { text: "The worker is unreachable. Check Tailscale on both Macs and that PodTorrent is open on the worker." };
  if (!s.loadRequested && !s.layerMap) return { text: "Worker joined. Load the model: each Mac downloads (or reuses) its slice and loads it.", action: button("Load model", { variant: "primary", icon: "download", kbd: "⇧⌘L", onclick: () => loadModel() }) };
  return { text: "Loading. Each Mac downloads its own layers, then loads them. The Playground unlocks when both finish." };
}

export default {
  title: "Models",
  subtitle: s => { const ms = models(s); return ms.length ? `${ms.filter(m => m.runnable).length} of ${ms.length} ready to run` : ""; },
  mount(root) {
    const list = h("div.col", { style: { gap: "16px" } });
    const intro = h("div.page-h", h("div", h("h1", "Models"), h("p", "Blocks are slices of the model, one per transformer layer. Every block needs a peer for the model to run; more peers per block means faster and more reliable.")));
    const page = h("div.page", intro, list);
    const emptyBox = h("div.page");
    root.append(page, emptyBox);
    let emptyKey = "";

    function makeCard(m) {
      const strip = modelStrip();
      const el = h("section.card.model-card",
        h("div.model-h",
          h("div.verdict-ic"),
          h("div.grow", h("div.row", h("h2.mname"), h("span.faint.small.repo")), h("div.vt"), h("div.small.muted.vr")),
          h("div.mact")),
        h("div.strip-wrap", strip,
          h("div.legend.small",
            ...[["serving", "Serving"], ["loading", "Loading"], ["planned", "Assigned, not loaded"], ["gap", "No peer"]].map(([k, l]) => h("span", h(`i.${k}`), l)),
            h("span", h("i.you-o"), "Your range"), h("span.spacer"), h("span.faint.redund"))),
        h("div.ready-wrap"));
      el._strip = strip;
      return el;
    }
    function fillCard(el, m, s) {
      el._strip.set(m, s.self);
      const v = m.verdict;
      const ic = el.querySelector(".verdict-ic");
      ic.className = `verdict-ic ${v.level}`;
      if (ic.dataset.ic !== v.level) { ic.replaceChildren(icon(VIcon[v.level] || "info")); ic.dataset.ic = v.level; }
      text(el.querySelector(".mname"), m.name);
      text(el.querySelector(".repo"), `${m.repo} · ${m.n_layers} layers`);
      const vt = el.querySelector(".vt"); vt.className = `vt ${v.level}`; text(vt, v.title);
      text(el.querySelector(".vr"), v.reason);
      text(el.querySelector(".redund"), m.redundancy > 1 ? `Up to ${m.redundancy} peers per block` : "One peer per block (no redundancy)");
      const act = el.querySelector(".mact");
      const canLoad = s.source === "demo" ? !s.ready && !s.loadRequested && m.primary && Object.keys(s.nodes).length > 1 : m.primary && s.role === "host" && !s.ready && !s.loadRequested && !s.layerMap && Object.values(s.nodes).some(n => n.role === "worker" && n.status !== "lost");
      const k = `${canLoad}|${m.runnable}|${v.level}`;
      if (act.dataset.k !== k) {
        act.dataset.k = k;
        act.replaceChildren(...[
          m.runnable ? button("Open Playground", { icon: "playground", onclick: () => go("playground") }) : null,
          canLoad ? button("Load model", { variant: "primary", icon: "download", onclick: () => loadModel() }) : null,
          !m.runnable && m.missing.length && !m.primary ? button("Host missing blocks", { disabled: true, tip: "The engine assigns layers itself; hosting a chosen range isn't supported yet" }) : null].filter(Boolean));
      }
      // readiness checklist for the model this engine serves
      const rw = el.querySelector(".ready-wrap");
      const showSteps = m.primary && s.role === "host" && s.source === "live";
      const showHint = m.primary && (s.role === "host" || s.source === "demo") && !m.runnable;
      rw.hidden = !(showSteps || showHint);
      if (rw.hidden) return;
      const st = showSteps ? steps(s, m) : [];
      const hint = nextHint(s);
      const key = JSON.stringify(st) + hint.text;
      if (rw.dataset.k === key) return;
      rw.dataset.k = key;
      rw.replaceChildren(...[
        st.length ? h("div.steps", st.map(x => h(`div.step.${x.s}`, h("i", x.s === "done" ? icon("check") : x.s === "bad" ? icon("alert") : null), h("div.grow", h("div.t", x.t), h("div.d", x.d), x.pc != null ? h("div.progress", { style: { marginTop: "6px" } }, h("i", { style: { width: x.pc * 100 + "%" } })) : null), h(`span.badge.${{ done: "serving", active: "active", wait: "degraded", bad: "gap", todo: "neutral" }[x.s]}${x.s === "active" ? ".dot.pulse" : ""}`, x.b)))) : null,
        h(`div.next${hint.ok ? ".ok" : ""}`, icon(hint.ok ? "check" : "arrowright"), h("span.grow", hint.text), hint.action || null)].filter(Boolean));
    }

    return {
      update(s) {
        const ms = models(s);
        page.hidden = !ms.length; emptyBox.hidden = !!ms.length;
        if (!ms.length) {
          const k = s.engine.phase + s.role;
          if (k !== emptyKey) {
            emptyKey = k;
            emptyBox.replaceChildren(s.role === "worker"
              ? empty({ icon: "models", title: "Waiting for the host to assign layers", body: "The host decides which layers this Mac serves. They appear here once it loads the model." })
              : empty({ icon: "models", title: "No model yet", body: "Models come from the host's engine. Start as host to serve Qwen3-30B-A3B (4-bit) across two Macs.", actions: [button("Start as Host", { variant: "primary", icon: "play", onclick: actions.startHost }), button("Join a Host…", { onclick: actions.join })] }));
          }
          return;
        }
        emptyKey = "";
        reconcile(list, ms, m => m.id, makeCard, (el, m) => fillCard(el, m, s));
      },
    };
  },
};
