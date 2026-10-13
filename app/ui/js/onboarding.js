// First-run welcome: name this Mac → choose what to serve (or nothing) → done. No roles, no
// addresses: every Mac is an equal peer and finds the others itself. Skippable; replay from
// Help or Settings. The chosen slice is served as soon as the peer is up (settings.pendingServe).
import { h, fmt } from "./dom.js";
import { state, settings, setSetting, on } from "./store.js";
import { icon } from "./icons.js";
import { button } from "./ui.js";
import { go, setDemo } from "./actions.js";
import { startHost } from "./engine.js";

const REPO = "mlx-community/Qwen3-30B-A3B-4bit", LAYERS = 48, GB_PER_LAYER = 0.33;

export function initOnboarding() {
  on("onboarding", () => openOnboarding());
  if (!settings.onboarded) setTimeout(openOnboarding, 350);
}

export function openOnboarding() {
  let step = 0;
  let name = settings.peerName || "";
  const mem = state.health?.mem_total_gb;
  const CHOICES = [
    { id: "none", t: "Nothing for now", d: "Join the swarm and chat with any model it covers. Serve layers later from Models." },
    { id: "a", t: "Layers 0–23", d: `First half of Qwen3-30B-A3B · about ${fmt.gb(24 * GB_PER_LAYER)}`, lo: 0, hi: 24 },
    { id: "b", t: "Layers 24–47", d: `Second half · about ${fmt.gb(24 * GB_PER_LAYER)}`, lo: 24, hi: 48 },
    { id: "q", t: "Layers 0–11", d: `A quarter, for a smaller machine · about ${fmt.gb(12 * GB_PER_LAYER)}`, lo: 0, hi: 12 },
  ];
  // Fits comfortably: macOS lets the GPU use about 75% of RAM, minus ~1 GB for the requester's head.
  const fits = c => !c.hi || !mem || (c.hi - c.lo) * GB_PER_LAYER + 1 <= mem * 0.75 - 2;
  let pick = settings.pendingServe ? CHOICES.find(c => c.lo === settings.pendingServe.lo && c.hi === settings.pendingServe.hi)?.id || "none"
    : fits(CHOICES[1]) ? "a" : "q";

  const scrim = h("div.scrim.onb-scrim");
  const card = h("div.onb.card", { role: "dialog", "aria-modal": "true", "aria-label": "Welcome to PodTorrent" });
  document.body.append(scrim, card);
  requestAnimationFrame(() => { scrim.classList.add("show"); card.classList.add("show"); });
  const dots = () => h("div.onb-dots", [0, 1, 2].map(i => h(`i${i === step ? ".on" : ""}`)));
  const save = () => {
    setSetting("peerName", name.trim().slice(0, 40));
    const c = CHOICES.find(x => x.id === pick);
    setSetting("pendingServe", c?.hi ? { model: REPO, lo: c.lo, hi: c.hi } : null);
  };
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
    const pages = [
      () => {
        const input = h("input.input", { value: name, placeholder: "e.g. studio, logesh-air", maxlength: "40", "aria-label": "Name for this machine", oninput: e => { name = e.target.value; } });
        return [
          h("div.onb-art", h("div.onb-strip", Array.from({ length: 24 }, (_, i) => h("i", { style: { animationDelay: i * 40 + "ms" }, class: i < 12 ? "a" : "b" }))),
            h("div.onb-macs", h("span", icon("node"), "This machine"), h("span", icon("node"), "Any other machine"))),
          h("h1", "Name this machine"),
          h("p", "PodTorrent splits large models into layers. Each machine serves a slice, and every token hops between them, so together they run models none of them could hold alone. Other machines in the swarm see this name."),
          h("div.field", input, h("div.small.faint", "Leave empty to use this machine's hostname.")),
        ];
      },
      () => [
        h("h1", "What should this machine serve?"),
        h("p", mem ? `This machine has ${fmt.gb(mem)} of memory. You can change this any time, and serve more models later.` : "You can change this any time, and serve more models later."),
        h("div.onb-roles", { role: "radiogroup", "aria-label": "What to serve" }, CHOICES.map(c => h("button.onb-role", {
          type: "button", role: "radio", "aria-pressed": String(pick === c.id), "aria-checked": String(pick === c.id),
          onclick: () => { pick = c.id; render(); },
        }, h("b", c.t), h("span.small.muted", c.d), !fits(c) ? h("span.small", { style: { color: "var(--c-degraded)" } }, "May not fit on this machine") : null))),
      ],
      () => {
        const c = CHOICES.find(x => x.id === pick);
        return [
          h("h1", "Join the swarm"),
          h("p", `${name.trim() || "This machine"} will ${c?.hi ? `serve ${c.t.toLowerCase()} of Qwen3-30B-A3B, downloading only those layers` : "join without serving anything"}. Other machines running PodTorrent show up within seconds, on any network, and connect directly. There's no address to type and no VPN.`),
          h("div.onb-actions",
            button("Start My Node", { variant: "primary", size: "xl", icon: "play", onclick: () => { save(); finish("models"); startHost(); } }),
            button("Explore Demo first", { size: "xl", icon: "sparkle", onclick: () => { save(); finish("swarm"); setDemo(true); } })),
        ];
      },
    ];
    card.replaceChildren(
      h("div.onb-body", ...pages[step]()),
      h("div.onb-f", dots(), h("span.spacer"),
        button("Skip", { variant: "ghost", onclick: () => finish() }),
        step > 0 ? button("Back", { onclick: () => { step--; render(); } }) : null,
        step < 2 ? button("Continue", { variant: "primary", onclick: () => { save(); step++; render(); } }) : null));
    (card.querySelector("input") || card.querySelector(".onb-f .btn.primary") || card.querySelector(".btn.primary"))?.focus();
  }
  render();
}
