// Appearance: System / Light / Dark, plus "Reduce visual effects".
import { settings, on, emit } from "./store.js";
import { invalidateColors } from "./tokens.js";
import { setNativeTheme } from "./native.js";

const mq = matchMedia("(prefers-color-scheme: light)");
export function applyTheme() {
  const t = settings.theme;
  const resolved = t === "system" ? (mq.matches ? "light" : "dark") : t;
  const root = document.documentElement;
  if (root.dataset.resolvedTheme !== resolved) {
    root.dataset.resolvedTheme = resolved;
    invalidateColors();
    emit("theme", resolved);
  }
  root.classList.toggle("reduce-effects", !!settings.reduceEffects);
}
export function initTheme() {
  applyTheme();
  setNativeTheme(settings.theme);
  mq.addEventListener("change", applyTheme);
  matchMedia("(prefers-contrast: more)").addEventListener("change", () => { invalidateColors(); emit("theme"); });
  on("setting", ({ k }) => {
    if (k === "theme") { applyTheme(); setNativeTheme(settings.theme); }
    if (k === "reduceEffects") applyTheme();
  });
}
