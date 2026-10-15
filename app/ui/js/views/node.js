// My Node: set up this Mac's role (replaces the old launcher), then show what it contributes,
// its health, and the controls the engine actually supports.
import { h, text, fmt, cls } from "../dom.js";
import { state, settings, setSetting, history, selfNode, nodeState, nodeStateLabel, shortModel } from "../store.js";
import { valuation, valuationError, bases, basis, usdFor, kwh, usd } from "../valuation.js";
import { button, armedButton, toggle, badge, setBadge, ticker } from "../ui.js";
import { icon } from "../icons.js";
import { areaChart, barChart } from "../viz/chart.js";
import { startHost, stopNode, quitApp, unserveSlice } from "../engine.js";
import { openServe } from "../serve.js";
import { isTauri } from "../native.js";
import { setDemo } from "../actions.js";

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
        offBtn));
    const startCard = h("section.card.role-card",
      h("div.row", h("div.role-ic", icon("node")), h("div.grow", h("h2", "This machine as a peer"), h("div.small.muted", "Joins the global swarm, connects directly to the other machines, and serves whichever layers you choose, of any model. Only those layers are downloaded."))),
      h("div.row", { style: { marginTop: "14px" } }, startBtn));
    const machine = h("div.small.muted");
    const errBox = h("div.next.err");
    const setup = h("div.page",
      h("div.page-h", h("div", h("h1", "Share this machine"), h("p", "PodTorrent pools machines to run a model none of them can hold alone. Every machine runs the same node; each downloads only the slice it serves."), machine)),
      errBox,
      startCard,
      h("div.small.faint", "Machines on different networks connect directly over encrypted QUIC (UDP hole punching). The swarm is open: any PodTorrent peer can send work to this machine. ",
        h("a", { href: "#", onclick: e => { e.preventDefault(); setDemo(true); } }, "Explore Demo Mode first →")));

    // ---- starting ----
    const startLine = h("div.mono.small.muted");
    const startBar = h("div.progress.indeterminate", h("i"));
    const starting = h("div.page", h("div.card.pad.starting", h("div.row", h("span.statedot.active"), h("h2", "Starting your node…")), startBar, startLine,
      h("div.small.faint", "First run installs the Python environment (one time, needs internet). Output: ~/.podtorrent/engine.log"),
      h("div", button("Cancel", { onclick: () => stopNode() }))));

    // ---- running ----
    const g = gauge();
    const gv = h("b.num"), gs = h("span.small.faint");
    const chipEl = h("h1.hero-chip"), roleB = h("span.badge"), stateB = h("span.badge.dot");
    const hv = { layers: h("b.num"), today: h("b.num"), all: h("b.num"), req: h("b.num"), up: h("b.num") };
    const sliceList = h("div.col.slice-list");
    const freeNote = h("span.small.faint");
    const serveBtn = button("Serve layers…", { icon: "download", size: "sm", onclick: () => openServe() });
    const slicesCard = h("section.card",
      h("div.card-h", h("h2", "Slices this machine serves"), h("span.spacer"), freeNote,
        serveBtn),
      h("div.card-b", sliceList));
    const tk = { today: ticker(hv.today, v => fmt.compact(v)), all: ticker(hv.all, v => fmt.compact(v)), req: ticker(hv.req, v => fmt.int(v)) };
    const hero = h("section.card.hero",
      h("div.hero-l", h("div.gauge-wrap", g, h("div.gauge-c", gv, gs))),
      h("div.hero-m",
        h("div.row", h("span.you-pill", icon("person"), "This machine"), roleB, stateB),
        chipEl, h("div.small.muted.hero-sub"),
        h("div.hero-stats",
          h("div", h("span.caps", "Layers served"), hv.layers),
          h("div", h("span.caps", "Tokens today"), hv.today),
          h("div", h("span.caps", "All time"), hv.all),
          h("div", h("span.caps", "Requests helped"), hv.req),
          h("div", h("span.caps", "Uptime"), hv.up))),
      h("div.hero-r",
        armedButton("Stop node", "Click again to stop", () => stopNode(), { icon: "stop", size: "lg" }),
        armedButton("Stop & quit", "Click again to quit", () => quitApp(), { icon: "power" })));
    const tiles = { press: h("div.tile"), therm: h("div.tile"), power: h("div.tile"), lp: h("div.tile") };
    const tile = (el, ic, label) => el.replaceChildren(h("div.row", icon(ic), h("span.small.muted", label)), h("div.tile-v"), h("div.small.faint.tile-s"));
    tile(tiles.press, "memory", "Memory pressure"); tile(tiles.therm, "thermo", "Thermal state"); tile(tiles.power, "plug", "Power"); tile(tiles.lp, "bolt", "Low Power Mode");
    const setTile = (el, v, kind, sub) => { const x = el.querySelector(".tile-v"); x.className = `tile-v ${kind}`; text(x, v); text(el.querySelector(".tile-s"), sub || " "); };
    const rules = h("section.card",
      h("div.card-h", h("h2", "Contribution rules"), h("span.spacer"), badge("Needs engine support", "neutral")),
      ...[["Pause contributing", "Stop serving without leaving the swarm"], ["Only when plugged in", "Pause automatically on battery"], ["Only when idle", "Pause while you're using this machine"]].map(([t, d]) =>
        h("div.list-row", h("div.grow", h("div.t", t), h("div.d", d)), toggle(false, () => {}, t))),
      h("div.card-b.small.faint", { style: { paddingTop: "10px" } }, "To stop serving a slice, use Stop serving above; Stop node leaves the swarm. Slices that won't fit in this machine's GPU memory are refused before downloading (cap it with PODTORRENT_MEM_BUDGET_GB)."));
    rules.querySelectorAll(".toggle").forEach(t => { t.disabled = true; });
    const contrib = contributionCard(), payback = paybackCard();
    const tpsChart = areaChart({ color: "you", labels: ["2 min ago", "now"] });
    const dayChart = barChart({ color: "you" });
    const dayNote = h("span.small.faint");
    const running = h("div.page", offline, hero, slicesCard,
      h("div.tiles", Object.values(tiles)),
      h("div.two.contrib-row", contrib, payback),
      h("div.two",
        h("section.card", h("div.card-h", h("h2", "Tokens per second"), h("span.spacer"), h("span.small.faint", "this machine")), h("div.card-b", tpsChart)),
        h("section.card", h("div.card-h", h("h2", "Contribution history"), h("span.spacer"), dayNote), h("div.card-b", dayChart))),
      rules);

    root.append(setup, starting, running);

    const PH = { checking: ["Checking", "degraded"], downloading: ["Downloading", "degraded"], loading: ["Loading", "degraded"], ready: ["Serving", "serving"], error: ["Failed", "gap"] };
    function paintSlices(s) {
      text(freeNote, s.memFree != null ? `${fmt.gb(s.memFree)} free for models` : "");
      const k = (sliceList.dataset.off || "") + JSON.stringify(s.slices.map(x => [x.model, x.lo, x.hi, x.loaded, x.phase, Math.round(100 * (x.done || 0) / (x.total || 1))]));
      if (sliceList.dataset.k === k) return;
      sliceList.dataset.k = k;
      if (!s.slices.length && sliceList.dataset.off) {
        sliceList.replaceChildren(h("div.small.muted", "Nothing is served while your node is stopped. Start it to serve layers; models you downloaded stay on disk (see Models)."));
        return;
      }
      if (!s.slices.length) {
        sliceList.replaceChildren(h("div.small.muted", "This machine serves nothing yet. It can still chat with any model the swarm covers. Serve some layers to contribute: open Models to see which layers are missing."));
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
          badge(pc != null ? `${label} ${fmt.pct(pc)}` : label, kind, { dot: true, pulse: !x.loaded }),
          armedButton("Stop serving", "Click to confirm", () => unserveSlice(x.model, x.lo, x.hi), { size: "sm", icon: "stop", disabled: !x.loaded }));
      }));
    }

    return {
      update(s) {
        const phase = s.engine.phase;
        const off = s.source === "live" && !["running", "unreachable", "starting"].includes(phase);
        const show = phase === "starting" && s.source !== "demo" ? "start" : "run";
        setup.hidden = show !== "setup"; starting.hidden = show !== "start"; running.hidden = show !== "run";
        const hl = s.health;
        offline.hidden = !off;
        offBtn.disabled = !isTauri;
        offErr.hidden = !(off && s.engine.error);
        if (off && s.engine.error) offErr.replaceChildren(icon("alert"), h("div.grow", h("b", "The engine stopped"), h("div.mono.small", s.engine.error.split("\n").slice(-3).join("\n"))));
        running.querySelector(".hero-r").hidden = off;
        serveBtn.disabled = off;
        if (off) sliceList.dataset.off = "1"; else delete sliceList.dataset.off;
        if (show === "setup") {
          startBtn.disabled = !isTauri;
          text(machine, hl ? `This machine: ${hl.chip || "Unknown chip"} · ${fmt.gb(hl.mem_total_gb)} memory · ${hl.os}. Half of Qwen3-30B-A3B (4-bit) needs about 8 GB plus KV cache; serve fewer layers on a smaller machine.` : "");
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
        text(running.querySelector(".hero-sub"), [me?.name, s.source === "demo" ? "Demo Mode" : off ? "Not in the swarm" : "Peer in the global swarm"].filter(Boolean).join(" · "));
        setBadge(roleB, "Peer", "you");
        const st = me ? nodeState(me, s) : "idle";
        if (off) setBadge(stateB, "Offline", "neutral", { dot: true }); else setBadge(stateB, phase === "unreachable" ? "Not responding" : me ? nodeStateLabel(me, s) : "Starting", phase === "unreachable" ? "gap" : st === "idle" ? "neutral" : st, { dot: true, pulse: st === "active" });
        const loaded = s.slices.filter(x => x.loaded);
        text(hv.layers, loaded.length ? String(loaded.reduce((a, x) => a + x.hi - x.lo, 0)) : "None yet");
        paintSlices(s);
        const day = new Date().toISOString().slice(0, 10);
        const days = s.source === "demo" ? demoDays() : history.days;
        tk.today.set(days[day] || 0);
        tk.all.set(Object.values(days).reduce((a, b) => a + b, 0));
        tk.req.set(me?.stats?.requests ?? 0);
        text(hv.up, off ? "–" : fmt.dur(me?.uptime_s ?? Date.now() / 1000 - (me?.firstSeen || Date.now() / 1000)));
        // health
        if (hl) {
          const p = PRESS[hl.mem_pressure] || PRESS.unknown, t = THERM[hl.thermal] || THERM.unknown;
          setTile(tiles.press, p[0], p[1], "Memory pressure");
          setTile(tiles.therm, t[0], t[1], hl.thermal === "nominal" ? "No throttling" : "The system may slow the GPU");
          setTile(tiles.power, hl.power === "ac" ? "Plugged in" : hl.power === "battery" ? "On battery" : "Unknown", hl.power === "battery" ? "degraded" : "serving", hl.battery_pct != null ? `Battery ${hl.battery_pct}%` : "Desktop");
          setTile(tiles.lp, hl.low_power ? "On" : "Off", hl.low_power ? "degraded" : "serving", hl.low_power ? "Inference will be slower" : "Full performance");
        } else for (const el of Object.values(tiles)) setTile(el, "–", "neutral", isTauri ? "Reading…" : "Available in the app");
        tpsChart.set(me ? me.tps.slice(-120) : []);
        const rows = [];
        for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5); const k = d.toISOString().slice(0, 10); rows.push({ label: i === 0 ? "Today" : d.toLocaleDateString([], { weekday: "narrow" }), v: days[k] || 0 }); }
        dayChart.set(rows);
        const sum = summarize(s, me, days, day);
        contrib.set(sum, s); payback.set(sum);
        text(dayNote, s.source === "demo" ? "Demo data" : "tokens per day, this machine");
        cls(running, "unreachable", phase === "unreachable");
        running.querySelectorAll(".hero-r .btn").forEach(b => { b.disabled = s.source === "demo"; b.dataset.tip = s.source === "demo" ? "Not available in Demo Mode" : ""; });
      },
    };
  },
};

