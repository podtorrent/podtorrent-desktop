// My Node: set up this Mac's role (replaces the old launcher), then show what it contributes,
// its health, and the controls the engine actually supports.
import { h, text, fmt, cls } from "../dom.js";
import { state, settings, setSetting, history, selfNode, nodeState, nodeStateLabel, shortModel } from "../store.js";
import { valuation, valuationError, bases, basis, usdFor, kwh, usd } from "../valuation.js";
import { button, armedButton, ticker } from "../ui.js";
import { icon } from "../icons.js";
import { areaChart, barChart } from "../viz/chart.js";
import { startHost, stopNode, unserveSlice, cancelDownload, encoderStatus, videoStatus } from "../engine.js";
import { isTauri } from "../native.js";

// CUDA 12.8 PyTorch needs this NVIDIA driver or newer (backend.MIN_NVIDIA_DRIVER).
const MIN_NVIDIA_DRIVER = 570;
const oldDriver = hl => parseInt(hl?.gpu?.driver) < MIN_NVIDIA_DRIVER;

function gauge() {
  const ns = "http://www.w3.org/2000/svg", R = 52, C = 2 * Math.PI * R;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 128 128"); svg.setAttribute("class", "gauge");
  const mk = (cl) => { const c = document.createElementNS(ns, "circle"); c.setAttribute("cx", 64); c.setAttribute("cy", 64); c.setAttribute("r", R); c.setAttribute("class", cl); svg.append(c); return c; };
  mk("g-track"); const fill = mk("g-fill");
  fill.style.strokeDasharray = `0 ${C}`;
  svg.set = f => { fill.style.strokeDasharray = `${Math.max(0, Math.min(1, f)) * C} ${C}`; };
  return svg;
}

const PRESS = { normal: ["Normal", "serving"], warn: ["Elevated", "degraded"], critical: ["Critical", "gap"], unknown: ["Unknown", "neutral"] };
// Status as a small dot and quiet text: color marks the state, not the whole label.
const DOT = { serving: "serving", active: "active", degraded: "degraded", gap: "gap" };
const status = (label, kind) => h("span.q-status", h(`span.statedot.${DOT[kind] || "off"}`), label);
function setStatus(el, label, kind) { el.replaceChildren(h(`span.statedot.${DOT[kind] || "off"}`), label); }
// Destructive actions stay neutral until armed; the confirm click is red.
const calm = { variant: "danger.calm" };

const THERM = { nominal: ["Nominal", "serving"], fair: ["Fair", "degraded"], serious: ["Serious", "gap"], critical: ["Critical", "gap"], unknown: ["Unknown", "neutral"] };

