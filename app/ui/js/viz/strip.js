// Model Strip: one segment per layer (block), left to right. Color = coverage health, stacked
// bands = how many peers serve it, gaps glow, your range is outlined in your color.
import { h, text, fmt } from "../dom.js";
import { state, nodeState, stateLabel } from "../store.js";
import { popover } from "../ui.js";

let pop = null;
const LBL = { serving: "Serving", loading: "Loading", planned: "Not reachable from here", gap: "No peer" };

export function modelStrip({ compact = false } = {}) {
  const blocks = h("div.strip-blocks");
  const you = h("div.strip-you", h("span", "You"));
  const axis = compact ? null : h("div.strip-axis");
  const roles = compact ? null : h("div.strip-roles");
  const el = h(`div.strip${compact ? ".compact" : ""}`, { role: "img" }, h("div.strip-track", blocks, you), roles, axis);
  let n = 0, model = null, bandsN = 0;

  function build(m) {
    n = m.n_layers; bandsN = compact ? 1 : Math.min(4, m.redundancy);
    blocks.replaceChildren(...m.layers.map(L => {
      const b = h("div.blk", { "data-i": L.i });
      for (let k = 0; k < bandsN; k++) b.append(h("i"));
      return b;
    }));
    el.style.setProperty("--n", n);
    if (axis) {
      const step = n > 60 ? 10 : 8;
      const ticks = [];
      for (let i = 0; i < n; i += step) ticks.push(h("span", { style: { left: (i / n) * 100 + "%" } }, i));
      ticks.push(h("span.end", { style: { left: "100%" } }, n - 1));
      axis.replaceChildren(...ticks);
    }
  }

  el.set = (m, self = state.self) => {
    model = m;
    if (!m) return;
    if (m.n_layers !== n || (!compact && Math.min(4, m.redundancy) !== bandsN)) build(m);
    m.layers.forEach((L, i) => {
      const b = blocks.children[i];
      const cls = "blk " + L.state + (L.peers.some(p => p.node === self) ? " mine" : "");
      if (b.className !== cls) b.className = cls;
      [...b.children].forEach((band, k) => {
        const p = compact ? L : L.peers[k];
        const c = p ? p.state : "none";
        if (band.className !== c) band.className = c;
      });
    });
    // your outline
    const mine = m.assignments.filter(a => a.node === self);
    if (mine.length) {
      const lo = Math.min(...mine.map(a => a.lo)), hi = Math.max(...mine.map(a => a.hi));
      you.style.left = (lo / n) * 100 + "%"; you.style.width = ((hi - lo) / n) * 100 + "%"; you.hidden = false;
    } else you.hidden = true;
    if (roles) {
      const host = m.assignments.find(a => a.roles?.length);
      roles.replaceChildren(...m.assignments.filter((a, i, arr) => arr.findIndex(x => x.node === a.node && x.lo === a.lo) === i).map(a =>
        h("span", { style: { left: (a.lo / n) * 100 + "%", width: ((a.hi - a.lo) / n) * 100 + "%" }, class: a.node === self ? "self" : "" },
          h("b", a.node), ` ${fmt.layers(a.lo, a.hi)}`, a === host ? h("em", " + embed, head") : null)));
      // overlapping ranges stack on rows
      const rows = [];
      [...roles.children].forEach(sp => {
        const lo = parseFloat(sp.style.left), hi = lo + parseFloat(sp.style.width);
        let r = rows.findIndex(end => end <= lo + 0.01);
        if (r < 0) { r = rows.length; rows.push(0); }
        rows[r] = hi; sp.style.top = r * 18 + "px";
      });
      roles.style.height = Math.max(1, rows.length) * 18 + "px";
    }
    const v = m.verdict;
    el.setAttribute("aria-label", `${m.name}: ${v.title}. ${v.reason}`);
  };

  blocks.addEventListener("pointermove", e => {
    const b = e.target.closest(".blk");
    if (!b || !model) return pop?.hide();
    pop ||= popover();
    const L = model.layers[+b.dataset.i];
    const body = h("div",
      h("div.row", h("b", `Layer ${L.i}`), h("span.spacer"), h(`span.badge.${L.state === "planned" ? "neutral" : L.state === "loading" ? "degraded" : L.state}`, LBL[L.state])),
      h("div.small.muted", { style: { marginTop: "4px" } }, L.peers.length ? `${L.peers.length} peer${L.peers.length > 1 ? "s" : ""} · ${L.serving} reachable and serving` : "No peer serves this layer. The model can't run until one does."),
      L.peers.length ? h("div.col", { style: { marginTop: "8px", gap: "6px" } }, L.peers.map(p => {
        const nd = state.nodes[p.node];
        const st = nd ? nodeState(nd) : "gap";
        return h("div.row.small",
          h(`span.statedot.${st === "idle" ? "off" : st}`), h("span", p.node, p.node === state.self ? h("span.faint", " (you)") : null), h("span.spacer"),
          h("span.faint.num", nd?.rtt_ms != null ? fmt.ms(nd.rtt_ms) : p.node === state.self ? "local" : "–"),
          h("span.faint", " · ", stateLabel[st] || "–"));
      })) : null);
    pop.show(body, e.clientX, e.clientY);
  });
  blocks.addEventListener("pointerleave", () => pop?.hide());
  return el;
}
