// Models, in two tabs. Text: stats, what's on this machine, every model the swarm serves (one row
// each: ready or waiting for layers, with who serves / loads / can't be reached), and the Hugging Face
// finder. Video: this machine's share of the H3 prompt encoder, and whether it renders.
import { h, text, fmt, reconcile } from "../dom.js";
import { models, emit, settings, setSetting } from "../store.js";
import { empty, button, stat, segmented } from "../ui.js";
import { actions, go } from "../actions.js";
import { openServe } from "../serve.js";
import { catalogSection, secHead, localModels, openGet } from "../catalog.js";
import { videoSwarmStatus, encoderStatus, videoStatus } from "../engine.js";
import { encoderCard, renderCard } from "./video.js";

/** "You → mac-a [0,16) → mac-c [16,48) → You" */
export function routeText(route, self) {
  if (!route?.length) return "";
  return ["You", ...route.map(([n, lo, hi]) => `${n === self ? "This machine" : n} ${fmt.layers(lo, hi)}`), "You"].join(" → ");
}

const ranges = idx => {   // [0,1,2,7] -> [[0,3],[7,8]]
  const out = [];
  for (const i of idx) { if (out.length && out[out.length - 1][1] === i) out[out.length - 1][1]++; else out.push([i, i + 1]); }
  return out;
};
const list = rs => rs.map(([a, b]) => fmt.layers(a, b)).join(", ");

/** Status badge for a swarm model: ready, loading, or not ready (waiting for layers). */
function status(m) {
  const waiting = m.layers.filter(L => L.state === "gap").length;
  if (m.runnable) return ["Ready to use", "serving", `All ${m.n_layers} layers are served`];
  if (waiting) return ["Not ready", "gap", `Waiting for ${waiting} of ${m.n_layers} layers`];
  if (m.loading) return ["Loading", "degraded", `${m.loading} of ${m.n_layers} layers are loading`];
  return ["Not ready", "gap", "Its layers are on peers this machine can't reach yet"];
}

/** One small cell per layer, coloured by the best state any peer has for it. */
function stateBar(m) {
  const cls = { serving: ".srv", loading: ".load", planned: ".plan", gap: ".gap" };
  return h("div.lbar", { role: "img", "aria-label": `${m.n_layers} layers` }, ...m.layers.map(L => h(`i${cls[L.state]}`)));
}

/** Detail lines: who serves what, who is loading (with progress), what's unreachable, and what we wait for. */
function details(m, s) {
  const lines = [];
  const who = n => n === s.self ? `${n} (this machine)` : n;
  const by = st => m.assignments.filter(a => a.state === st);
  for (const a of by("serving")) lines.push(["srv", `Layers ${fmt.layers(a.lo, a.hi)}`, `served by ${who(a.node)}`]);
  for (const a of by("loading")) {
    const ld = s.nodes[a.node]?.load, pct = ld?.total ? ` · ${Math.round(100 * ld.done / ld.total)}%` : "";
    lines.push(["load", `Layers ${fmt.layers(a.lo, a.hi)}`, `${who(a.node)} is loading them${pct}`]);
  }
  for (const a of by("planned")) lines.push(["plan", `Layers ${fmt.layers(a.lo, a.hi)}`, `on ${a.node}, not reachable from here yet`]);
  const waiting = ranges(m.layers.filter(L => L.state === "gap").map(L => L.i));
  if (waiting.length) lines.push(["gap", `Layers ${list(waiting)}`, "waiting for a machine or peer to serve them"]);
  return h("div.sw-det", ...lines.map(([k, a, b]) => h("div", h(`i.${k}`), h("b", a), h("span", b))));
}