export default {
  title: "My Node",
  subtitle: s => s.role ? `Peer · ${s.engine.phase === "running" ? "contributing" : s.engine.phase}` : "Not contributing",
  mount(root) {
    // ---- setup (no engine) ----
    const startBtn = button("Start My Node", { variant: "primary", size: "lg", icon: "play", onclick: () => startHost() });
    // ---- stopped: the full dashboard below, led by a Start band ----
    const offBtn = button("Start My Node", { variant: "primary", size: "xl", icon: "play", onclick: () => startHost() });
    const offErr = h("div.next.err");
    const offline = h("div.col", offErr,
      h("section.card.join-cta",
        h("div.join-cta-art", icon("node")),
        h("div.col.join-cta-text", h("h2", "This machine isn't contributing yet"),
          h("p", "Your node is stopped. Start it to join the global swarm and serve layers. Everything below comes from this machine and your past sessions.")),
        h("div.col", { style: { gap: "8px", alignItems: "stretch" } }, offBtn)));
    const startCard = h("section.card.role-card",
      h("div.row", h("div.role-ic", icon("node")), h("div.grow", h("h2", "This machine as a peer"), h("div.small.muted", "Joins the global swarm, connects directly to the other machines, and serves whichever layers you choose, of any model. Only those layers are downloaded."))),
      h("div.row", { style: { marginTop: "14px" } }, startBtn));
    const machine = h("div.small.muted");
    const errBox = h("div.next.err");
    const setup = h("div.page",
      h("div.page-h", h("div", h("h1", "Share this machine"), h("p", "PodTorrent pools machines to run a model none of them can hold alone. Every machine runs the same node; each downloads only the slice it serves."), machine)),
      errBox,
      startCard,
      h("div.small.faint", "Machines on different networks connect directly over encrypted QUIC (UDP hole punching). The swarm is open: any PodTorrent peer can send work to this machine. "));

    // ---- starting ----
    const startLine = h("div.mono.small.muted");
    const startBar = h("div.progress.indeterminate", h("i"));
    const starting = h("div.page", h("div.card.pad.starting", h("div.row", h("span.statedot.active"), h("h2", "Starting your node…")), startBar, startLine,
      h("div.small.faint", "First run installs the Python environment (one time, needs internet). Output: ~/.podtorrent/engine.log"),
      h("div", button("Cancel", { onclick: () => stopNode() }))));

    // ---- running ----
    const g = gauge();
    const gv = h("b.num"), gs = h("span.small.faint");
    const chipEl = h("h1.hero-chip"), stateB = h("span.q-status");
    const hv = { layers: h("b.num"), today: h("b.num"), all: h("b.num"), req: h("b.num"), up: h("b.num") };
    const sliceList = h("div.col.slice-list");
    const freeNote = h("span.small.faint");
    // What this machine serves and the memory it takes. Serving more is done from Models.
    const memBar = h("div.mem-bar", { role: "img" }), memKey = h("div.mem-key.small");
    const videoList = h("div.col.slice-list"), memNote = h("div.small.faint");
    // Video shows only when this machine holds encoder layers or renders.
    const videoSect = h("div.col", { style: { gap: "6px" }, hidden: true }, h("b", "Video (MiniMax-H3)"), videoList);
    const slicesCard = h("section.card",
      h("div.card-h", h("h2", "What this machine contributes")),
      h("div.card-b.col", { style: { gap: "14px" } },
        h("div.col", { style: { gap: "6px" } }, h("div.row", h("span.caps", "Memory for models"), h("span.spacer"), freeNote), memBar, memKey, memNote),
        h("div.col", { style: { gap: "6px" } }, h("b", "Text models"), sliceList),
        videoSect));
    let askedVideo = false, slicesKey = "";
    function paintVideo(s) {
      const enc = s.video.encoder, st = s.video.status;
      const rows = [];
      for (const x of enc?.slices || []) rows.push(h("div.list-row",
        h("div.grow", h("div.t", h("b", "Prompt encoder"), ` · layers ${fmt.layers(x.lo, x.hi)}`, h("span.faint", ` (${x.hi - x.lo} of ${enc.n_layers})`)),
          h("div.d", `${fmt.bytes(x.bytes)} · ${enc.device === "cpu" ? "runs on the CPU from system RAM" : "runs on this machine's GPU"} · ${x.loaded ? "in memory" : "on disk, loads on the next video job"}`)),
        status(x.loaded ? "Ready" : "On disk", x.loaded ? "serving" : "neutral")));
      if (enc?.fetching && !enc.fetching.error) rows.push(h("div.list-row", h("div.grow", h("div.t", h("b", "Prompt encoder"), ` · layers ${fmt.layers(enc.fetching.lo, enc.fetching.hi)}`),
        h("div.d", `${fmt.bytes(enc.fetching.done)} of ${fmt.bytes(enc.fetching.total)}`)), status(`Downloading ${fmt.pct(enc.fetching.done / (enc.fetching.total || 1))}`, "active")));
      // Rendering only when this machine renders or is being set up to; otherwise it isn't its job.
      const settingUp = st?.setup?.phase === "install" || st?.setup?.phase === "models";
      if (st && (st.paused || st.render_ready || settingUp)) {
        const [label, kind, d] = st.paused ? ["Paused", "degraded", st.paused]
          : st.render_ready ? ["Renders", "serving", `Renders video jobs on ${st.gpu?.name || "this machine's GPU"}`]
          : ["Setting up", "active", "Getting this machine ready to render video."];
        rows.push(h("div.list-row", h("div.grow", h("div.t", h("b", "Rendering")), h("div.d", d)), status(label, kind)));
      }
      const k = JSON.stringify([enc?.slices, enc?.fetching, enc?.device, st?.render_ready, st?.paused, st?.capability, st?.setup?.phase]);
      if (videoList.dataset.k !== k) {
        videoList.dataset.k = k;
        videoList.replaceChildren(...rows);
      }
      videoSect.hidden = !rows.length;
      // memory bar: text layers | loaded video encoder layers (when they share the GPU budget) | free
      // Encoder layers count only while loaded: on disk they hold no memory (text first).
      const loadedEnc = (enc?.slices || []).filter(x => x.loaded).reduce((a, x) => a + x.bytes, 0) / 2 ** 30;
      const budget = enc?.mem_budget_gb, textGb = enc?.text_gb || 0, vidGb = enc?.shares_budget ? loadedEnc : 0;
      memBar.hidden = memKey.hidden = !budget;
      if (budget) {
        const free = Math.max(budget - textGb - vidGb, 0), pct = v => `${Math.min(100, 100 * v / budget)}%`;
        memBar.replaceChildren(h("i.text", { style: { width: pct(textGb) } }), h("i.video", { style: { width: pct(vidGb) } }));
        memBar.setAttribute("aria-label", `Memory budget ${fmt.gb(budget)}: text models ${fmt.gb(textGb)}, video ${fmt.gb(vidGb)}, ${fmt.gb(free)} free`);
        memKey.replaceChildren(h("span", h("i.text"), `Text models ${fmt.gb(textGb)}`), vidGb ? h("span", h("i.video"), `Video encoder ${fmt.gb(vidGb)}`) : null,
          h("span", h("i"), `Free ${fmt.gb(free)} of ${fmt.gb(budget)}`));
      }
      text(memNote, enc && !enc.shares_budget && enc.held_gb ? `Video encoder layers (${fmt.gb(enc.held_gb)}) run on the CPU from system RAM, outside this budget: the GPU is kept for rendering.` : "");
    }
    const tk = { today: ticker(hv.today, v => fmt.compact(v)), all: ticker(hv.all, v => fmt.compact(v)), req: ticker(hv.req, v => fmt.int(v)) };
    const hero = h("section.card.hero",
      h("div.hero-l", h("div.gauge-wrap", g, h("div.gauge-c", gv, gs))),
      h("div.hero-m",
        chipEl, h("div.row.hero-sub-row", stateB, h("span.small.muted.hero-sub")),
        h("div.hero-stats",
          h("div", h("span.caps", "Text layers served"), hv.layers),
          h("div", h("span.caps", "Tokens today"), hv.today),
          h("div", h("span.caps", "All time"), hv.all),
          h("div", h("span.caps", "Requests helped"), hv.req),
          h("div", h("span.caps", "Uptime"), hv.up))),
      h("div.hero-r",
        armedButton("Stop node", "Click again to stop", () => stopNode(), { ...calm, icon: "stop" })));
    const tiles = { press: h("div.tile"), therm: h("div.tile"), power: h("div.tile"), lp: h("div.tile"), gpu: h("div.tile") };
    const tile = (el, ic, label) => el.replaceChildren(h("div.row", icon(ic), h("span.small.muted", label)), h("div.tile-v"), h("div.small.faint.tile-s"));
    tile(tiles.press, "memory", "Memory pressure"); tile(tiles.therm, "thermo", "Thermal state"); tile(tiles.power, "plug", "Power"); tile(tiles.lp, "bolt", "Low Power Mode"); tile(tiles.gpu, "layers", "GPU load");
    tiles.gpu.hidden = true;
    const relabel = (el, label) => text(el.querySelector(".row .small"), label);
    const setTile = (el, v, kind, sub) => { const x = el.querySelector(".tile-v"); x.className = `tile-v ${kind}`; text(x, v); text(el.querySelector(".tile-s"), sub || " "); };
    const contrib = contributionCard(), payback = paybackCard();
    const tpsChart = areaChart({ color: "you", labels: ["2 min ago", "now"] });
    const dayChart = barChart({ color: "you" });
    const dayNote = h("span.small.faint");
    const running = h("div.page", offline, hero, slicesCard,
      h("div.tiles", Object.values(tiles)),
      h("div.two.contrib-row", contrib, payback),
      h("div.two",
        h("section.card", h("div.card-h", h("h2", "Tokens per second"), h("span.spacer"), h("span.small.faint", "this machine")), h("div.card-b", tpsChart)),
        h("section.card", h("div.card-h", h("h2", "Contribution history"), h("span.spacer"), dayNote), h("div.card-b", dayChart))));

    root.append(setup, starting, running);

    const PH = { checking: ["Checking", "degraded"], downloading: ["Downloading", "degraded"], loading: ["Loading", "degraded"], ready: ["Serving", "serving"], error: ["Failed", "gap"] };
    function paintSlices(s) {
      text(freeNote, s.memFree != null ? `${fmt.gb(s.memFree)} free for more text layers` : "");
      const k = (sliceList.dataset.off || "") + JSON.stringify(s.slices.map(x => [x.model, x.lo, x.hi, x.loaded, x.phase, Math.round(100 * (x.done || 0) / (x.total || 1))]));
      if (sliceList.dataset.k === k) return;
      sliceList.dataset.k = k;
      if (!s.slices.length && sliceList.dataset.off) {
        sliceList.replaceChildren(h("div.small.muted", "Nothing is served while your node is stopped. Start it to serve layers; models you downloaded stay on disk (see Models)."));
        return;
      }
      if (!s.slices.length) {
        sliceList.replaceChildren(h("div.small.muted", "No text-model layers yet. This machine can still chat with any model the swarm covers. Serve layers to contribute: Models shows which are missing."));
        return;
      }
      sliceList.replaceChildren(...s.slices.map(x => {
        const [label, kind] = x.loaded ? PH.ready : PH[x.phase] || ["Starting", "degraded"];
        const pc = x.phase === "downloading" && x.total ? x.done / x.total : null;
        return h("div.list-row",
          h("div.grow",
            h("div.t", h("b", shortModel(x.model)), ` · layers ${fmt.layers(x.lo, x.hi)}`, h("span.faint", ` (${x.hi - x.lo} of ${x.n_layers || "?"})`)),
            h("div.d", pc != null ? `${fmt.bytes(x.done)} of ${fmt.bytes(x.total)}` : x.model),
            pc != null ? h("div.progress", { style: { marginTop: "6px" } }, h("i", { style: { width: pc * 100 + "%" } })) : null),
          status(pc != null ? `${label} ${fmt.pct(pc)}` : label, x.loaded ? kind : kind === "gap" ? "gap" : "active"),
          x.loaded ? armedButton("Stop serving", "Click to confirm", () => unserveSlice(x.model, x.lo, x.hi), { ...calm, size: "sm" })
            : armedButton("Cancel download", "Click to confirm", () => cancelDownload(x.model, x.lo, x.hi), { ...calm, size: "sm", disabled: x.phase === "loading" }));
      }));
    }

    return {
      update(s) {
        const phase = s.engine.phase;
        const off = !["running", "unreachable", "starting"].includes(phase);
        const show = phase === "starting" ? "start" : "run";
        setup.hidden = show !== "setup"; starting.hidden = show !== "start"; running.hidden = show !== "run";
        const hl = s.health;
        offline.hidden = !off;
        offBtn.disabled = !isTauri;
        offErr.hidden = !(off && s.engine.error);
        if (off && s.engine.error) offErr.replaceChildren(icon("alert"), h("div.grow", h("b", "The engine stopped"), h("div.mono.small", s.engine.error.split("\n").slice(-3).join("\n"))));
        running.querySelector(".hero-r").hidden = off;
        if (off) sliceList.dataset.off = "1"; else delete sliceList.dataset.off;
        if (show === "setup") {
          startBtn.disabled = !isTauri;
          text(machine, hl ? `This machine: ${hl.chip || "Unknown chip"} · ${fmt.gb(hl.mem_total_gb)} memory · ${hl.os}. Half of Qwen3-30B-A3B (4-bit) needs about 8 GB plus KV cache; serve fewer layers on a smaller machine.${oldDriver(hl) ? ` The NVIDIA driver (${hl.gpu.driver}) is too old for the GPU to be used: update it to ${MIN_NVIDIA_DRIVER} or newer, or this machine runs on the CPU.` : ""}` : "");
          errBox.hidden = !s.engine.error;
          if (s.engine.error) errBox.replaceChildren(icon("alert"), h("div.grow", h("b", "The engine stopped"), h("div.mono.small", s.engine.error.split("\n").slice(-3).join("\n"))));
          return;
        }
        if (show === "start") {
          const su = s.engine.setup;
          startBar.classList.toggle("indeterminate", !su);
          startBar.firstChild.style.width = su ? `${(su.frac * 100).toFixed(1)}%` : "";
          text(startLine, s.engine.line);
          return;
        }
        const me = selfNode(s);
        const m = me?.mem || (hl ? { active_gb: 0, total_gb: hl.mem_total_gb } : null);
        g.set(m ? m.active_gb / m.total_gb : 0);
        text(gv, m ? fmt.gb(m.active_gb) : "–");
        text(gs, m ? `of ${fmt.gb(m.total_gb)} in use` : "");
        text(chipEl, me?.chip || hl?.chip || "This machine");
        text(running.querySelector(".hero-sub"), [me?.name, off ? "Not in the swarm" : "Peer in the global swarm"].filter(Boolean).join(" · "));
        const st = me ? nodeState(me, s) : "idle";
        if (off) setStatus(stateB, "Offline", "neutral"); else setStatus(stateB, phase === "unreachable" ? "Not responding" : me ? nodeStateLabel(me, s) : "Starting", phase === "unreachable" ? "gap" : st === "idle" ? "neutral" : st);
        const loaded = s.slices.filter(x => x.loaded);
        text(hv.layers, loaded.length ? String(loaded.reduce((a, x) => a + x.hi - x.lo, 0)) : "None yet");
        paintSlices(s);
        if (phase === "running") {
          const sk = JSON.stringify(s.slices.map(x => [x.model, x.lo, x.hi, x.loaded]));
          if (!askedVideo || sk !== slicesKey) { askedVideo = true; slicesKey = sk; encoderStatus(); videoStatus(); }
          paintVideo(s);
        } else { askedVideo = false; videoSect.hidden = true; memBar.hidden = memKey.hidden = true; }
        const day = new Date().toISOString().slice(0, 10);
        const days = history.days;
        tk.today.set(days[day] || 0);
        tk.all.set(Object.values(days).reduce((a, b) => a + b, 0));
        tk.req.set(me?.stats?.requests ?? 0);
        text(hv.up, off ? "–" : fmt.dur(me?.uptime_s ?? Date.now() / 1000 - (me?.firstSeen || Date.now() / 1000)));
        // health
        if (hl) {
          // macOS reports these itself; on Windows thermal is the NVIDIA GPU's temperature and Low Power Mode is Battery Saver.
          const mac = /^macOS/.test(hl.os || ""), gpu = hl.gpu;
          const p = PRESS[hl.mem_pressure] || PRESS.unknown, t = THERM[hl.thermal] || THERM.unknown;
          setTile(tiles.press, p[0], p[1], hl.ram_used_pct != null ? `${hl.ram_used_pct}% of system RAM in use` : "Memory pressure");
          relabel(tiles.therm, mac ? "Thermal state" : "GPU temperature");
          setTile(tiles.therm, t[0], t[1], gpu?.temp_c != null ? `${gpu.temp_c}°C${hl.thermal === "nominal" ? " · no throttling" : " · the GPU may slow down"}`
            : hl.thermal === "unknown" ? "Not reported on this machine" : hl.thermal === "nominal" ? "No throttling" : "The system may slow the GPU");
          setTile(tiles.power, hl.power === "ac" ? "Plugged in" : hl.power === "battery" ? "On battery" : "Unknown", hl.power === "battery" ? "degraded" : hl.power === "ac" ? "serving" : "neutral", hl.battery_pct != null ? `Battery ${hl.battery_pct}%` : hl.power === "ac" ? "Desktop" : "Not reported on this machine");
          relabel(tiles.lp, mac ? "Low Power Mode" : "Battery Saver");
          setTile(tiles.lp, hl.low_power ? "On" : "Off", hl.low_power ? "degraded" : "serving", hl.low_power ? "Inference will be slower" : "Full performance");
          tiles.gpu.hidden = !gpu;
          if (gpu) setTile(tiles.gpu, gpu.util_pct != null ? `${gpu.util_pct}%` : "–", gpu.util_pct > 90 ? "degraded" : "serving",
            gpu.mem_total_gb ? `${fmt.gb(gpu.mem_used_gb)} of ${fmt.gb(gpu.mem_total_gb)} GPU memory · ${gpu.name}` : gpu.name);
        } else for (const el of Object.values(tiles)) setTile(el, "–", "neutral", isTauri ? "Reading…" : "Available in the app");
        tpsChart.set(me ? me.tps.slice(-120) : []);
        const rows = [];
        for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5); const k = d.toISOString().slice(0, 10); rows.push({ label: i === 0 ? "Today" : d.toLocaleDateString([], { weekday: "narrow" }), v: days[k] || 0 }); }
        dayChart.set(rows);
        const sum = summarize(s, me, days, day);
        contrib.set(sum, s); payback.set(sum);
        text(dayNote, "tokens per day, this machine");
        cls(running, "unreachable", phase === "unreachable");
      },
    };
  },
};

