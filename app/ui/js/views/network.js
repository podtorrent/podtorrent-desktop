// Network: put this Mac on the PodTorrent network. The bundled podtorrent-agent offers the models
// the swarm fully covers to network clients, with this Mac as the head of each route. Revenue goes
// to this node's operator. Needs a node id and node token from an approved registration.
import { h, text } from "../dom.js";
import { button, toast, empty } from "../ui.js";
import { invoke, isTauri } from "../native.js";

let status = null; // last network_status, for the toolbar subtitle

const field = (label, input, hint) => h("div.field", h("label", label), input, hint ? h("div.small.faint", hint) : null);

export default {
  title: "Network",
  subtitle: () => !isTauri ? "Desktop app only" : status?.running ? `Serving as ${status.config?.node}` : status?.config ? "Not connected" : "Not joined",
  mount(root) {
    if (!isTauri) {
      root.append(h("div.page.network", empty({ icon: "link", title: "Desktop app only",
        body: "Joining the PodTorrent network runs the bundled agent, which only the desktop app has." })));
      return {};
    }
    const node = h("input.input.mono", { placeholder: "example-node-01", spellcheck: "false", autocomplete: "off", "aria-label": "Node id" });
    const token = h("input.input.mono", { type: "password", placeholder: "Paste your node token", autocomplete: "off", "aria-label": "Node token" });
    const pin = h("input.input.num", { type: "number", min: "0", step: "0.01", placeholder: "0.05", "aria-label": "Price per million input tokens" });
    const pout = h("input.input.num", { type: "number", min: "0", step: "0.01", placeholder: "0.40", "aria-label": "Price per million output tokens" });
    const state = h("span.badge");
    const routes = h("div");
    const log = h("pre.small.mono.faint.net-log");
    let busy = false, filled = false;

    const join = button("Join Network", { variant: "primary", icon: "link", onclick: async () => {
      if (busy) return; busy = true;
      try {
        await invoke("network_join", { node: node.value, token: token.value, priceIn: Number(pin.value || 0), priceOut: Number(pout.value || 0) });
        token.value = "";
        toast("Joined the PodTorrent network", "serving", "Covered models are offered to network clients through this Mac.");
      } catch (e) { toast("Couldn't join the network", "degraded", String(e)); }
      busy = false; refresh();
    } });
    const leave = button("Leave", { variant: "ghost", onclick: async () => {
      try { await invoke("network_leave", { forget: false }); } catch (e) { toast("Couldn't leave", "degraded", String(e)); }
      refresh();
    } });

    async function refresh() {
      let s;
      try { s = await invoke("network_status"); } catch { return; }
      status = s;
      if (s.config && !filled) {
        filled = true;
        node.value = s.config.node || "";
        pin.value = s.config.price?.per_mtok_in ?? ""; pout.value = s.config.price?.per_mtok_out ?? "";
      }
      token.placeholder = s.token_saved ? "Saved in the keychain (paste to replace)" : "Paste your node token";
      text(state, !s.available ? "Agent missing" : s.running ? "On the network" : s.config ? "Not connected" : "Not joined");
      state.className = `badge ${s.running ? "serving" : ""}`;
      join.hidden = s.running || !s.available; leave.hidden = !s.running && !s.config;
      const ms = s.manifest?.models || [];
      routes.replaceChildren(...(ms.length ? ms.map(m => h("div.list-row",
        h("div.grow", h("div.t.mono", m.id),
          h("div.d", m.pipeline.hops.map(x => `${x.peer} · layers ${x.lo}–${x.hi - 1}`).join("  →  "))))) :
        [h("div.card-b.small.faint", "No model is fully covered by reachable peers yet. Serve the missing layers from Models, then join.")]));
      text(log, s.log || "No agent output yet.");
    }
    refresh();
    const timer = setInterval(refresh, 3000);

    root.append(h("div.page.network",
      h("section.card", h("div.card-h", h("h2", "Join the PodTorrent network"), h("span.spacer"), state),
        h("div.card-b",
          h("p.small.muted", "Offer the models your swarm fully covers to network clients, with this Mac as the head of each route. Needs an approved node id and token."),
          h("div.net-grid",
            field("Node id", node, "Lower case, as approved."),
            field("Node token", token, "Kept in the system keychain."),
            field("Input price", pin, "USD per million tokens."),
            field("Output price", pout, "USD per million tokens.")),
          h("div.net-actions", join, leave))),
      h("section.card", h("div.card-h", h("h2", "Offered models")), routes),
      h("section.card", h("div.card-h", h("h2", "Privacy and payment")),
        h("div.card-b.small.muted", "This Mac sees each prompt, and every machine on the route sees the model's intermediate state for it, which can reveal the prompt. Only this node's operator is paid.")),
      h("section.card", h("div.card-h", h("h2", "Agent log")), h("div.card-b", log))));
    return { unmount() { clearInterval(timer); } };
  },
};
