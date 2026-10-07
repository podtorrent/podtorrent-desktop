// First-run welcome: what PodTorrent is → how much of this Mac to share → joining the swarm.
// Skippable; replay from Help or Settings. Ends on Swarm, where your node animates in.
import { h, fmt } from "./dom.js";
import { state, settings, setSetting, on } from "./store.js";
import { icon } from "./icons.js";
import { button } from "./ui.js";
import { go, setDemo } from "./actions.js";
import { startHost, joinHost } from "./engine.js";

export function initOnboarding() {
  on("onboarding", () => openOnboarding());
  if (!settings.onboarded) setTimeout(openOnboarding, 350);
}

export function openOnboarding() {
  let step = 0, role = state.role || "host";
  const scrim = h("div.scrim.onb-scrim");
  const card = h("div.onb.card", { role: "dialog", "aria-modal": "true", "aria-label": "Welcome to PodTorrent" });
  document.body.append(scrim, card);
  requestAnimationFrame(() => { scrim.classList.add("show"); card.classList.add("show"); });
  const dots = () => h("div.onb-dots", [0, 1, 2].map(i => h(`i${i === step ? ".on" : ""}`)));
  const finish = (to = "swarm") => {
    setSetting("onboarded", true);
    scrim.classList.remove("show"); card.classList.remove("show");
    setTimeout(() => { scrim.remove(); card.remove(); }, 300);
    document.removeEventListener("keydown", key, true);
    go(to);
  };
  const key = e => { if (e.key === "Escape") { e.preventDefault(); finish(); } };
  document.addEventListener("keydown", key, true);

  function render() {
    const hl = state.health;
    const pages = [
      () => [
        h("div.onb-art", h("div.onb-strip", Array.from({ length: 24 }, (_, i) => h("i", { style: { animationDelay: i * 40 + "ms" }, class: i < 12 ? "a" : "b" }))),
          h("div.onb-macs", h("span", icon("node"), "Mac 1"), h("span", icon("node"), "Mac 2"))),
        h("h1", "Two Macs, one model"),
        h("p", "PodTorrent splits a large model into blocks, one per layer. Each Mac holds a slice; every token hops between them. Together they run a model neither could hold alone."),
      ],
      () => [
        h("h1", "How much of this Mac to share"),
        h("p", hl ? `This Mac has ${fmt.gb(hl.mem_total_gb)} of unified memory (${hl.chip || "Apple Silicon"}). Its slice of Qwen3-30B-A3B uses about 8.5 GB, roughly ${fmt.pct(8.5 / hl.mem_total_gb)}, until you stop the node.` : "Each Mac holds about 8.5 GB of the model (half of Qwen3-30B-A3B, 4-bit) until you stop the node."),
        h("div.onb-roles", ...[["host", "host", "Host", "Runs the dashboard and chat, plus layers 0–23. Pick this on the Mac you'll type on."], ["worker", "layers", "Worker", "Contributes layers 24–47 to a host over Tailscale."]].map(([r, ic, t, d]) =>
          h("button.onb-role", { type: "button", "aria-pressed": String(role === r), onclick: () => { role = r; render(); } }, h("div.role-ic", icon(ic)), h("b", t), h("span.small.muted", d)))),
      ],
      () => {
        const addr = h("input.input.mono", { placeholder: "Host address, e.g. 100.64.0.2:8000", value: settings.hostAddr || "", "aria-label": "Host address" });
        return [
          h("h1", role === "host" ? "Start the swarm" : "Join the swarm"),
          h("p", role === "host" ? "Start your node. The other Mac joins with the address shown on My Node, then you load the model." : "Enter the host's Tailscale address. Your Mac registers with it and waits for the host to assign layers."),
          role === "worker" ? addr : null,
          h("div.onb-actions",
            role === "host" ? button("Start as Host", { variant: "primary", size: "xl", icon: "play", onclick: () => { finish("swarm"); startHost(); } })
              : button("Join Host", { variant: "primary", size: "xl", icon: "link", onclick: () => { finish("swarm"); joinHost(addr.value); } }),
            button("Explore Demo first", { size: "xl", icon: "sparkle", onclick: () => { finish("swarm"); setDemo(true); } })),
        ];
      },
    ];
    card.replaceChildren(
      h("div.onb-body", ...pages[step]()),
      h("div.onb-f", dots(), h("span.spacer"),
        button("Skip", { variant: "ghost", onclick: () => finish() }),
        step > 0 ? button("Back", { onclick: () => { step--; render(); } }) : null,
        step < 2 ? button("Continue", { variant: "primary", onclick: () => { step++; render(); } }) : null));
    (card.querySelector(".onb-f .btn.primary") || card.querySelector("input") || card.querySelector(".btn.primary"))?.focus();
  }
  render();
}