// ---------- Contribution + Payback Meter ----------
const DAY = 86400;
function summarize(s, me, days, day) {
  const st = history.stats;
  const first = history.first;
  const keys = Object.keys(st);
  const tot = keys.reduce((a, k) => { for (const f in a) a[f] += st[k][f] || 0; return a; }, { req: 0, online_s: 0, active_s: 0, block_s: 0 });
  const td = st[day] || { req: 0, online_s: 0, active_s: 0, block_s: 0 };
  const now = Date.now() / 1000, sinceMidnight = now % DAY;
  const chip = me?.chip || s.health?.chip || "";
  const tokAll = Object.values(days).reduce((a, b) => a + b, 0);
  // current rate: average tokens/day over the last 7 days (or since first run, if shorter)
  let tok7 = 0; for (let i = 0; i < 7; i++) tok7 += days[new Date(Date.now() - i * DAY * 1000).toISOString().slice(0, 10)] || 0;
  const span = first ? Math.min(7, Math.max(1, (now - first) / DAY)) : 1;
  return {
    chip,
    today: { tokens: days[day] || 0, req: td.req, up: sinceMidnight ? Math.min(1, td.online_s / sinceMidnight) : null, blocks: me?.lo != null ? me.hi - me.lo : 0, kwh: kwh(td.active_s, td.online_s, chip) },
    all: { tokens: tokAll, req: tot.req, up: first ? Math.min(1, tot.online_s / Math.max(1, now - first)) : null, blockHours: tot.block_s / 3600, kwh: kwh(tot.active_s, tot.online_s, chip) },
    tokPerDay: tok7 / span, since: first,
  };
}

