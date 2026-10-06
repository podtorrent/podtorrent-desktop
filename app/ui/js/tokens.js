// Typed mirror of css/tokens.css for code that can't use CSS variables (canvas, charts).
// Colors are read live from the CSS so light/dark/contrast always match. See tokens.d.ts.

/** @typedef {"serving"|"active"|"degraded"|"gap"|"you"|"net"} SemanticColor */

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 };
export const radius = { sm: 6, md: 10, lg: 14 };
export const type = { 1: 11, 2: 12, 3: 13, 4: 15, 5: 20, 6: 28, 7: 44 };
export const motion = {
  duration: { fast: 120, base: 200, slow: 360 },
  /** spring presets for JS-driven animation: stiffness, damping (critically damped ≈ 2*sqrt(k)) */
  spring: { snappy: { k: 420, c: 30 }, smooth: { k: 220, c: 28 }, gentle: { k: 120, c: 22 } },
};
export const fonts = {
  ui: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
};

let cache = null;
/** @returns {Record<string,string>} resolved colors for the current theme */
export function colors() {
  if (cache) return cache;
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  cache = {
    serving: v("--c-serving"), active: v("--c-active"), degraded: v("--c-degraded"), gap: v("--c-gap"),
    you: v("--c-you"), net: v("--c-net"), accent: v("--accent"),
    fg1: v("--fg-1"), fg2: v("--fg-2"), fg3: v("--fg-3"), fg4: v("--fg-4"),
    line1: v("--line-1"), line2: v("--line-2"), bg: v("--bg-content"), elev1: v("--bg-elev-1"), elev2: v("--bg-elev-2"), sunken: v("--bg-sunken"),
  };
  return cache;
}
export function invalidateColors() { cache = null; }

/** "#rrggbb" + alpha -> rgba() */
export function alpha(hex, a) {
  if (!hex || hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
