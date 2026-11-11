// Keyboard shortcuts. In the app, menu-bar accelerators own the ⌘ shortcuts (and arrive as
// "menu" events); in a plain browser the same keys are handled here.
import { h } from "./dom.js";
import { on, emit } from "./store.js";
import { kbd, sheet, sheetOpen } from "./ui.js";
import { isMacApp } from "./native.js";
import { handleMenu, go } from "./actions.js";
import { openPalette, paletteOpen } from "./palette.js";

export const SHORTCUTS = [
  ["Navigation", [["Swarm", "⌘ 1"], ["Models", "⌘ 2"], ["Playground", "⌘ 3"], ["My Node", "⌘ 4"], ["Peers", "⌘ 5"], ["Activity", "⌘ 6"], ["Video", "⌘ 7"], ["Settings", "⌘ ,"]]],
  ["Anywhere", [["Command palette", "⌘ K"], ["Toggle sidebar", "⌘ \\"], ["Toggle inspector", "⌘ I"], ["Graph / grid", "⌘ G"], ["Shortcuts", "?"], ["Close sheet or palette", "esc"]]],
  ["Node", [["Start my node", "⇧ ⌘ H"], ["Load model", "⇧ ⌘ L"], ["Stop node", "⇧ ⌘ ."], ["Close window (keeps running)", "⌘ W"], ["Quit", "⌘ Q"]]],
  ["Playground", [["Send", "↵"], ["New line", "⇧ ↵"]]],
];

export function showShortcuts() {
  sheet({
    title: "Keyboard shortcuts", wide: true,
    body: h("div.shortcut-grid", SHORTCUTS.map(([g, list]) => h("div", h("div.caps", { style: { marginBottom: "8px" } }, g), h("div.kv-list", list.map(([t, k]) => [h("span", t), kbd(k)]))))),
  });
}

const MAP = {
  "Digit1": "nav:swarm", "Digit2": "nav:models", "Digit3": "nav:playground", "Digit4": "nav:node", "Digit5": "nav:peers", "Digit6": "nav:activity",
  "Comma": "settings", "KeyK": "palette", "Backslash": "toggle-sidebar", "KeyI": "inspector", "KeyG": "swarm-layout", "Slash": "shortcuts",
};
const SHIFT = { "KeyH": "node:start-host", "KeyJ": "node:join", "KeyL": "node:load", "Period": "node:stop" };

export function initShortcuts() {
  on("palette", openPalette);
  on("shortcuts", showShortcuts);
  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.metaKey || e.ctrlKey) {
      // In the macOS app the menu bar handles these; letting the event through avoids double-firing.
      if (isMacApp) return;
      let id = null;
      if (e.shiftKey) id = SHIFT[e.code];
      else if (!e.altKey) id = MAP[e.code];
      if (id) { e.preventDefault(); handleMenu(id); }
      return;
    }
    if (typing || sheetOpen() || paletteOpen()) return;
    if (e.key === "?") { e.preventDefault(); emit("shortcuts"); }
  });
}
export { go };
