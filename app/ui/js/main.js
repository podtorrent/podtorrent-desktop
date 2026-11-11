// Boot: show the shell immediately, then stream data in.
import { state, settings, sample, commit, on } from "./store.js";
import { initNative, listen, isTauri, pollHealth } from "./native.js";
import { initTheme } from "./theme.js";
import { mountOverlays } from "./ui.js";
import { mountShell } from "./shell.js";
import { initShortcuts } from "./shortcuts.js";
import { initOnboarding } from "./onboarding.js";
import { handleMenu } from "./actions.js";
import { attachExisting } from "./engine.js";
import { loadValuation } from "./valuation.js";
import { initLobby } from "./lobby.js";

initTheme();
mountOverlays();
mountShell();
initShortcuts();
initNative();
loadValuation();
listen("menu", handleMenu);
initLobby();

setInterval(sample, 1000);
document.addEventListener("visibilitychange", commit);
addEventListener("focus", commit);
addEventListener("blur", commit);

(async () => {
  await attachExisting();
  state.booted = true;
  initOnboarding();
  commit();
})();
