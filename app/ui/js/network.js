// Joining the PodTorrent network: the bundled podtorrent-agent offers the models the swarm fully
// covers to the network's clients, with this Mac as the head of each route. Revenue goes to this
// node's operator. Needs a node id and node token from an approved registration.
import { h, text } from "./dom.js";
import { button, toast } from "./ui.js";
import { invoke, isTauri } from "./native.js";

const input = (placeholder, type = "text") =>
  h("input", { type, placeholder, spellcheck: false, autocomplete: "off", style: { flex: "1", minWidth: "140px" } });

/** Node id, token, prices and Join/Leave, with the agent's state. Null outside the app. */
export function networkPanel() {
  if (!isTauri) return null;
  const node = input("example-node-01");
  const token = input("node token (kept in the system keychain)", "password");
  const pin = input("0.05", "number"), pout = input("0.40", "number");
  const status = h("div.small.faint", "…");
  const models = h("div.small");
  const log = h("pre.small.faint", { style: { maxHeight: "120px", overflow: "auto", whiteSpace: "pre-wrap", margin: 0 } });
  let busy = false;

  async function refresh() {
    let s;
    try { s = await invoke("network_status"); } catch { return; }
    if (!s.available) { text(status, "This build doesn't include the network agent."); join.hidden = true; return; }
    if (s.config && !node.value) {
      node.value = s.config.node || "";
      pin.value = s.config.price?.per_mtok_in ?? ""; pout.value = s.config.price?.per_mtok_out ?? "";
    }
    token.placeholder = s.token_saved ? "saved in the keychain (paste to replace)" : "node token (kept in the system keychain)";
    text(status, s.running ? `On the network as ${s.config?.node}` : s.config ? "Not connected" : "Not joined");
    status.style.color = s.running ? "var(--c-serving)" : "";
    const ms = s.manifest?.models || [];
    text(models, ms.length ? "Offered: " + ms.map(m => `${m.id} (${m.pipeline.hops.map(x => `${x.peer} ${x.lo}–${x.hi - 1}`).join(" → ")})`).join("; ")
      : "No model is fully covered by reachable peers yet.");
    text(log, s.log || "");
    join.hidden = s.running; leave.hidden = !s.running && !s.config;
  }
  const join = button("Join Network", { onclick: async () => {
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
  refresh();
  const timer = setInterval(() => { if (!document.body.contains(status)) clearInterval(timer); else refresh(); }, 3000);
  const line = (...xs) => h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, ...xs);
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
    line(node, token),
    line(h("span.small.faint", "USD per million tokens, in / out"), pin, pout, h("span.spacer"), join, leave),
    status, models,
    h("div.small.faint", "Every Mac on a route sees the model's intermediate state for each request, and this Mac sees the prompt. Only this node is paid."),
    log);
}
