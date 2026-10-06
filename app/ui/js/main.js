// Boot: show the shell immediately, then stream data in.
import { state, settings, sample, commit, on } from "./store.js";
import { initNative, listen, isTauri } from "./native.js";
import { initTheme } from "./theme.js";
import { mountOverlays } from "./ui.js";
import { mountShell } from "./shell.js";
import { initShortcuts } from "./shortcuts.js";
import { initOnboarding } from "./onboarding.js";
import { handleMenu } from "./actions.js";
import { attachExisting, initDownloads } from "./engine.js";
import { startDemo } from "./demo.js";

initTheme();
mountOverlays();
mountShell();
initShortcuts();
initNative();
listen("menu", handleMenu);

setInterval(sample, 1000);
document.addEventListener("visibilitychange", commit);
addEventListener("focus", commit);
addEventListener("blur", commit);

(async () => {
  if (settings.demo) startDemo(settings.demoPreset);
  else await attachExisting();
  state.booted = true;
  initDownloads();
  initOnboarding();
  commit();
})();