function contributionCard() {
  const sel = h("select.input.basis-sel", { "aria-label": "Valuation basis", onchange: e => setSetting("valuationBasis", e.target.value) });
  const cell = () => h("b.num");
  const rows = {};
  const mk = (k, label, tip) => { rows[k] = [cell(), cell()]; return h("div.c-row", h("span.c-l", label, tip ? h("span.faint.small", " " + tip) : null), ...rows[k]); };
  const valT = h("b.num.c-val"), valA = h("b.num.c-val");
  const foot = h("div.small.faint.c-foot");
  const el = h("section.card.contrib",
    h("div.card-h", h("h2", "Contribution"), h("span.spacer"), h("span.badge.neutral", "Estimates in USD")),
    h("div.card-b",
      h("div.c-grid",
        h("div.c-row.c-head", h("span"), h("span.caps", "Today"), h("span.caps", "Lifetime")),
        mk("tokens", "Tokens served"), mk("req", "Requests helped"), mk("up", "Uptime"),
        mk("blocks", "Blocks hosted", "(now · block-hours)"), mk("kwh", "Energy used", "(est.)"),
        h("div.c-row.c-value", h("span.c-l", "Value created ", h("span.badge.neutral", "Estimate")), valT, valA)),
      h("div.field.c-basis", h("label", "Valuation basis: equivalent API price for the tokens this machine served"), sel),
      foot));
  let selKey = "";
  el.set = (m, s) => {
    const list = bases();
    const k = list.map(b => b.id).join();
    if (k !== selKey) { selKey = k; sel.replaceChildren(...list.map(b => h("option", { value: b.id }, `${b.label} · $${b.usd_per_mtok.toFixed(2)} / 1M tokens`))); }
    const b = basis(settings.valuationBasis);
    if (b && sel.value !== b.id) sel.value = b.id;
    sel.disabled = !b;
    const set = (r, a, c) => { text(rows[r][0], a); text(rows[r][1], c); };
    set("tokens", fmt.compact(m.today.tokens), fmt.compact(m.all.tokens));
    set("req", fmt.int(m.today.req), fmt.int(m.all.req));
    set("up", fmt.pct(m.today.up), fmt.pct(m.all.up));
    set("blocks", m.today.blocks ? `${m.today.blocks} blocks` : "None", `${fmt.fixed(m.all.blockHours, m.all.blockHours < 10 ? 1 : 0)} h`);
    const e = x => x == null ? "–" : x < 1 ? `${Math.round(x * 1000)} Wh` : `${x.toFixed(2)} kWh`;
    set("kwh", e(m.today.kwh), e(m.all.kwh));
    text(valT, b ? "≈ " + usd(usdFor(m.today.tokens, b)) : "–");
    text(valA, b ? "≈ " + usd(usdFor(m.all.tokens, b)) : "–");
    text(foot, !valuation ? (valuationError || "Loading price benchmarks…")
      : `What these tokens would cost at ${b.label.toLowerCase()} prices${b.blended ? " (weighted average)" : ""}. Not earnings. Prices from config/valuation.json, last updated ${valuation.last_updated}. Energy is estimated from ${m.chip ? "an " + m.chip : "a generic"} power profile, not measured.`);
  };
  return el;
}

