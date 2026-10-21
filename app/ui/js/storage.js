// Where this machine keeps models, the Python environment and logs. Windows users often have a
// full C: drive, so onboarding and Settings both let them pick another folder or drive.
import { h, text, fmt } from "./dom.js";
import { state } from "./store.js";
import { button, toast } from "./ui.js";
import { invoke, isTauri } from "./native.js";

/** A path line with free space, plus Change… and Use Default. Null outside the app. */
export function storagePicker() {
  if (!isTauri) return null;
  const path = h("code.small", "…");
  const free = h("div.small.faint");
  const reset = button("Use Default", { variant: "ghost", onclick: () => apply(null) });
  const show = loc => {
    text(path, loc.path);
    text(free, loc.free_gb == null ? "" : `${fmt.gb(loc.free_gb)} free on this drive${loc.free_gb < 20 ? ". Pick a drive with more room." : ""}`);
    free.style.color = loc.free_gb != null && loc.free_gb < 20 ? "var(--c-degraded)" : "";
    reset.hidden = loc.default;
  };
  async function apply(p) {
    if (state.engine.phase === "running" || state.engine.phase === "starting") {
      toast("Stop your node first", "degraded", "The storage folder can only change while the node is stopped.");
      return;
    }
    try {
      show(await invoke("set_data_location", { path: p }));
      toast("Storage folder changed", "serving", "New downloads go here. Models already downloaded stay in the old folder; delete or move them yourself.");
    } catch (e) { toast("Couldn't use that folder", "degraded", String(e)); }
  }
  const change = button("Change…", { icon: "download", onclick: async () => { const p = await invoke("pick_folder").catch(() => null); if (p) apply(p); } });
  invoke("data_location").then(show).catch(() => {});
  return h("div.storage-pick", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
    h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, path, h("span.spacer"), change, reset), free,
    h("div.small.faint", "PodTorrent may need 10–50 GB of storage, depending on the models you serve."));
}
