// Settings: appearance, motion, notifications, shortcuts, about.
import { h, text } from "../dom.js";
import { state, settings, setSetting, emit } from "../store.js";
import { segmented, toggle, button } from "../ui.js";
import { perf } from "../perf.js";
import { isTauri, T } from "../native.js";
import { storagePicker } from "../storage.js";

const row = (title, desc, control) => h("div.list-row", h("div.grow", h("div.t", title), desc ? h("div.d", desc) : null), control);

export default {
  title: "Settings",
  mount(root) {
    const theme = segmented([{ value: "system", label: "System" }, { value: "light", icon: "sun", label: "Light" }, { value: "dark", icon: "moon", label: "Dark" }], settings.theme, v => setSetting("theme", v), "Appearance");
    const reduce = toggle(settings.reduceEffects, v => setSetting("reduceEffects", v), "Reduce visual effects");
    const notif = toggle(settings.notifications, v => setSetting("notifications", v), "Notifications");
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
      h("section.card", h("div.card-h", h("h2", "Notifications")),
        row("Swarm notifications", "Peer joined or left, model fully covered, contribution milestones. Only when PodTorrent isn't in front.", notif)),
      h("section.card", h("div.card-h", h("h2", "Help")),
        row("Keyboard shortcuts", "Every primary action has one.", button("Show", { icon: "keyboard", onclick: () => emit("shortcuts") })),
        row("Welcome tour", "The three-step introduction from first launch.", button("Replay", { onclick: () => emit("onboarding") }))),
      h("section.card", h("div.card-h", h("h2", "About")),
        h("div.card-b.small.muted", version, " · ", isTauri ? "Desktop app" : "Browser preview", " · Engine output in engine.log in the data folder. Peers connect directly over encrypted QUIC; the local API on 127.0.0.1:27183 is reachable from this machine only."))));
    return {
      update(s) {
        theme.set(settings.theme); reduce.set(settings.reduceEffects); notif.set(settings.notifications);
        const p = perf();
        text(perfLine, p.level === "full" ? "Full: 60 fps while something moves, idle otherwise." : `${p.level === "paused" ? "Paused" : `${p.fps} fps cap`} because ${p.reasons.join(", ")}.`);
      },
    };
  },
};
