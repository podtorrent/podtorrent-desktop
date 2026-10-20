// Swarm: the living network. Stat strip, graph (or calmer grid), coverage at a glance.
import { h, text, fmt, reconcile, cls } from "../dom.js";
import { state, settings, setSetting, swarmStats, models, nodeList, nodeState, nodeStateLabel, on } from "../store.js";
import { stat, segmented, empty, button, sparkline, skeleton } from "../ui.js";
import { icon } from "../icons.js";
import { swarmGraph, PLAYBACK } from "../viz/graph.js";
import { modelStrip } from "../viz/strip.js";
import { go, actions, setDemo } from "../actions.js";
import { peerSheet } from "./peers.js";
import { videoSwarmStatus } from "../engine.js";
import { videoFlow, activeStage } from "../viz/videoflow.js";

/** Video roles of every machine (encoder layers, renders or not) and the route a video job takes. */
function videoCard() {
  const flow = h("div"), roles = h("div.vroles"), reason = h("div.small.muted"), jobs = h("div.small.muted");
  const el = h("button.card.cov-card", { type: "button", onclick: () => go("video") },
    h("div.row", h("span.caps", "Video"), h("b", "MiniMax-H3"), h("span.spacer"), h("span.small.faint", "Prompt encoder on the swarm, video on a GPU machine")),
    roles, flow, reason, jobs);
  let key = "";
  function paint(v) {
    el.hidden = !v || !v.machines?.some(m => m.encoder.length || m.video);
    if (el.hidden) return;
    const job = (v.jobs || []).find(j => !["done", "failed", "cancelled"].includes(j.state));
    const k = JSON.stringify([v.machines, v.route, v.reason, job]);
    if (k === key) return;
    key = k;
    roles.replaceChildren(...v.machines.filter(m => m.encoder.length || m.video || m.video_why).flatMap(m => [
      h("b.ellipsis", m.me ? `${m.name} (you)` : m.name),
      h("div.lbar", { role: "img", "aria-label": `Encoder layers on ${m.name}` }, ...Array.from({ length: 50 }, (_, i) =>
        h(`i${m.encoder.some(([lo, hi]) => lo <= i && i < hi) ? ".srv" : ""}`))),
      h("span.small", m.encoder.length ? `Encoder ${m.encoder.map(([lo, hi]) => fmt.layers(lo, hi)).join(", ")}` : h("span.faint", "No encoder layers")),
      h(`span.small${m.video ? "" : ".faint"}`, { title: m.video_why || "" }, m.video ? "Renders video" : m.video_why ? "Can't render" : "–"),
    ]));
    flow.replaceChildren(v.route ? videoFlow(v.route, job ? activeStage(job, v.route) : null) : "");
    text(reason, v.route ? "" : v.reason);
    text(jobs, job ? `Your video: ${job.detail || job.state}` : "");
  }
  return { el, paint };
}

