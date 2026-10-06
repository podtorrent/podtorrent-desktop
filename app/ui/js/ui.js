// Primitive components: Button, IconButton, Segmented, Toggle, Tooltip, Popover, Sheet, Toast,
// Badge, Stat (ticker + delta + sparkline), Empty state, Skeleton, Kbd. Plain DOM + ARIA.
import { h, text, attr, reducedMotion } from "./dom.js";
import { icon } from "./icons.js";
import { on } from "./store.js";

export function button(label, opts = {}) {
  const b = h(`button.btn${opts.variant ? "." + opts.variant : ""}${opts.size ? "." + opts.size : ""}`, { type: "button", onclick: opts.onclick, title: opts.title, "data-tip": opts.tip },
    opts.icon ? icon(opts.icon) : null, label ? h("span", label) : null, opts.kbd ? kbd(opts.kbd, true) : null);
  if (opts.disabled) b.disabled = true;
  return b;
}
export function iconButton(name, label, onclick, opts = {}) {
  return h(`button.icon-btn${opts.size ? "." + opts.size : ""}`, { type: "button", "aria-label": label, "data-tip": label + (opts.kbd ? `  ${opts.kbd}` : ""), onclick }, icon(name));
}

/** Two-click confirm for destructive actions. */
export function armedButton(label, armedLabel, onconfirm, opts = {}) {
  const b = button(label, { variant: "danger", ...opts });
  let t;
  b.onclick = () => {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.lastChild.textContent = armedLabel; t = setTimeout(reset, 3000); return; }
    reset(); onconfirm();
  };
  const reset = () => { clearTimeout(t); b.classList.remove("armed"); b.lastChild.textContent = label; };
  return b;
}

export function kbd(keys, inline) {
  const parts = Array.isArray(keys) ? keys : String(keys).split(" ");
  return h(`span.kbds${inline ? ".inline" : ""}`, parts.map(k => h("kbd", k)));
}

export function badge(label, kind = "neutral", opts = {}) {
  return h(`span.badge.${kind}${opts.dot ? ".dot" : ""}${opts.pulse ? ".pulse" : ""}`, label);
}
export function setBadge(el, label, kind, opts = {}) {
  el.className = `badge ${kind}${opts.dot ? " dot" : ""}${opts.pulse ? " pulse" : ""}`;
  text(el, label);
}

