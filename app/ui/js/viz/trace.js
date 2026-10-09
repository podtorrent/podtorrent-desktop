// Token Trace: traceroute for inference. A waterfall of the route one token took through the
// swarm: each hop's peer, layer range and milliseconds, from real token_timing events.
import { h, fmt, median } from "../dom.js";
import { state } from "../store.js";
import { routeOf } from "../route.js";

const layersOf = n => { const nd = state.nodes[n]; return nd?.lo != null ? fmt.layers(nd.lo, nd.hi) : null; };

/** Aggregate decode timings into a "typical token" (median per stage). */
function medianTiming(ts) {
  const dec = ts.filter(t => !t.prefill);
  if (!dec.length) return null;
  const st = dec[0].stages.map((s, i) => {
    const pick = k => median(dec.map(t => t.stages[i]?.[k]).filter(v => v != null));
    return { node: s.node, compute_ms: pick("compute_ms"), pre_ms: s.pre_ms != null ? pick("pre_ms") : undefined, post_ms: s.post_ms != null ? pick("post_ms") : undefined };
  });
  return { stages: st, prefill: false };
}

export function tokenTrace(msg) {
  const which = { v: "decode" };
  const body = h("div.trace-b");
  const tabs = h("div.trace-tabs");
  const el = h("div.trace", h("div.trace-h", h("b", "Token trace"), h("span.faint.small", "the route through the swarm"), h("span.spacer"), tabs), body);

  function render() {
    const prefill = msg.timings.find(t => t.prefill);
    const decode = medianTiming(msg.timings);
    const opts = [["prefill", "First token", prefill], ["decode", "Typical token", decode]].filter(o => o[2]);
    if (!opts.find(o => o[0] === which.v) && opts.length) which.v = opts[0][0];
    tabs.replaceChildren(...opts.map(([k, l]) => h("button.chip-btn", { type: "button", "aria-pressed": String(which.v === k), onclick: () => { which.v = k; render(); } }, l)));
    const t = opts.find(o => o[0] === which.v)?.[2];
    if (!t) { body.replaceChildren(h("div.faint.small", "No timing data for this reply.")); return; }
    const r = routeOf(t, n => { const x = t.route?.find(([nn]) => nn === n); return x ? fmt.layers(x[1], x[2]) : layersOf(n); });
    let at = 0;
    const total = r.total || 1;
    const rows = r.segments.map(s => {
      const left = (at / total) * 100, w = Math.max(0.6, (s.ms / total) * 100);
      at += s.ms;
      const me = s.node === state.self || (s.kind === "net" && false);
      return h(`div.tr-row.${s.kind}${s.approx ? ".approx" : ""}${me ? ".mine" : ""}`,
        h("div.tr-lbl.ellipsis", { title: s.label }, s.kind === "net" ? h("span.faint", "↝ ") : h("span.tr-dot"), s.label),
        h("div.tr-track", h("i", { style: { left: left + "%", width: w + "%" } })),
        h("div.tr-ms.num", (s.approx ? "≈" : "") + fmt.ms(s.ms)));
    });
    const d = msg.done;
    const net = r.segments.filter(s => s.kind === "net").reduce((a, s) => a + s.ms, 0);
    body.replaceChildren(
      h("div.tr-rows", rows),
      h("div.tr-foot",
        h("span", h("b.num", fmt.ms(r.total)), " this token"),
        h("span", h("b.num", fmt.pct(net / total)), " network"),
        d ? h("span", h("b.num", fmt.ms(d.ttft_ms)), " to first token") : null,
        d ? h("span", h("b.num", fmt.fixed(d.tok_s)), " tok/s") : null,
        t.bytes ? h("span", h("b.num", fmt.bytes(t.bytes)), " per hop") : null,
        r.segments.some(s => s.approx) ? h("span.faint", "≈ one-way time is half the measured round trip") : null));
  }
  el.update = render;
  render();
  return el;
}