export default {
  title: "Models",
  subtitle: s => { const ms = models(s); return ms.length ? `${ms.filter(m => m.runnable).length} of ${ms.length} available` : ""; },
  mount(root) {
    const rows = h("div.cat-list.sw-list");
    const tab = () => settings.modelsTab === "video" ? "video" : "text";
    const tabs = segmented([{ value: "text", label: "Text", icon: "playground" }, { value: "video", label: "Video", icon: "video" }], tab(),
      v => setSetting("modelsTab", v), "Model kind");
    const blurb = h("p");
    const intro = h("div.page-h", h("div.grow", h("h1", "Models"), blurb), tabs);
    const S = {
      run: stat({ label: "Ready to use", icon: "check", format: v => fmt.int(v), color: "var(--c-serving)", tip: "Models every layer of which a reachable peer serves" }),
      lay: stat({ label: "Layers this machine serves", icon: "layers", format: v => fmt.int(v), color: "var(--c-you)" }),
      disk: stat({ label: "Downloaded", icon: "download", format: v => fmt.bytes(v), tip: "Model files on this machine" }),
      mem: stat({ label: "Free for models", icon: "memory", unit: "GB", format: v => fmt.fixed(v, 1), tip: "Memory left for more layers" }),
    };
    const stats = h("div.grid-stats.four", Object.values(S));
    const cat = catalogSection();
    const swarmH = secHead("peers", "Text models in the swarm");
    const emptyBox = h("div");
    const swarmCard = h("section.card.cat-card", swarmH, rows,
      h("div.lbar-key.small.faint", ...[["srv", "Served"], ["load", "Loading"], ["plan", "Not reachable from here"], ["gap", "Waiting for a peer"]].map(([c, l]) => h("span", h(`i.${c}`), l))));
    const textTab = h("div.col", { style: { gap: "inherit" } }, stats, cat.mine, swarmCard, emptyBox, cat.finder);
    // Video: where a job runs right now, then this machine's encoder layers and rendering.
    const vText = h("div.small.muted"), vRoute = h("div.small.faint");
    const videoCard = h("section.card.cat-card", secHead("video", "Video (MiniMax-H3)", h("span.wl-tag.video", "Video")),
      h("div.row.wrap", { style: { gap: "12px", padding: "0 16px 14px" } }, h("div.grow.col", { style: { gap: "4px" } }, vText, vRoute),
        button("Make a video", { size: "sm", icon: "video", onclick: () => go("playground", "video") })));
    const enc = encoderCard(), ren = renderCard();
    const vOff = empty({ icon: "video", title: "Node is stopped", body: "Start your node to pick this machine's prompt encoder layers and set up rendering.",
      actions: [button("Start My Node", { variant: "primary", icon: "play", onclick: actions.startHost })] });
    const V = {
      run: stat({ label: "Ready to make videos", icon: "check", format: v => v ? "Yes" : "No", color: "var(--c-serving)", tip: "Encoder layers and a GPU machine are reachable for a video job" }),
      lay: stat({ label: "Encoder layers this machine keeps", icon: "layers", format: v => fmt.int(v), color: "var(--c-you)" }),
      disk: stat({ label: "Downloaded", icon: "download", format: v => fmt.bytes(v), tip: "Prompt encoder files on this machine" }),
      mem: stat({ label: "Free for models", icon: "memory", unit: "GB", format: v => fmt.fixed(v, 1), tip: "Memory left for more layers" }),
    };
    const vStats = h("div.grid-stats.four", Object.values(V));
    const videoTab = h("div.col", { style: { gap: "inherit" } }, vStats, videoCard, enc.el, ren.el, vOff);
    let vAsk = 0, vAsked = false, slicesKey = null;
    const page = h("div.page", intro, textTab, videoTab);
    root.append(page);
    let emptyKey = "";

    function makeRow() {
      return h("div.list-row.sw-row",
        h("div.grow", h("div.t"), h("div.d"), h("div.lbar-wrap.bar"), h("div.det")),
        h("div.col.sw-side", h("span.badge"), h("div.act")));
    }
    function fillRow(el, m, s) {
      const [label, kind, sum] = status(m);
      el.querySelector(".t").replaceChildren(m.name, h("span.faint.small", " " + m.repo.split("/")[0]));
      text(el.querySelector(".d"), sum + (m.primary ? " · default model" : ""));
      const b = el.querySelector(".badge"); b.className = `badge ${kind} dot`; text(b, label);
      el.querySelector(".bar").replaceChildren(stateBar(m));
      el.querySelector(".det").replaceChildren(details(m, s));
      const act = el.querySelector(".act"), gap = m.gaps[0];
      const k = `${m.runnable}|${gap}`;
      if (act.dataset.k === k) return;
      act.dataset.k = k;
      act.replaceChildren(m.runnable
        ? button("Open Playground", { size: "sm", icon: "playground", onclick: () => { emit("pick-model", m.model); go("playground"); } })
        : gap ? button("Serve them yourself…", { size: "sm", variant: "ghost", icon: "download", tip: "Downloads those layers and keeps them in memory. The next step shows the size first.", onclick: () => openGet(m.model) })
        : "");
    }
    return {
      update(s) {
        const ms = models(s), t = tab();
        textTab.hidden = t !== "text"; videoTab.hidden = t !== "video";
        text(blurb, t === "text" ? "Each model is split into layers. It runs once every layer has a machine or peer serving it."
          : "A video job reads the prompt with encoder layers spread over machines, then one GPU machine renders it. Pick what this machine keeps.");
        if (t === "video") return paintVideo(s);
        cat.update(s);
        const loc = localModels();
        S.run.set(ms.filter(m => m.runnable).length, `of ${ms.length} in the swarm`);
        S.lay.set(s.slices.reduce((a, x) => a + (x.hi - x.lo), 0), `${new Set(s.slices.map(x => x.model)).size} model(s)`);
        S.disk.set(loc.length ? loc.reduce((a, m) => a + m.disk_bytes, 0) : null, `${loc.length} model folder(s)`);
        S.mem.set(s.memFree, "");
        swarmCard.hidden = !ms.length; emptyBox.hidden = !!ms.length;
        if (!ms.length) {
          const k = s.engine.phase + s.source;
          if (k !== emptyKey) {
            emptyKey = k;
            emptyBox.replaceChildren(s.engine.phase === "running"
              ? empty({ icon: "models", title: "No text models in the swarm yet", body: "Nobody online serves a text model yet. Serve some layers on this machine to start one.", actions: [button("Serve layers…", { variant: "primary", icon: "download", onclick: () => openServe() })] })
              : empty({ icon: "models", title: "Node is stopped", body: "You can still search Hugging Face below and check what fits this machine. Start your node to see what the swarm serves and to download or serve layers.", actions: [button("Start My Node", { variant: "primary", icon: "play", onclick: actions.startHost })] }));
          }
          return;
        }
        emptyKey = "";
        reconcile(rows, ms, m => m.id, makeRow, (el, m) => fillRow(el, m, s));
      },
    };
    function paintVideo(s) {
      const live = s.source === "live" && s.engine.phase === "running";
      const es = s.video.encoder?.slices || [], route = live ? s.video.swarm?.route : null;
      V.run.set(live ? !!route : null, route ? `renders on ${route.video}` : live ? "see below for what's missing" : "node is stopped");
      V.lay.set(es.reduce((a, x) => a + (x.hi - x.lo), 0), `of 50 · ${es.filter(x => x.loaded).length} slice(s) in memory`);
      V.disk.set(es.length ? es.reduce((a, x) => a + (x.bytes || 0), 0) : null, `${es.length} slice(s)`);
      V.mem.set(s.memFree, "");
      vOff.hidden = live; enc.el.hidden = ren.el.hidden = !live;
      if (!live) { vAsked = false; videoCard.hidden = true; return; }
      if (Date.now() - vAsk > 3000) { vAsk = Date.now(); videoSwarmStatus(); }
      // Text layers share the memory budget: ask again when they change.
      const sk = JSON.stringify(s.slices.map(x => [x.model, x.lo, x.hi, x.loaded]));
      if (!vAsked || sk !== slicesKey) { vAsked = true; slicesKey = sk; encoderStatus(); videoStatus(); }
      enc.paint(); ren.paint(s);
      const v = s.video.swarm, me = v?.machines?.find(m => m.me);
      videoCard.hidden = !me;
      if (me) {
        text(vText, [me.encoder.length ? `This machine keeps prompt encoder layers ${me.encoder.map(([a, b]) => fmt.layers(a, b)).join(", ")}.` : "This machine keeps no prompt encoder layers.",
          me.video ? "It renders video." : me.video_why ? `It can't render video: it ${me.video_why}.` : "It doesn't render video."].join(" "));
        text(vRoute, v.route ? `A video job right now: ${v.route.encoder.map(([n, a, b]) => `${n} ${fmt.layers(a, b)}`).join(" → ")} → renders on ${v.route.video}.` : v.reason);
      }
    }
  },
};