// ---------- Segmented ----------
export function segmented(options, value, onchange, label = "") {
  const thumb = h("span.thumb");
  const root = h("div.seg", { role: "radiogroup", "aria-label": label }, thumb);
  const btns = options.map(o => {
    const b = h("button", { type: "button", role: "radio", "data-value": o.value, "data-tip": o.tip, onclick: () => { set(o.value); onchange(o.value); } },
      o.icon ? icon(o.icon) : null, o.label ? h("span", o.label) : null);
    root.append(b); return b;
  });
  root.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = btns.findIndex(b => b.getAttribute("aria-checked") === "true");
    const n = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
    n.click(); n.focus(); e.preventDefault();
  });
  function place() {
    const b = btns.find(x => x.getAttribute("aria-checked") === "true");
    if (!b || !b.offsetWidth) return;
    thumb.style.left = b.offsetLeft + "px"; thumb.style.width = b.offsetWidth + "px";
  }
  function set(v) {
    btns.forEach(b => { const on = b.dataset.value === String(v); attr(b, "aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
    requestAnimationFrame(place);
  }
  set(value);
  new ResizeObserver(place).observe(root);
  root.set = set;
  return root;
}

// ---------- Toggle ----------
export function toggle(value, onchange, label) {
  const t = h("button.toggle", { type: "button", role: "switch", "aria-label": label, "aria-checked": value ? "true" : "false" });
  t.onclick = () => { const v = t.getAttribute("aria-checked") !== "true"; t.setAttribute("aria-checked", v); onchange(v); };
  t.set = v => attr(t, "aria-checked", v ? "true" : "false");
  return t;
}

export function slider({ min, max, step = 1, value, oninput, label }) {
  const s = h("input.slider", { type: "range", min, max, step, value, "aria-label": label });
  const fill = () => s.style.setProperty("--fill", ((s.value - min) / (max - min)) * 100 + "%");
  s.addEventListener("input", () => { fill(); oninput?.(+s.value); });
  fill();
  return s;
}

// ---------- Number ticker ----------
/** Animates numeric text between values; tabular numerals keep it from jittering. */
export function ticker(el, format) {
  let cur = null, target = null, raf = 0, from = 0, t0 = 0;
  const D = 450;
  function frame(t) {
    const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3);
    cur = from + (target - from) * e;
    text(el, format(cur));
    raf = p < 1 ? requestAnimationFrame(frame) : 0;
  }
  return {
    set(v) {
      if (v == null || !isFinite(v)) { cancelAnimationFrame(raf); raf = 0; cur = null; target = null; text(el, format(null)); return; }
      if (v === target) return;
      if (cur == null || reducedMotion() || document.hidden) { cancelAnimationFrame(raf); raf = 0; cur = target = v; text(el, format(v)); return; }
      from = cur; target = v; t0 = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
}

// ---------- Sparkline (SVG, tiny) ----------
export function sparkline(cls = "spark", w = 72, hgt = 26) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", cls); svg.setAttribute("aria-hidden", "true");
  const area = document.createElementNS(ns, "path"), line = document.createElementNS(ns, "path");
  area.setAttribute("fill", "currentColor"); area.setAttribute("opacity", "0.14");
  line.setAttribute("fill", "none"); line.setAttribute("stroke", "currentColor"); line.setAttribute("stroke-width", "1.5"); line.setAttribute("vector-effect", "non-scaling-stroke"); line.setAttribute("stroke-linejoin", "round");
  svg.append(area, line);
  let last = "";
  svg.set = (vals, max) => {
    const v = vals.length ? vals : [0];
    const m = max ?? Math.max(1e-9, ...v);
    const pts = v.map((y, i) => [v.length === 1 ? w : (i / (v.length - 1)) * w, hgt - 2 - (Math.max(0, y) / m) * (hgt - 4)]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    if (d === last) return; last = d;
    line.setAttribute("d", d);
    area.setAttribute("d", d + `L${w} ${hgt}L0 ${hgt}Z`);
  };
  return svg;
}

// ---------- Stat ----------
export function stat({ label, unit = "", format = x => x, icon: ic, color, spark = false, tip }) {
  const val = h("span.v", "–"), un = h("span.unit", unit), sub = h("div.sub", " ");
  const el = h("div.stat", { "data-tip": tip }, h("div.lbl", ic ? icon(ic) : null, label), h("div.val", val, un), sub);
  if (ic) el.querySelector(".lbl svg").style.cssText = "width:13px;height:13px;color:" + (color || "var(--fg-3)");
  const tk = ticker(val, v => v == null ? "–" : format(v));
  let sp = null;
  if (spark) { sp = sparkline(); sp.style.color = color || "var(--accent)"; el.append(sp); }
  el.set = (v, subText, series) => { tk.set(v); el.classList.toggle("is-empty", v == null); text(sub, subText || " "); if (sp && series) sp.set(series); };
  el.setUnit = u => text(un, u);
  return el;
}

// ---------- Empty state ----------
export function empty({ icon: ic = "info", title, body, actions = [], tone = "" }) {
  return h(`div.empty${tone ? "." + tone : ""}`, h("div.art", icon(ic)), h("h2", title), body ? h("p", body) : null, actions.length ? h("div.actions", actions) : null);
}
export const skeleton = (w = "100%", hh = 14) => h("div.skel", { style: { width: typeof w === "number" ? w + "px" : w, height: hh + "px" } });

// ---------- Toasts ----------
const toastRoot = h("div.toasts", { role: "status", "aria-live": "polite" });
export function toast(textValue, kind = "info", detail) {
  const ic = { serving: "check", gap: "alert", degraded: "alert", info: "info" }[kind] || "info";
  const t = h(`div.toast.glass.${kind}`, icon(ic), h("div", h("div", textValue), detail ? h("div.small.muted", String(detail).slice(0, 220)) : null));
  toastRoot.append(t);
  while (toastRoot.children.length > 4) toastRoot.firstChild.remove();
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, kind === "gap" ? 6000 : 3200);
}
on("toast", ({ text: t, kind, detail }) => toast(t, kind, detail));

// ---------- Tooltip (any [data-tip]) ----------
const tip = h("div.tooltip.glass", { role: "tooltip" });
let tipTimer = 0, tipFor = null;
function showTip(el) {
  const s = el.getAttribute("data-tip");
  if (!s) return;
  tip.textContent = s;
  tip.classList.add("show");
  const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
  let x = r.left + r.width / 2 - tr.width / 2, y = r.bottom + 6;
  if (y + tr.height > innerHeight - 8) y = r.top - tr.height - 6;
  x = Math.max(8, Math.min(innerWidth - tr.width - 8, x));
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip() { clearTimeout(tipTimer); tip.classList.remove("show"); tipFor = null; }
document.addEventListener("pointerover", e => {
  const el = e.target.closest?.("[data-tip]");
  if (el === tipFor) return;
  hideTip();
  if (!el) return;
  tipFor = el;
  tipTimer = setTimeout(() => showTip(el), tip.classList.contains("show") ? 0 : 450);
});
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("keydown", hideTip, true);

// ---------- Popover (positioned at a point or element) ----------
export function popover() {
  const el = h("div.popover.glass", { role: "dialog" });
  document.body.append(el);
  return {
    el,
    show(content, x, y) {
      el.replaceChildren(content);
      el.classList.add("show");
      const r = el.getBoundingClientRect();
      let px = x + 14, py = y + 14;
      if (px + r.width > innerWidth - 10) px = x - r.width - 14;
      if (py + r.height > innerHeight - 10) py = y - r.height - 14;
      el.style.left = Math.max(10, px) + "px"; el.style.top = Math.max(10, py) + "px";
    },
    hide() { el.classList.remove("show"); },
  };
}

// ---------- Sheet (modal) ----------
let openSheet = null;
export function sheet({ title, body, footer, wide = false, onclose }) {
  closeSheet();
  const prev = document.activeElement;
  const scrim = h("div.scrim", { onclick: () => close() });
  const s = h(`div.sheet${wide ? ".wide" : ""}`, { role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div.sheet-h", h("h2", title), h("span.spacer"), iconButton("x", "Close", () => close(), { kbd: "esc" })),
    h("div.sheet-b", body), footer ? h("div.sheet-f", footer) : null);
  document.body.append(scrim, s);
  requestAnimationFrame(() => { scrim.classList.add("show"); s.classList.add("show"); (s.querySelector("input, [autofocus], .btn.primary") || s.querySelector("button"))?.focus(); });
  const key = e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") {
      const f = [...s.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    }
  };
  document.addEventListener("keydown", key, true);
  function close() {
    document.removeEventListener("keydown", key, true);
    scrim.classList.remove("show"); s.classList.remove("show");
    setTimeout(() => { scrim.remove(); s.remove(); }, 380);
    if (openSheet === api) openSheet = null;
    prev?.focus?.();
    onclose?.();
  }
  const api = { close, el: s };
  openSheet = api;
  return api;
}
export function closeSheet() { openSheet?.close(); }
export const sheetOpen = () => !!openSheet;

export function mountOverlays() { document.body.append(toastRoot, tip); }