export default {
  title: "Swarm",
  subtitle: s => {
    const st = swarmStats(s);
    return st.total ? `${st.online} of ${st.total} peers online` : "";
  },
  mount(root) {
    const S = {
      peers: stat({ label: "Peers online", icon: "peers", format: v => fmt.int(v) }),
      mem: stat({ label: "Pooled memory", icon: "memory", unit: "GB", format: v => fmt.fixed(v, v >= 100 ? 0 : 1), tip: "Unified memory across online peers" }),
      tps: stat({ label: "Swarm throughput", icon: "bolt", unit: "tok/s", format: v => fmt.fixed(v), color: "var(--c-active)", spark: true }),
      ttft: stat({ label: "Median first token", icon: "clock", unit: "", format: v => v >= 1000 ? (v / 1000).toFixed(2) : Math.round(v), tip: "Median time to first token, this session" }),
      cov: stat({ label: "Models covered", icon: "models", format: v => fmt.int(v), tip: "Models whose every layer is loaded on some peer" }),
    };
    const layout = segmented([{ value: "graph", icon: "graph", label: "Graph" }, { value: "grid", icon: "grid", label: "Grid" }], settings.swarmLayout, v => setSetting("swarmLayout", v), "Layout");
    const graph = swarmGraph();
    const grid = h("div.peer-grid");
    const legend = h("div.legend",
      ...[["serving", "Serving"], ["active", "Computing"], ["degraded", "Degraded"], ["gap", "Offline"]].map(([k, l]) => h("span", h(`i.${k}`), l)),
      h("span", h("i.you"), "You"),
      h("span.faint", { "data-tip": "Pulses replay real per-hop latency, slowed so they're visible" }, `Pulses ${PLAYBACK}× slower than real time`));
    const stage = h("div.stage", graph.el, grid);
    const note = h("div.stage-note.small");
    const strip = modelStrip({ compact: true });
    const video = videoCard();
    let vAsk = 0;
    const covTitle = h("b"), covVerdict = h("span.badge"), covReason = h("span.small.muted");
    const covCard = h("button.card.cov-card", { type: "button", onclick: () => go("models") },
      h("div.row", h("span.caps", "Model coverage"), covTitle, h("span.spacer"), covVerdict), strip, covReason);
    const ctaBody = h("p");
    const cta = h("div.join-cta",
      h("div.join-cta-art", icon("swarm")),
      h("div.col.join-cta-text", h("h2", "You're watching, not in the swarm yet"), ctaBody),
      button("Start My Node", { variant: "primary", size: "xl", icon: "play", onclick: actions.startHost }));
    const offBadge = h("span.badge.dot.neutral", "This machine is offline");
    const body = h("div.page",
      h("div.grid-stats", Object.values(S)),
      h("div.card.net-card", h("div.card-h", h("h2", "Network"), offBadge, h("span.spacer"), layout), cta, stage, h("div.card-f", legend, note)),
      covCard, video.el);
    const emptyBox = h("div.page");
    root.append(body, emptyBox);
    root.addEventListener("peer", e => peerSheet(e.detail));

    let emptyKey = "";
    function renderEmpty(s) {
      const key = s.engine.phase + "|" + s.engine.error;
      if (key === emptyKey) { const l = emptyBox.querySelector(".mono"); if (l) text(l, s.engine.line || "Starting engine…"); return; }
      emptyKey = key;
      if (s.engine.phase === "starting") {
        emptyBox.replaceChildren(h("div.grid-stats", Object.keys(S).map(() => h("div.stat", skeleton(90, 12), h("div", { style: { height: "10px" } }), skeleton(60, 26)))),
          h("div.card", { style: { height: "420px", display: "grid", placeItems: "center" } }, h("div.col", { style: { alignItems: "center" } }, h("div.progress.indeterminate", { style: { width: "220px" } }, h("i")), h("div.small.muted.mono", s.engine.line || "Starting engine…"))));
        return;
      }
      emptyBox.replaceChildren(empty({
        icon: "swarm", title: "This machine isn't in a swarm yet",
        body: s.engine.error ? `The engine stopped: ${s.engine.error.split("\n").pop().slice(0, 160)}` : "Start your node to join the global swarm. Every machine is an equal peer: it finds the others automatically, connects to them directly, serves a slice of the model and can chat with it. Or explore a simulated swarm first.",
        tone: s.engine.error ? "gap" : "",
        actions: [button("Start My Node", { variant: "primary", icon: "play", onclick: actions.startHost }), button("Explore Demo", { variant: "ghost", icon: "sparkle", onclick: () => setDemo(true) })],
      }));
    }

    function renderGrid(s) {
      reconcile(grid, nodeList(s), n => n.name, n => {
        const el = h("button.peer-tile.card", { type: "button", onclick: () => peerSheet(n.name) },
          h("div.row", h("span.statedot"), h("b.name.ellipsis"), h("span.badge.you", "You"), h("span.spacer"), h("span.small.faint.role")),
          h("div.small.muted.chip.ellipsis"),
          h("div.range", h("i")),
          h("div.row.small", h("span.faint", "Layers"), h("span.spacer"), h("span.num.layers")),
          h("div.row.small", h("span.faint", "Memory"), h("span.spacer"), h("span.num.mem")),
          h("div.progress", h("i")),
          h("div.row.small", h("span.faint", "Latency"), h("span.spacer"), h("span.num.rtt")),
          sparkline("tile-spark", 200, 28));
        return el;
      }, (el, n) => {
        const st = nodeState(n, s), me = n.name === s.self, total = s.layerMap?.total_layers || s.hostInfo?.n_layers || 48;
        el.querySelector(".statedot").className = `statedot ${st === "idle" ? "off" : st}`;
        text(el.querySelector(".name"), n.name);
        el.querySelector(".badge.you").hidden = !me;
        cls(el, "mine", me);
        text(el.querySelector(".role"), `${n.role === "host" ? "You" : "Peer"} · ${nodeStateLabel(n, s)}`);
        text(el.querySelector(".chip"), n.chip || "Unknown chip");
        const r = el.querySelector(".range i");
        if (n.lo != null) { r.style.left = (n.lo / total) * 100 + "%"; r.style.width = ((n.hi - n.lo) / total) * 100 + "%"; r.className = st; } else r.style.width = 0;
        text(el.querySelector(".layers"), n.lo != null ? fmt.layers(n.lo, n.hi) : "–");
        const m = n.mem;
        text(el.querySelector(".mem"), m ? `${fmt.gb(m.active_gb)} / ${fmt.gb(m.total_gb)}` : "–");
        el.querySelector(".progress i").style.width = m ? Math.min(100, (100 * m.active_gb) / m.total_gb) + "%" : 0;
        text(el.querySelector(".rtt"), n.role === "host" ? "local" : n.rtt_ms != null ? fmt.ms(n.rtt_ms) : "–");
        const sp = el.querySelector(".tile-spark"); sp.style.color = `var(--c-${st === "idle" ? "net" : st})`; sp.set(n.tps.slice(-30));
      });
    }

    const offTheme = on("theme", () => graph.update());
    return {
      update(s) {
        const has = Object.keys(s.nodes).length > 0;
        body.hidden = !has; emptyBox.hidden = has;
        if (has) emptyKey = "";
        if (!has) { graph.setVisible(false); return renderEmpty(s); }
        const st = swarmStats(s);
        const preview = s.engine.phase === "stopped" && s.source === "live";
        cta.hidden = !preview; offBadge.hidden = !preview;
        if (preview) text(ctaBody, s.engine.error
          ? `The engine stopped: ${s.engine.error.split("\n").pop().slice(0, 160)}`
          : `${st.online} machine${st.online === 1 ? " is" : "s are"} online right now. Start your node to join them: it connects to each peer directly, serves a slice of the model and lets you chat with the whole swarm.`);
        S.peers.set(st.online, preview ? "online now" : st.total > st.online ? `${st.total - st.online} offline` : st.online === 1 ? "just this machine" : "all reachable");
        S.mem.set(st.pooled || null, st.online ? `across ${st.online} machine${st.online > 1 ? "s" : ""}` : "");
        S.tps.set(st.tps, s.chat.busy || st.tps ? "live, 5 s average" : "idle", s.tps.slice(-40));
        S.ttft.setUnit(st.ttft >= 1000 ? "s" : "ms");
        S.ttft.set(st.ttft, s.ttfts.length ? `${s.ttfts.length} repl${s.ttfts.length > 1 ? "ies" : "y"} this session` : "no replies yet");
        S.cov.set(st.models ? st.covered : null, st.models ? `of ${st.models} model${st.models > 1 ? "s" : ""}` : "");
        const g = settings.swarmLayout === "graph";
        layout.set(settings.swarmLayout);
        graph.el.hidden = !g; grid.hidden = g;
        graph.setVisible(g);
        if (g) graph.update(); else renderGrid(s);
        text(note, "");
        if (s.source === "live" && s.engine.phase === "running") {
          if (Date.now() - vAsk > 3000) { vAsk = Date.now(); videoSwarmStatus(); }
          video.paint(s.video.swarm);
        } else video.paint(null);
        const m = models(s)[0];
        covCard.hidden = !m;
        if (m) {
          strip.set(m);
          text(covTitle, m.name);
          covVerdict.className = `badge dot ${m.verdict.level === "planned" ? "neutral" : m.verdict.level === "info" ? "neutral" : m.verdict.level}`;
          text(covVerdict, m.verdict.title);
          text(covReason, m.verdict.reason);
        }
      },
      unmount() { graph.destroy(); offTheme(); },
    };
  },
};
