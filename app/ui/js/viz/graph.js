// Swarm graph on a DPR-aware Canvas 2D. Peers are nodes (size = layers hosted, ring = state,
// you = signature color). Each real token_timing becomes a light pulse that travels the
// route hop by hop at real (scaled) latency. The loop sleeps whenever nothing moves.
import { colors, alpha, fonts } from "../tokens.js";
import { state, on, nodeList, nodeState, nodeStateLabel, nodeSlices, slicesLabel } from "../store.js";
import { perf } from "../perf.js";
import { routeOf } from "../route.js";
import { h, fmt } from "../dom.js";
import { popover } from "../ui.js";

export const PLAYBACK = 8; // pulses run 8× slower than real time so a 20 ms hop is visible

export function swarmGraph() {
  const canvas = h("canvas.graph", { role: "img", "aria-label": "Swarm network graph" });
  const ctx = canvas.getContext("2d");
  const pos = new Map();   // name -> {x,y,vx,vy,s(scale),vs,born}
  let pulses = [], flashes = new Map(), W = 0, H = 0, dpr = 1, raf = 0, lastFrame = 0, hover = null, visible = true;
  const pop = popover();

  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    wake();
  });
  ro.observe(canvas);

  function order() {
    // pipeline order: host, then by first layer
    return nodeList(state);
  }
  function targets(list) {
    // Columns by pipeline stage (first layer), left to right; peers serving the same stage stack.
    const cx = W / 2, cy = H / 2, out = new Map();
    if (list.length === 1) { out.set(list[0].name, { x: cx, y: cy }); return out; }
    const cols = new Map();
    for (const nd of list) {
      const k = nd.role === "host" ? -1 : nd.lo ?? 1e6;
      if (!cols.has(k)) cols.set(k, []);
      cols.get(k).push(nd);
    }
    const keys = [...cols.keys()].sort((a, b) => a - b);
    const span = Math.min(W * 0.72, 220 * (keys.length - 1) + 120);
    keys.forEach((k, ci) => {
      const x = keys.length === 1 ? cx : cx - span / 2 + (span * ci) / (keys.length - 1);
      const col = cols.get(k), gap = Math.min(130, (H * 0.7) / Math.max(1, col.length));
      col.forEach((nd, i) => out.set(nd.name, { x, y: cy + (i - (col.length - 1) / 2) * gap }));
    });
    return out;
  }
  const radius = nd => {
    const L = nd.lo != null ? nd.hi - nd.lo : 0;
    return 20 + Math.sqrt(L) * 3.4;
  };

  function edges(list) {
    // route edges from the layer map: host → stage → … → host
    const a = state.layerMap?.assignments;
    if (!a || list.length < 2) {
      const host = list.find(n => n.role === "host");
      return host ? list.filter(n => n !== host).map(n => [host.name, n.name, true]) : [];
    }
    const out = [], seen = new Set();
    const sorted = [...a].sort((x, y) => x.lo - y.lo || x.hi - y.hi);
    for (const x of sorted) for (const y of sorted) if (y.lo === x.hi && x.node !== y.node) {
      const k = x.node + ">" + y.node; if (!seen.has(k)) { seen.add(k); out.push([x.node, y.node]); }
    }
    const n = state.layerMap.total_layers, host = sorted[0]?.node;
    for (const x of sorted) if (x.hi === n && x.node !== host) out.push([x.node, host]);
    return out;
  }

  function ctrl(p, q, list) {
    // bend outward from the center so out/back arcs separate
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1, k = list.length === 2 ? 0.28 : dx < -10 ? 0.3 : 0.06;
    return { x: mx + (-dy / len) * len * k, y: my + (dx / len) * len * k };
  }
  const qpt = (p, c, q, t) => ({ x: (1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * c.x + t * t * q.x, y: (1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * c.y + t * t * q.y });

  // ---- pulses from real timings ----
  on("timing", t => {
    if (!visible || document.hidden) return;
    const route = routeOf(t);
    if (!route.segments.length) return;
    if (pulses.length > 28) pulses.shift();
    let at = performance.now();
    const segs = route.segments.map(s => { const d = Math.max(60, s.ms * PLAYBACK); const seg = { ...s, t0: at, t1: at + d }; at += d; return seg; });
    pulses.push({ segs, end: at, prefill: t.prefill });
    wake();
  });

  function step(now) {
    raf = 0;
    const pf = perf();
    if (!visible || pf.fps === 0) return;
    if (now - lastFrame < 1000 / pf.fps - 2) { raf = requestAnimationFrame(step); return; }
    const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    const c = colors();
    const list = order();
    const tg = targets(list);
    let moving = false;
    // spring toward targets ("gentle" preset); new nodes scale in
    for (const nd of list) {
      let p = pos.get(nd.name);
      const t = tg.get(nd.name);
      if (!p) { p = { x: t.x + (Math.random() - 0.5) * 40, y: t.y + (Math.random() - 0.5) * 40, vx: 0, vy: 0, s: pf.motion ? 0 : 1, vs: 0, born: now }; pos.set(nd.name, p); }
      if (!pf.motion) { p.x = t.x; p.y = t.y; p.s = 1; continue; }
      const k = 120, cdamp = 20;
      p.vx += (k * (t.x - p.x) - cdamp * p.vx) * dt; p.vy += (k * (t.y - p.y) - cdamp * p.vy) * dt;
      p.vs += (260 * (1 - p.s) - 18 * p.vs) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.s += p.vs * dt;
      if (Math.abs(p.vx) + Math.abs(p.vy) > 0.5 || Math.abs(t.x - p.x) + Math.abs(t.y - p.y) > 0.5 || Math.abs(1 - p.s) > 0.002 || Math.abs(p.vs) > 0.01) moving = true;
    }
    for (const k of [...pos.keys()]) if (!state.nodes[k]) pos.delete(k);
    pulses = pulses.filter(p => p.end > now);

    // ---- draw ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const E = edges(list);
    for (const [a, b, tentative] of E) {
      const p = pos.get(a), q = pos.get(b); if (!p || !q) continue;
      const cp = ctrl(p, q, list);
      const lost = state.nodes[a]?.status === "lost" || state.nodes[b]?.status === "lost";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(cp.x, cp.y, q.x, q.y);
      ctx.strokeStyle = lost ? alpha(c.gap, 0.5) : tentative ? c.line1 : c.line2;
      ctx.lineWidth = 1.5; ctx.setLineDash(lost || tentative ? [4, 5] : []); ctx.stroke(); ctx.setLineDash([]);
      // direction chevron at mid
      if (!tentative) {
        const m = qpt(p, cp, q, 0.5), m2 = qpt(p, cp, q, 0.52), ang = Math.atan2(m2.y - m.y, m2.x - m.x);
        ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(-4, -4); ctx.lineTo(2, 0); ctx.lineTo(-4, 4);
        ctx.strokeStyle = c.fg4; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
      }
    }
    // pulses
    const active = new Set();
    for (const pl of pulses) for (const s of pl.segs) {
      if (now < s.t0 || now > s.t1) continue;
      const f = (now - s.t0) / (s.t1 - s.t0);
      if (s.kind === "compute") { active.add(s.node); continue; }
      const p = pos.get(s.from), q = pos.get(s.to); if (!p || !q) continue;
      const cp = E.some(([a, b]) => a === s.from && b === s.to) || list.length === 2 ? ctrl(p, q, list) : { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const ra = radius(state.nodes[s.from] || {}), rb = radius(state.nodes[s.to] || {});
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const tt = ra / len + f * (1 - (ra + rb) / len);
      const col = pl.prefill ? c.you : c.active;
      for (let k = 6; k >= 0; k--) {
        const pt = qpt(p, cp, q, Math.max(0, tt - k * 0.012));
        ctx.beginPath(); ctx.arc(pt.x, pt.y, k === 0 ? 3.6 : 3 - k * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = alpha(col, k === 0 ? 1 : 0.5 - k * 0.06); ctx.fill();
      }
      if (pf.glow) {
        const pt = qpt(p, cp, q, tt);
        const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 16);
        g.addColorStop(0, alpha(col, 0.45)); g.addColorStop(1, alpha(col, 0));
        ctx.fillStyle = g; ctx.fillRect(pt.x - 16, pt.y - 16, 32, 32);
      }
    }
    // nodes
    for (const nd of list) {
      const p = pos.get(nd.name); if (!p) continue;
      const r = radius(nd) * Math.max(0.01, p.s);
      const st = active.has(nd.name) ? "active" : nodeState(nd);
      const col = { serving: c.serving, active: c.active, degraded: c.degraded, gap: c.gap, idle: c.fg3 }[st];
      const me = nd.name === state.self;
      if (pf.glow && (st === "active" || me)) {
        const g = ctx.createRadialGradient(p.x, p.y, r * 0.8, p.x, p.y, r * 2.1);
        g.addColorStop(0, alpha(me ? c.you : col, st === "active" ? 0.32 : 0.16)); g.addColorStop(1, alpha(me ? c.you : col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.1, 0, Math.PI * 2); ctx.fill();
      }
      // spawn ripple for your node
      if (me && pf.motion && now - p.born < 1600) {
        const f = (now - p.born) / 1600;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + f * 60, 0, Math.PI * 2);
        ctx.strokeStyle = alpha(c.you, 0.6 * (1 - f)); ctx.lineWidth = 2; ctx.stroke(); moving = true;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.elev1; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = alpha(col, 0.9); ctx.stroke();
      // memory used (inner arc)
      if (nd.mem?.total_gb) {
        const f = Math.min(1, nd.mem.active_gb / nd.mem.total_gb);
        ctx.beginPath(); ctx.arc(p.x, p.y, r - 5, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        ctx.strokeStyle = alpha(col, 0.35); ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.stroke(); ctx.lineCap = "butt";
      }
      if (me) { ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.strokeStyle = c.you; ctx.lineWidth = 2.5; ctx.stroke(); }
      if (hover === nd.name) { ctx.beginPath(); ctx.arc(p.x, p.y, r + (me ? 9 : 5), 0, Math.PI * 2); ctx.strokeStyle = c.fg3; ctx.lineWidth = 1; ctx.stroke(); }
      // label
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.max(10, Math.min(13, r * 0.42))}px ${fonts.ui}`; ctx.fillStyle = c.fg1;
      ctx.fillText(nd.lo != null ? fmt.layers(nd.lo, nd.hi) : "–", p.x, p.y);
      ctx.font = `500 12px ${fonts.ui}`; ctx.fillStyle = me ? c.you : c.fg2;
      ctx.fillText(nd.name, p.x, p.y + r + (me ? 18 : 14));
      if (me) { ctx.font = `700 9px ${fonts.ui}`; ctx.fillStyle = c.you; ctx.fillText("YOU", p.x, p.y + r + 31); }
    }
    if (moving || pulses.length) raf = requestAnimationFrame(step);
  }
  function wake() { if (!raf && visible) { lastFrame = 0; raf = requestAnimationFrame(step); } }

  // hover → glass popover
  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let hit = null;
    for (const nd of nodeList(state)) { const p = pos.get(nd.name); if (p && Math.hypot(p.x - x, p.y - y) < radius(nd) + 6) hit = nd; }
    canvas.style.cursor = hit ? "pointer" : "";
    if ((hit?.name || null) !== hover) { hover = hit?.name || null; wake(); }
    if (!hit) return pop.hide();
    pop.show(peerCard(hit), e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerleave", () => { hover = null; pop.hide(); wake(); });
  canvas.addEventListener("click", () => { if (hover) canvas.dispatchEvent(new CustomEvent("peer", { detail: hover, bubbles: true })); });

  const unsub = [on("theme", wake)];
  return {
    el: canvas,
    update: wake,
    setVisible(v) { visible = v; if (v) wake(); else pop.hide(); },
    destroy() { ro.disconnect(); unsub.forEach(f => f()); pop.el.remove(); cancelAnimationFrame(raf); },
  };
}

export function peerCard(nd) {
  const st = nodeState(nd), me = nd.name === state.self;
  const tps = nd.tps.slice(-5), rate = tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : null;
  const rows = [
    ["Device", nd.chip || "Unknown chip"],
    ["Memory", nd.mem ? `${fmt.gb(nd.mem.active_gb)} of ${fmt.gb(nd.mem.total_gb)}` : nd.mem_total_gb ? fmt.gb(nd.mem_total_gb) : "–"],
    ["Serves", slicesLabel(nodeSlices(nd.name), "Nothing yet")],
    ["Throughput", rate != null ? `${fmt.fixed(rate)} tok/s` : "–"],
    ["Latency", me ? "local" : nd.rtt_ms != null ? fmt.ms(nd.rtt_ms) : "–"],
    [nd.uptime_s != null ? "Uptime" : "Seen for", fmt.dur(nd.uptime_s ?? Date.now() / 1000 - nd.firstSeen)],
  ];
  return h("div",
    h("div.row", h(`span.statedot.${st === "idle" ? "off" : st}`), h("b", nd.name), me ? h("span.badge.you", "You") : null, h("span.spacer"), h("span.small.faint", "Peer")),
    h("div.small.muted", { style: { marginTop: "2px" } }, nodeStateLabel(nd)),
    h("dl.kv", rows.map(([k, v]) => [h("dt", k), h("dd", v)])));
}