function paybackCard() {
  const ring = gauge(); ring.classList.add("payback-ring");
  const pct = h("b.num"), sub = h("span.small.faint");
  const price = h("input.input", { type: "number", min: "0", step: "1", inputmode: "decimal", placeholder: "e.g. 3999", value: settings.macPrice ?? "", "aria-label": "Purchase price in USD" });
  const amort = h("input.input", { type: "number", min: "0", step: "1", placeholder: "Optional", value: settings.amortMonths ?? "", "aria-label": "Amortization period in months" });
  const num = v => { const x = parseFloat(v); return isFinite(x) && x > 0 ? x : null; };
  price.addEventListener("change", () => setSetting("macPrice", num(price.value)));
  amort.addEventListener("change", () => setSetting("amortMonths", num(amort.value)));
  const lines = h("div.pb-lines");
  const el = h("section.card.payback",
    h("div.card-h", h("h2", "Payback Meter"), h("span.spacer"), h("span.badge.neutral", "Estimate")),
    h("div.card-b.pb-body",
      h("div.gauge-wrap", ring, h("div.gauge-c", pct, sub)),
      h("div.pb-r",
        h("div.pb-inputs",
          h("div.field", h("label", "This machine's purchase price (USD)"), price),
          h("div.field", h("label", "Amortize over (months)"), amort)),
        lines)));
  el.set = m => {
    if (document.activeElement !== price) price.value = settings.macPrice ?? "";
    if (document.activeElement !== amort) amort.value = settings.amortMonths ?? "";
    const b = basis(settings.valuationBasis), P = settings.macPrice;
    const value = b ? usdFor(m.all.tokens, b) : null, perDay = b ? usdFor(m.tokPerDay, b) : null;
    if (!P || value == null) {
      ring.set(0); text(pct, "–"); text(sub, P ? "no prices" : "enter price");
      lines.replaceChildren(h("div.small.muted", P ? "Price benchmarks aren't loaded." : "Enter what this machine cost to see how much of it the value it creates covers."));
      return;
    }
    const f = value / P;
    ring.set(f); text(pct, f >= 0.1 ? fmt.pct(f) : (f * 100).toFixed(f >= 0.001 ? 2 : 3) + "%"); text(sub, "paid back");
    const out = [h("div", h("span.muted", "Value created so far "), h("b", "≈ " + usd(value)), h("span.muted", ` of ${usd(P)}`))];
    out.push(h("div", h("span.muted", "Current rate "), h("b", perDay > 0 ? `≈ ${usd(perDay)} / day` : "No traffic yet"), h("span.faint.small", " (7-day average)")));
    if (f >= 1) out.push(h("div.pb-done", "Paid back at this valuation basis."));
    else if (perDay > 0) {
      const days = (P - value) / perDay, when = new Date(Date.now() + days * DAY * 1000);
      out.push(h("div", h("span.muted", "Projected payback "), h("b", days > 365 * 50 ? "More than 50 years" : when.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })),
        h("span.faint.small", days > 365 * 50 ? "" : ` (${days > 730 ? fmt.fixed(days / 365, 1) + " years" : Math.ceil(days) + " days"})`)));
    }
    const A = settings.amortMonths;
    if (A && f < 1) {
      const need = P / (A * 30.44);
      out.push(h("div", h("span.muted", `To pay back over ${A} months `), h("b", `≈ ${usd(need)} / day`), h("span.faint.small", perDay > 0 ? ` (you're at ${fmt.pct(perDay / need)} of that pace)` : "")));
    }
    out.push(h("div.small.faint", `Valued at ${b.label} prices. Not income: an estimate of what equivalent API usage would cost.`));
    lines.replaceChildren(...out);
  };
  return el;
}
