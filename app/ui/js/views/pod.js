// Pod: who this machine serves with (docs/PODS_PLAN.md). Public swarm (no pod), a private pod of
// invited machines with a layer split per model, or alone (a pod of one). In a pod the machine links
// with, routes through and loads layers for members only, and only a plan's head joins the network.
import { h, text, fmt } from "../dom.js";
import { state } from "../store.js";
import { button, armedButton, toast, empty, badge } from "../ui.js";
import { podApi } from "../engine.js";
import { copyText } from "../actions.js";

let view = null; // last /api/pod, for the sidebar and the Network page

export const podView = () => view;

async function poll() {
  try { view = await podApi(); } catch { view = null; /* engine not running */ }
  return view;
}
poll(); setInterval(poll, 3000); // the Network page reads it too

const field = (label, input, hint) => h("div.field", h("label", label), input, hint ? h("div.small.faint", hint) : null);
const shortModel = m => (m || "").split("/").pop();

export default {
  title: "Pod",
  subtitle: () => !view ? "Start your node first" : !view.pod ? "Waiting for a public pod"
    : `${view.pod.name} · ${view.pod.kind === "alone" ? "alone" : `${view.pod.members.length} machines`}`,
  mount(root) {
    const page = h("div.page.pod");
    root.append(page);
    let busy = false, invite = null;

    async function act(fn, ok) {
      if (busy) return;
      busy = true;
      try { view = await fn(); if (ok) toast(ok, "serving"); } catch (e) { toast("Couldn't do that", "degraded", e.message); }
      busy = false;
      paint();
    }

    // ---- no pod: choose ----
    function choose() {
      const name = h("input.input", { placeholder: "home", "aria-label": "Pod name", maxLength: 64 });
      const code = h("input.input.mono", { placeholder: "pod1-…", spellcheck: "false", autocomplete: "off", "aria-label": "Invite code" });
      const soloName = h("input.input", { placeholder: "solo", "aria-label": "Pod name", maxLength: 64 });
      return [
        h("section.card", h("div.card-h", h("h2", "Public swarm"), h("span.spacer"), badge("This machine", "serving")),
          h("div.card-b.small.muted", "This machine is in no pod yet. The matchmaker puts it in a public pod with other machines that have the same model on disk, once together they cover all its layers. Pick a private pod or alone below to serve only with machines you choose.")),
        h("section.card", h("div.card-h", h("h2", "Private pod")),
          h("div.card-b",
            h("p.small.muted", "Serve with machines you invite. You split each model's layers between them, and nobody else can connect to them."),
            h("div.net-grid",
              h("div", field("Start a pod", name, "This machine becomes its owner."),
                h("div.net-actions", button("Create pod", { variant: "primary", onclick: () =>
                  act(() => podApi("/create", { name: name.value, kind: "private" }), "Pod created") }))),
              h("div", field("Join a pod", code, "Paste the invite code from the pod's owner. The owner's machine must be online."),
                h("div.net-actions", button("Join", { onclick: () =>
                  act(() => podApi("/join", { code: code.value }, 60000), "Joined the pod") })))))),
        h("section.card", h("div.card-h", h("h2", "Alone")),
          h("div.card-b",
            h("p.small.muted", "Serve whole models on this machine only, linking with no other machine. It can still join the PodTorrent network as its own node."),
            h("div.net-grid", field("Name", soloName)),
            h("div.net-actions", button("Serve alone", { onclick: () =>
              act(() => podApi("/create", { name: soloName.value || "solo", kind: "alone" }), "Serving alone") })))),
      ];
    }

    // ---- in a pod ----
    function members(v) {
      const owner = v.pod.owner;
      return h("section.card", h("div.card-h", h("h2", "Machines"), h("span.spacer"),
        v.pod.kind === "private" && v.owner ? button("Invite machine", { variant: "primary", size: "sm", icon: "person",
          onclick: () => act(async () => { invite = await podApi("/invite", {}); return podApi(); }) }) : null),
        invite ? h("div.card-b.pod-invite",
          h("div.small.muted", `Single-use invite, valid until ${new Date(invite.expires * 1000).toLocaleString()}. On the other machine: Pod → Join a pod.`),
          h("div.row", h("code.mono.grow.ellipsis", invite.code),
            button("Copy", { size: "sm", icon: "copy", onclick: () => copyText(invite.code, "Invite code copied") }))) : null,
        ...v.members.map(m => h("div.list-row",
          h("div.grow",
            h("div.t", m.name, m.me ? h("span.small.faint", " (you)") : null, m.peer_id === owner ? h("span.small.faint", " · owner") : null,
              m.public ? h("span.small.faint", " · public") : null),
            h("div.d", [m.chip, m.mem_total_gb ? `${m.mem_total_gb} GB` : null,
              ...(m.slices || []).filter(x => x.loaded).map(x => `${shortModel(x.model)} ${fmt.layers(x.lo, x.hi)}`)].filter(Boolean).join(" · ") || "—")),
          badge(m.me ? "This machine" : m.state === "direct" ? `Linked${m.rtt_ms ? ` · ${Math.round(m.rtt_ms)} ms` : ""}` : m.online ? "Connecting" : "Offline",
            m.me || m.state === "direct" ? "serving" : m.online ? "degraded" : "neutral", { dot: true }),
          v.owner && !m.me ? armedButton("Remove", "Remove?", () => act(() => podApi("/remove", { peer_id: m.peer_id }), `Removed ${m.name}`), { size: "sm" }) : null)));
    }

    function plans(v) {
      const names = Object.fromEntries(v.members.map(m => [m.peer_id, m.name]));
      const model = h("input.input.mono", { placeholder: state.hostInfo?.repo || "mlx-community/…", spellcheck: "false", "aria-label": "Model" });
      const rows = v.pod.plans.map(p => {
        const multi = p.hops.length > 1;
        // Custom split: one boundary per hand-off, and the head.
        const bounds = p.hops.slice(0, -1).map(x => h("input.input.num", { type: "number", min: "1", max: String(p.layers - 1), value: x.hi, "aria-label": `Where ${names[x.peer]}'s layers end` }));
        const head = h("select.input", { "aria-label": "Head" }, ...p.hops.map(x => h("option", { value: x.peer, selected: x.peer === p.head }, names[x.peer])));
        const save = () => {
          let at = 0;
          const hops = p.hops.map((x, i) => { const hi = i < bounds.length ? Number(bounds[i].value) : p.layers; const hop = { peer: x.peer, lo: at, hi }; at = hi; return hop; });
          act(() => podApi("/plan", { model: p.model, layers: p.layers, head: head.value, hops }), "Split saved");
        };
        return h("div.list-row.pod-plan",
          h("div.grow",
            h("div.t.mono", p.model),
            h("div.d", p.hops.map(x => `${names[x.peer] || x.peer.slice(0, 8)} ${fmt.layers(x.lo, x.hi)}`).join("  →  "), ` · head ${names[p.head] || p.head.slice(0, 8)}`),
            v.owner && multi ? h("div.row.pod-split", h("span.small.faint", "Split at"), ...bounds, h("span.small.faint", "Head"), head, button("Save", { size: "sm", onclick: save })) : null),
          v.owner ? armedButton("Remove", "Remove?", () => act(() => podApi("/unplan", { model: p.model }), "Plan removed"), { size: "sm" }) : null);
      });
      return h("section.card", h("div.card-h", h("h2", "Models")),
        h("div.card-b.small.muted", "Each model's layers are split between the pod's machines. Every machine downloads and serves its own share; the head serves the model on the network."),
        ...rows,
        v.owner ? h("div.card-b", h("div.row",
          h("div.grow", model),
          button(v.pod.kind === "alone" ? "Serve whole model" : "Split by memory", { variant: "primary", onclick: () =>
            act(() => podApi("/plan", { model: model.value || state.hostInfo?.repo }), "Plan saved") }))) : null);
    }

    function inPod(v) {
      const p = v.pod;
      return [
        h("section.card", h("div.card-h", h("h2", p.name), h("span.spacer"),
          badge(p.kind === "alone" ? "Alone" : p.kind === "public" ? "Public pod" : "Private pod", "active"),
          // A public pod is the matchmaker's: leaving it would only put this machine back in the lobby.
          p.kind === "public" ? null : armedButton(v.owner && p.kind !== "alone" ? "Disband pod" : "Leave pod", v.owner && p.kind !== "alone" ? "Disband?" : "Leave?",
            () => act(() => podApi("/leave", {}), "Back in the public swarm"), { size: "sm" })),
          h("div.card-b.small.muted", p.kind === "alone" ? "This machine serves whole models by itself and links with no other machine."
            : p.kind === "public" ? "The matchmaker put this machine in a public pod with these machines. Only they connect to each other, each serving its share of the layers. Create a private pod or serve alone to leave it."
            : v.owner ? "You own this pod: you invite and remove machines and split the models. Only these machines can connect to each other. Disbanding sends every machine back to the public swarm."
            : "Only this pod's machines can connect to this one. The owner decides which layers it serves.",
            v.heads?.length ? ` This machine is the head of ${v.heads.map(shortModel).join(", ")}: join the network from the Network page.` : "")),
        p.kind === "alone" ? null : members(v),
        plans(v),
        ...(p.kind === "public" ? choose().slice(1) : []),   // private pod or alone, to leave the public pod
      ];
    }

    function paint() {
      if (!view) {
        page.replaceChildren(empty({ icon: "peers", title: "Start your node first", body: "The pod lives in this machine's node." }));
        return;
      }
      page.replaceChildren(...(view.pod ? inPod(view) : choose()).filter(Boolean));
    }

    let key = "";
    async function refresh() {
      const v = await poll();
      // Latency changes on every poll; repainting for it would wipe half-typed fields.
      const k = JSON.stringify(v, (key, x) => key === "rtt_ms" ? undefined : x);
      if (k !== key && !busy && !page.contains(document.activeElement)) { key = k; paint(); }
    }
    paint();
    refresh();
    const timer = setInterval(refresh, 3000);
    return { unmount() { clearInterval(timer); } };
  },
};
