// Tiny DOM helpers. Views build their DOM once and update targeted nodes; no virtual DOM.

/** h("div.card.pad", {onclick}, child, ...) */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Set text only if it changed (avoids layout work on every frame). */
export function text(el, v) { v = v == null ? "" : String(v); if (el.textContent !== v) el.textContent = v; }
export function attr(el, k, v) { if (v == null || v === false) el.removeAttribute(k); else if (el.getAttribute(k) !== String(v === true ? "" : v)) el.setAttribute(k, v === true ? "" : v); }
export function cls(el, name, on) { el.classList.toggle(name, !!on); }

/** Keyed list reconciliation: create/update/remove/reorder children of `parent`. */
export function reconcile(parent, items, key, create, update) {
  const existing = new Map();
  for (const c of [...parent.children]) if (c.dataset.key != null) existing.set(c.dataset.key, c);
  let prev = null;
  for (const item of items) {
    const k = String(key(item));
    let el = existing.get(k);
    if (el) existing.delete(k);
    else { el = create(item); el.dataset.key = k; }
    update(el, item);
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (want !== el) parent.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- formatting ----------
export const fmt = {
  int: x => x == null ? "–" : Math.round(x).toLocaleString("en-US"),
  compact: x => x == null ? "–" : x >= 1e9 ? (x / 1e9).toFixed(2) + "B" : x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e4 ? (x / 1e3).toFixed(1) + "k" : Math.round(x).toLocaleString("en-US"),
  fixed: (x, d = 1) => x == null || !isFinite(x) ? "–" : x.toFixed(d),
  ms: x => x == null || !isFinite(x) ? "–" : x >= 1000 ? (x / 1000).toFixed(2) + " s" : x >= 100 ? Math.round(x) + " ms" : x.toFixed(1) + " ms",
  gb: x => x == null ? "–" : x >= 100 ? Math.round(x) + " GB" : x.toFixed(1) + " GB",
  bytes: b => b == null ? "–" : b >= 2 ** 30 ? (b / 2 ** 30).toFixed(2) + " GB" : b >= 2 ** 20 ? (b / 2 ** 20).toFixed(0) + " MB" : b >= 1024 ? (b / 1024).toFixed(1) + " KB" : b + " B",
  pct: x => x == null ? "–" : Math.round(x * 100) + "%",
  ago: s => s == null ? "–" : s < 2 ? "just now" : s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : Math.round(s / 3600) + "h ago",
  dur: s => s == null ? "–" : s < 60 ? Math.round(s) + "s" : s < 3600 ? Math.floor(s / 60) + "m " + Math.round(s % 60) + "s" : Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m",
  layers: (lo, hi) => hi - lo === 1 ? `${lo}` : `${lo}–${hi - 1}`,
  time: ts => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
};

/** Collapse a sorted list of ints into ranges: [1,2,3,7] -> "1–3, 7" */
export function ranges(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? `${list[i]}` : `${list[i]}–${list[j]}`);
    i = j;
  }
  return out.join(", ");
}

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const uid = () => Math.random().toString(36).slice(2, 10);
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduce-effects");
