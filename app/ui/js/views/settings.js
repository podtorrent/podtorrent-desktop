// Settings: appearance, motion, notifications, Developer (Demo Mode), shortcuts, about.
import { h, text } from "../dom.js";
import { state, settings, setSetting, emit } from "../store.js";
import { segmented, toggle, button, kbd } from "../ui.js";
import { setDemo, setDemoPreset } from "../actions.js";
import { presets } from "../demo.js";
import { perf } from "../perf.js";
import { isTauri, T } from "../native.js";
import { storagePicker } from "../storage.js";
import { networkPanel } from "../network.js";

const row = (title, desc, control) => h("div.list-row", h("div.grow", h("div.t", title), desc ? h("div.d", desc) : null), control);

export default {
  title: "Settings",
  mount(root) {
    const theme = segmented([{ value: "system", label: "System" }, { value: "light", icon: "sun", label: "Light" }, { value: "dark", icon: "moon", label: "Dark" }], settings.theme, v => setSetting("theme", v), "Appearance");
    const reduce = toggle(settings.reduceEffects, v => setSetting("reduceEffects", v), "Reduce visual effects");
    const notif = toggle(settings.notifications, v => setSetting("notifications", v), "Notifications");
    const demo = toggle(settings.demo, v => setDemo(v), "Demo Mode");
    const auto = toggle(settings.demoAutoplay, v => setSetting("demoAutoplay", v), "Ambient traffic");
    const preset = segmented(Object.entries(presets).map(([k, p]) => ({ value: k, label: p.label, tip: p.hint })), settings.demoPreset, v => setDemoPreset(v), "Demo preset");
    const presetHint = h("div.d");
    const perfLine = h("div.d");
    const version = h("span", "PodTorrent");
    T?.app?.getVersion().then(v => text(version, `PodTorrent ${v}`)).catch(() => {});
    root.append(h("div.page.settings",
      h("h1", "Settings"),
      h("section.card", h("div.card-h", h("h2", "Appearance")),
        row("Theme", "Dark-first; light is equally supported.", theme),
        row("Reduce visual effects", "Static graph, no glow or glass blur. Also follows the system's reduce-motion setting.", reduce),
        h("div.list-row", h("div.grow", h("div.t", "Animation budget"), perfLine))),
      isTauri ? h("section.card", h("div.card-h", h("h2", "Storage")),
        h("div.list-row", h("div.grow", h("div.t", "Data folder"), h("div.d", "Models, the Python environment and logs. Change it if this drive is full; stop your node first. Downloaded models aren't moved."), storagePicker()))) : null,
      isTauri ? h("section.card", h("div.card-h", h("h2", "PodTorrent Network")),
        h("div.list-row", h("div.grow", h("div.t", "Serve network clients"), h("div.d", "Offer the models your swarm fully covers to PodTorrent network clients, with this Mac as the head of the route. Needs an approved node id and token."), networkPanel()))) : null,
      h("section.card", h("div.card-h", h("h2", "Notifications")),
        row("Swarm notifications", "Peer joined or left, model fully covered, contribution milestones. Only when PodTorrent isn't in front.", notif)),
      h("section.card", h("div.card-h", h("h2", "Developer"), h("span.spacer"), h("span.badge.demo", "Demo")),
        row("Demo Mode", h("span", "Drive every view from a simulated swarm, for screenshots and recordings. Your real node keeps running. ", kbd("⌥ ⌘ D")), demo),
        h("div.list-row", h("div.grow", h("div.t", "Preset"), presetHint), preset),
        row("Ambient traffic", "Simulated prompts every few seconds, so the graph shows tokens moving.", auto)),
      h("section.card", h("div.card-h", h("h2", "Help")),
        row("Keyboard shortcuts", "Every primary action has one.", button("Show", { icon: "keyboard", onclick: () => emit("shortcuts") })),
        row("Welcome tour", "The three-step introduction from first launch.", button("Replay", { onclick: () => emit("onboarding") }))),
      h("section.card", h("div.card-h", h("h2", "About")),
        h("div.card-b.small.muted", version, " · ", isTauri ? "Desktop app" : "Browser preview", " · Engine output in engine.log in the data folder. Peers connect directly over encrypted QUIC; the local API on 127.0.0.1:27183 is reachable from this machine only."))));
    return {
      update(s) {
        theme.set(settings.theme); reduce.set(settings.reduceEffects); notif.set(settings.notifications);
        demo.set(s.source === "demo"); auto.set(settings.demoAutoplay); preset.set(settings.demoPreset);
        text(presetHint, presets[settings.demoPreset]?.hint || "");
        const p = perf();
        text(perfLine, p.level === "full" ? "Full: 60 fps while something moves, idle otherwise." : `${p.level === "paused" ? "Paused" : `${p.fps} fps cap`} because ${p.reasons.join(", ")}.`);
      },
    };
  },
};
