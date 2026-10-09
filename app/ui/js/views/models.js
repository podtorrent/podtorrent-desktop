// Models: every model anyone in the swarm serves, and whether it can run from this Mac right now.
// Each card: verdict (Available · N routes / Partial · layers missing / Offline), a coverage bar
// with one cell per layer shaded by how many reachable peers serve it, the route this Mac would
// use, and the action that helps ("Serve missing layers" pre-fills the gap).
import { h, text, fmt, reconcile } from "../dom.js";
import { models, emit } from "../store.js";
import { empty, button } from "../ui.js";
import { icon } from "../icons.js";
import { modelStrip } from "../viz/strip.js";
import { actions, go } from "../actions.js";
import { loadModel } from "../engine.js";
import { openServe } from "../serve.js";

const VIcon = { serving: "check", gap: "alert", degraded: "download", planned: "layers", info: "info" };

/** "You → mac-a [0,16) → mac-c [16,48) → You" */
export function routeText(route, self) {
  if (!route?.length) return "";
  return ["You", ...route.map(([n, lo, hi]) => `${n === self ? "This Mac" : n} ${fmt.layers(lo, hi)}`), "You"].join(" → ");
}

function nextHint(m, s) {
  if (m.runnable) return { ok: true, text: `Runs from this Mac: ${routeText(m.route, s.self)}.` };
  const direct = s.swarm.peers.filter(p => p.peer_id !== s.swarm.selfId && p.link?.state === "direct");
  const gap = m.gaps[0];
  if (s.source === "live" && s.engine.phase !== "running") return { text: "Start your node to serve layers and use the swarm's models." };
  if (m.loading) return { text: "Slices are downloading or loading. The model becomes available when every layer has a reachable peer." };
  if (m.primary && !m.serving && direct.length && !s.loadRequested)
    return { text: `Quick start: this Mac serves the first half and asks ${direct[0].name || "a connected Mac"} to serve the rest.`, action: button("Load model", { variant: "primary", icon: "download", kbd: "⇧⌘L", onclick: () => loadModel() }) };
  if (gap) return { text: `Layers ${fmt.layers(gap[0], gap[1])} have no reachable peer. Serve them on this Mac${direct.length ? " or on a connected Mac" : ""}.`, action: button("Serve missing layers", { variant: "primary", icon: "download", onclick: () => openServe({ model: m.model, lo: gap[0], hi: gap[1] }) }) };
  return { text: m.verdict.reason };
}

export default {
  title: "Models",
  subtitle: s => { const ms = models(s); return ms.length ? `${ms.filter(m => m.runnable).length} of ${ms.length} available` : ""; },
  toolbar() { return [button("Serve layers…", { icon: "download", size: "sm", onclick: () => openServe() })]; },
  mount(root) {
    const list = h("div.col", { style: { gap: "16px" } });
    const intro = h("div.page-h", h("div", h("h1", "Models"),
      h("p", "Every model someone in the swarm serves. A model is split into layers; it runs when every layer has a peer this Mac can reach. Peers can serve any range, of any model, and more peers per layer means a failure just re-routes.")));
    const page = h("div.page", intro, list);
    const emptyBox = h("div.page");
    root.append(page, emptyBox);
    let emptyKey = "";

    function makeCard() {
      const strip = modelStrip();
      const el = h("section.card.model-card",
        h("div.model-h",
          h("div.verdict-ic"),
          h("div.grow", h("div.row", h("h2.mname"), h("span.faint.small.repo")), h("div.vt"), h("div.small.muted.vr")),
          h("div.mact")),
        h("div.strip-wrap", strip,
          h("div.legend.small",
            ...[["serving", "Serving"], ["loading", "Loading"], ["planned", "Not reachable from here"], ["gap", "No peer"]].map(([k, l]) => h("span", h(`i.${k}`), l)),
            h("span", h("i.you-o"), "This Mac"), h("span.spacer"), h("span.faint.redund"))),
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
      text(el.querySelector(".repo"), `${m.repo} · ${m.n_layers} layers${m.primary ? " · default" : ""}`);
      const vt = el.querySelector(".vt"); vt.className = `vt ${v.level}`; text(vt, v.title);
      text(el.querySelector(".vr"), v.reason);
      const peers = new Set(m.assignments.map(a => a.node)).size;
      text(el.querySelector(".redund"), `${peers} peer${peers === 1 ? "" : "s"} · up to ${m.redundancy} per layer`);
      const act = el.querySelector(".mact");
      const k = `${m.runnable}|${m.gaps.map(String)}`;
      if (act.dataset.k !== k) {
        act.dataset.k = k;
        const gap = m.gaps[0];
        act.replaceChildren(...[
          m.runnable ? button("Open Playground", { icon: "playground", onclick: () => { emit("pick-model", m.model); go("playground"); } }) : null,
          gap ? button("Serve missing layers", { icon: "download", onclick: () => openServe({ model: m.model, lo: gap[0], hi: gap[1] }) })
            : button("Serve layers…", { icon: "download", onclick: () => openServe({ model: m.model, lo: 0, hi: m.n_layers }) })].filter(Boolean));
      }
      const rw = el.querySelector(".ready-wrap");
      const hint = nextHint(m, s);
      const key = hint.text + !!hint.action;
      if (rw.dataset.k === key) return;
      rw.dataset.k = key;
      rw.replaceChildren(h(`div.next${hint.ok ? ".ok" : ""}`, icon(hint.ok ? "check" : "arrowright"), h("span.grow", hint.text), hint.action || null));
    }

    return {
      update(s) {
        const ms = models(s);
        page.hidden = !ms.length; emptyBox.hidden = !!ms.length;
        if (!ms.length) {
          const k = s.engine.phase + s.source;
          if (k !== emptyKey) {
            emptyKey = k;
            emptyBox.replaceChildren(s.engine.phase === "running"
              ? empty({ icon: "models", title: "No models in the swarm yet", body: "Nobody online serves a model yet. Serve some layers on this Mac to start one.", actions: [button("Serve layers…", { variant: "primary", icon: "download", onclick: () => openServe() })] })
              : empty({ icon: "models", title: "No models yet", body: "Start your node to see the models the swarm serves, and to serve layers yourself.", actions: [button("Start My Node", { variant: "primary", icon: "play", onclick: actions.startHost })] }));
          }
          return;
        }
        emptyKey = "";
        reconcile(list, ms, m => m.id, makeCard, (el, m) => fillCard(el, m, s));
      },
    };
  },
};
