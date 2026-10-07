// Lightweight canvas charts (area line + bars). Redraw only when data changes.
import { colors, alpha, fonts } from "../tokens.js";
import { h } from "../dom.js";
import { on } from "../store.js";

function setup(canvas) {
  const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, W: r.width, H: r.height };
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p * 1.15) * p; }

/** Area chart for a time series. opts: {color, unit, labels:[left,right]} */
export function areaChart(opts = {}) {
  const canvas = h("canvas.chart");
  let data = [], key = "";
  function draw() {
    const { ctx, W, H } = setup(canvas);
    if (!W) return;
    const c = colors(), col = c[opts.color || "active"] || opts.color;
    const pad = { l: 34, r: 8, t: 10, b: 20 };
    const max = niceMax(Math.max(...data, 0));
    ctx.font = `500 10px ${fonts.ui}`; ctx.fillStyle = c.fg3; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (H - pad.t - pad.b) * (1 - i / 3);
      ctx.fillText(+(max * i / 3).toFixed(1), pad.l - 6, y);
      ctx.beginPath(); ctx.moveTo(pad.l, y + 0.5); ctx.lineTo(W - pad.r, y + 0.5); ctx.strokeStyle = c.line1; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    if (opts.labels) { ctx.fillText(opts.labels[0], pad.l, H - 4); ctx.textAlign = "right"; ctx.fillText(opts.labels[1], W - pad.r, H - 4); }
    if (data.length < 2) return;
    const x = i => pad.l + (W - pad.l - pad.r) * i / (data.length - 1);
    const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    ctx.beginPath(); data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();
    ctx.lineTo(x(data.length - 1), H - pad.b); ctx.lineTo(x(0), H - pad.b); ctx.closePath();
    const g = ctx.createLinearGradient(0, pad.t, 0, H - pad.b); g.addColorStop(0, alpha(col, 0.28)); g.addColorStop(1, alpha(col, 0));
    ctx.fillStyle = g; ctx.fill();
  }
  new ResizeObserver(() => { key = ""; draw(); }).observe(canvas);
  on("theme", draw);
  canvas.set = d => { const k = d.join(","); if (k === key) return; key = k; data = d; draw(); };
  return canvas;
}

/** Bar chart for labeled values. */
export function barChart(opts = {}) {
  const canvas = h("canvas.chart");
  let rows = [], key = "";
  function draw() {
    const { ctx, W, H } = setup(canvas);
    if (!W || !rows.length) return;
    const c = colors(), col = c[opts.color || "you"];
    const pad = { l: 8, r: 8, t: 14, b: 20 }, n = rows.length;
    const max = niceMax(Math.max(...rows.map(r => r.v), 0));
    const bw = (W - pad.l - pad.r) / n;
    ctx.font = `500 10px ${fonts.ui}`; ctx.textAlign = "center";
    rows.forEach((r, i) => {
      const bh = (H - pad.t - pad.b) * (r.v / max), x = pad.l + i * bw + bw * 0.18, w = bw * 0.64;
      ctx.fillStyle = r.v ? alpha(col, i === n - 1 ? 0.95 : 0.6) : c.line1;
      const y = H - pad.b - Math.max(2, bh);
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, Math.max(2, bh), 3) : ctx.rect(x, y, w, Math.max(2, bh)); ctx.fill();
      ctx.fillStyle = c.fg3; ctx.fillText(r.label, x + w / 2, H - 6);
    });
  }
  new ResizeObserver(() => draw()).observe(canvas);
  on("theme", draw);
  canvas.set = r => { const k = JSON.stringify(r); if (k === key) return; key = k; rows = r; draw(); };
  return canvas;
}