// ---------- Contribution + Payback Meter ----------
const DAY = 86400;
function summarize(s, me, days, day) {
  const demo = s.source === "demo";
  const st = demo ? demoStats() : history.stats;
  const first = demo ? Date.now() / 1000 - 14 * DAY : history.first;
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
    demo, chip,
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
      : `What these tokens would cost at ${b.label.toLowerCase()} prices${b.blended ? " (weighted average)" : ""}. Not earnings. Prices from config/valuation.json, last updated ${valuation.last_updated}. Energy is estimated from ${m.chip ? "an " + m.chip : "a generic"} power profile, not measured.${m.demo ? " Demo data." : ""}`);
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
    out.push(h("div.small.faint", `Valued at ${b.label} prices. Not income: an estimate of what equivalent API usage would cost.${m.demo ? " Demo data." : ""}`));
    lines.replaceChildren(...out);
  };
  return el;
}

let demoStatsCache = null;
function demoStats() {
  if (demoStatsCache) return demoStatsCache;
  demoStatsCache = {};
  const d = demoDays();
  const today = new Date().toISOString().slice(0, 10), up = (Date.now() / 1000) % DAY * 0.97;
  for (const [k, tok] of Object.entries(d)) demoStatsCache[k] = { req: Math.round(tok / 180), online_s: k === today ? up : 20 * 3600, active_s: Math.round(tok / 30), block_s: 24 * 20 * 3600 };
  return demoStatsCache;
}

let demoCache = null;
function demoDays() {
  if (demoCache) return demoCache;
  demoCache = {};
  for (let i = 0; i < 14; i++) { const k = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); demoCache[k] = Math.round(4000 + 9000 * Math.abs(Math.sin(i * 1.7)) + (i === 0 ? 2500 : 0)); }
  return demoCache;
}
