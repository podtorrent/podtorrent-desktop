// First-run welcome: what PodTorrent is → how much of this Mac to share → joining the swarm.
// Skippable; replay from Help or Settings. Ends on Swarm, where your node animates in.
import { h, fmt } from "./dom.js";
import { state, settings, setSetting, on } from "./store.js";
import { icon } from "./icons.js";
import { button } from "./ui.js";
import { go, setDemo } from "./actions.js";
import { startHost } from "./engine.js";

export function initOnboarding() {
  on("onboarding", () => openOnboarding());
  if (!settings.onboarded) setTimeout(openOnboarding, 350);
}

export function openOnboarding() {
  let step = 0;
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
        h("h1", "Many Macs, one model"),
        h("p", "PodTorrent splits a large model into blocks, one per layer. Each Mac holds a slice; every token hops between them. Together they run a model none of them could hold alone."),
      ],
      () => [
        h("h1", "How much of this Mac to share"),
        h("p", hl ? `This Mac has ${fmt.gb(hl.mem_total_gb)} of unified memory (${hl.chip || "Apple Silicon"}). Its slice of Qwen3-30B-A3B uses about 8.5 GB, roughly ${fmt.pct(8.5 / hl.mem_total_gb)}, until you stop the node.` : "Each Mac holds about 8.5 GB of the model (half of Qwen3-30B-A3B, 4-bit) until you stop the node."),
        h("p", "Every Mac is an equal peer. It serves a slice to the swarm and can chat with the whole model. Peers find each other automatically and connect directly, even across different networks. There's no address to type and no VPN."),
      ],
      () => [
        h("h1", "Join the swarm"),
        h("p", "Start your node. Other Macs running PodTorrent show up within seconds. Once one is connected, Load model splits the layers between you."),
        h("div.onb-actions",
          button("Start My Node", { variant: "primary", size: "xl", icon: "play", onclick: () => { finish("swarm"); startHost(); } }),
          button("Explore Demo first", { size: "xl", icon: "sparkle", onclick: () => { finish("swarm"); setDemo(true); } })),
      ],
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
