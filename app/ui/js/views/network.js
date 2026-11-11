// Network: put this machine on the PodTorrent network. The bundled podtorrent-agent offers the models
// the swarm fully covers to network clients, with this machine as the head of each route. Revenue goes
// to this node's operator. Needs a node id and node token from an approved registration.
import { h, text } from "../dom.js";
import { button, toast, empty, segmented } from "../ui.js";
import { icon } from "../icons.js";
import { invoke, isTauri } from "../native.js";
import { podView } from "./pod.js";
import { go } from "../actions.js";
import { state as app } from "../store.js";
import { startHost } from "../engine.js";

let status = null; // last network_status, for the toolbar subtitle and the sidebar
// Set by a join until the agent reports connected or rejected: only then does it toast the outcome.
let joining = null;

async function poll() {
  try { status = await invoke("network_status"); } catch { /* browser preview */ }
  if (joining && status) settleJoin(status);
  return status;
}

function settleJoin(s) {
  const p = problem(s);
  if (s.connected) toast("Joined the PodTorrent network", "serving", "Covered models are offered to network clients through this machine.");
  else if (p?.rejected) toast("The network didn't accept this node", "gap", p.text);
  else if (!s.running) toast("Couldn't join the network", "gap", "The network agent stopped. Details are in the agent log.");
  else if (Date.now() - joining > 60000) toast("Not connected yet", "degraded", p?.text || `Still reaching the ${netName(s)} network.`);
  else return;
  joining = null;
}
if (isTauri) { poll(); setInterval(poll, 3000); }

// The network is only tried once this machine's node is started (Start My Node): the agent
// serves network requests through the node, and the app doesn't run it without one.
const nodeOff = () => app.engine.phase !== "running";

/** "online" (agent connected), "rejected" (the network refuses the token or node), "connecting"
 *  (agent running, link down) or null. For the sidebar. */
export function networkState() {
  return nodeOff() ? null : status?.connected ? "online" : problem(status)?.rejected ? "rejected" : status?.running ? "connecting" : null;
}

const netName = s => s?.config?.network || "production";

/** Why the agent isn't connected, from its last "link down" log line: { text, rejected } where
 *  rejected means the network refuses this token or node (retrying won't help); null when
 *  connected or there is nothing to explain yet. */
function problem(s) {
  if (!s?.running || s.connected || nodeOff()) return null;
  const line = (s.log || "").split("\n").reverse().find(l => l.includes("msg=connected") || l.includes("link down"));
  const say = (text, rejected = false) => ({ text, rejected });
  if (!line || line.includes("msg=connected")) return say(`Reaching the ${netName(s)} network…`);
  const retry = line.match(/ in=(\S+)/)?.[1];
  const next = retry ? ` Trying again in ${retry}.` : "";
  const code = line.match(/got (\d{3})/)?.[1];
  if (code === "401") return say(`The ${netName(s)} network doesn't accept this node token. It may be revoked, or from the other network. Get a new token from the dashboard and replace it here.`, true);
  if (code === "403") return say(`The ${netName(s)} network knows this token but hasn't approved node ${s.config?.node} with it. Check the node id matches the one you registered, or replace the token.`, true);
  if (/no such host|network is unreachable|connection refused|i\/o timeout|deadline exceeded/.test(line))
    return say(`Can't reach the ${netName(s)} network from this machine. Check the internet connection.${next}`);
  if (/engine|models/.test(line)) return say(`The network agent can't use this machine's models yet. Make sure the chat box works, then Leave and join again.${next}`);
  return say(`Connecting to the ${netName(s)} network didn't work.${next} Details are in the agent log below.`);
}

const field = (label, input, hint) => h("div.field", h("label", label), input, hint ? h("div.small.faint", hint) : null);

export default {
  title: "Network",
  subtitle: () => !isTauri ? "Desktop app only" : nodeOff() ? "Node is offline" : status?.connected ? `Serving as ${status.config?.node} on ${netName(status)}`
    : problem(status)?.rejected ? `Rejected by ${netName(status)}` : status?.running ? `Connecting to ${netName(status)}` : status?.config ? "Not connected" : "Not joined",
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
    // In a pod, only a plan's head joins the network: the pod is one node.
    const podNote = h("div.card-b.small");
    // Why it isn't connected; a rejection is an error with the fix (a new token) as its action.
    const whyText = h("span.grow");
    const replaceToken = button("Replace token", { variant: "primary", size: "sm", onclick: () => { editToken = true; show(); token.focus(); } });
    const why = h("div.next.small", { hidden: true }, icon("alert"), whyText, replaceToken);
    const offNote = h("div.next.small", { hidden: true }, icon("alert"),
      h("span.grow", "This machine's node is offline, so it isn't connecting to the network. Start your node first."),
      button("Start My Node", { variant: "primary", size: "sm", icon: "play", onclick: () => startHost() }));
    const log = h("pre.small.mono.faint.net-log");
    let busy = false, filled = false, net = "production", editToken = false;
    const which = segmented([{ value: "production", label: "Production" }, { value: "staging", label: "Staging" }], net, v => { net = v; label(); }, "Network");
    // With a token saved, the field stays hidden behind "Change token" so a join needs no paste.
    const savedNote = h("span.small.faint", "Saved in the PodTorrent data folder.");
    const changeToken = button("Change token", { variant: "ghost", size: "sm", onclick: () => { editToken = true; show(); token.focus(); } });
    const cancelToken = button("Keep saved token", { variant: "ghost", size: "sm", onclick: () => { editToken = false; token.value = ""; show(); } });
    // Saves the new token and reconnects with it (a join replaces the running agent).
    const saveToken = button("Save and reconnect", { variant: "primary", size: "sm", onclick: () => doJoin() });
    const tokenSaved = h("div.net-token-saved", savedNote, changeToken);
    const tokenHint = h("div.small.faint", "Saved in the PodTorrent data folder, readable by you only.");
    const tokenButtons = h("div.net-token-row", cancelToken, saveToken);
    const tokenField = h("div.field", h("label", "Node token"), tokenSaved, token, tokenHint, tokenButtons);
    token.addEventListener("input", show);
    token.addEventListener("keydown", e => { if (e.key === "Enter" && token.value.trim()) doJoin(); });
    function show() {
      const saved = !!status?.token_saved, joined = !!status?.config;
      tokenSaved.hidden = !saved || editToken;
      token.hidden = saved && !editToken;
      cancelToken.hidden = !saved || !editToken;
      tokenHint.hidden = saved && !editToken;
      // Before joining, Join Network saves the token; once joined, this button does.
      saveToken.hidden = !joined || token.hidden;
      saveToken.disabled = busy || !token.value.trim();
      replaceToken.hidden = editToken || !problem(status)?.rejected;
      join.disabled = busy || nodeOff();
      tokenButtons.hidden = cancelToken.hidden && saveToken.hidden;
      text(join.querySelector("span"), saved && token.value.trim() ? "Save Token and Join" : "Join Network");
    }
    const dashboard = button("Open Dashboard", { variant: "ghost", size: "sm", icon: "link",
      onclick: () => invoke("open_dashboard", { network: dashNet() }).catch(e => toast("Couldn't open the dashboard", "degraded", String(e))) });
    // The joined network's dashboard; before joining, the one picked above.
    const dashNet = () => status?.config ? netName(status) : net;
    const label = () => text(dashboard.querySelector("span"), dashNet() === "staging" ? "Staging Dashboard" : "Dashboard");

    // Starts (or restarts) the agent; success is only toasted once it reports connected (see poll).
    async function doJoin() {
      if (busy) return;
      if (nodeOff()) return toast("Start your node first", "degraded", "The network is only tried once this machine's node is started.");
      busy = true; show();
      try {
        await invoke("network_join", { node: node.value, token: token.value, priceIn: Number(pin.value || 0), priceOut: Number(pout.value || 0), network: net });
        if (token.value.trim()) toast("Node token saved", "info", `Connecting to the ${net} network with it…`);
        token.value = ""; editToken = false;
        joining = Date.now();
      } catch (e) { toast("Couldn't join the network", "gap", String(e)); }
      busy = false; refresh();
    }
    const join = button("Join Network", { variant: "primary", icon: "link", onclick: doJoin });
    const leave = button("Leave", { variant: "ghost", onclick: async () => {
      try { await invoke("network_leave", { forget: false }); } catch (e) { toast("Couldn't leave", "degraded", String(e)); }
      refresh();
    } });

    async function refresh() {
      const s = await poll();
      if (!s) return;
      if (s.config && !filled) {
        filled = true;
        node.value = s.config.node || "";
        pin.value = s.config.price?.per_mtok_in ?? ""; pout.value = s.config.price?.per_mtok_out ?? "";
        net = s.config.network || "production"; which.set(net);
      }
      token.placeholder = s.token_saved ? "Paste the new node token" : "Paste your node token";
      show();
      label();
      const off = nodeOff();
      offNote.hidden = !off;
      const starting = app.engine.phase === "starting";
      offNote.querySelector("button").hidden = starting;
      text(offNote.querySelector("span"), starting ? "Your node is starting. The network is tried once it's up."
        : s.config ? "This machine's node is offline, so it isn't connecting to the network. Start your node and it connects again."
        : "This machine's node is offline. Start your node, then join the network.");
      text(state, !s.available ? "Agent missing" : off ? (starting ? "Node starting…" : "Node offline") : s.connected ? `Online · ${netName(s)}` : s.running ? "Connecting…" : s.config ? "Not connected" : "Not joined");
      const p = problem(s);
      why.hidden = !p; text(whyText, p?.text || "");
      why.classList.toggle("err", !!p?.rejected);
      if (!s.connected && p?.rejected) text(state, "Rejected");
      state.className = `badge dot ${off ? "neutral" : s.connected ? "serving" : p?.rejected ? "gap" : s.running ? "degraded pulse" : ""}`;
      const pv = podView(), inPod = !!pv?.pod, isHead = !!pv?.heads?.length;
      const names = Object.fromEntries((pv?.members || []).map(m => [m.peer_id, m.name]));
      const heads = [...new Set((pv?.pod?.plans || []).map(p => names[p.head] || p.head.slice(0, 8)))];
      podNote.hidden = !inPod;
      podNote.replaceChildren(!inPod ? "" : isHead
        ? `This machine is the head of ${pv.heads.map(m => m.split("/").pop()).join(", ")} in the pod ${pv.pod.name}: it serves the pod on the network as one node.`
        : h("span", `This machine is in the pod ${pv.pod.name}. `, heads.length ? `The pod is served on the network through ${heads.join(", ")}.` : "The pod has no model plan yet.", " ",
          h("a", { href: "#", onclick: e => { e.preventDefault(); go("pod"); } }, "Open Pod")));
      join.hidden = s.running || !s.available || (inPod && !isHead); leave.hidden = !s.running && !s.config;
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
      h("section.card", h("div.card-h", h("h2", "Join the PodTorrent network"), h("span.spacer"), dashboard, state),
        h("div.card-b",
          h("p.small.muted", "Offer the models your swarm fully covers to network clients, with this machine as the head of each route. Needs an approved node id and token."),
          podNote,
          offNote,
          why,
          h("div.net-grid",
            field("Network", which, "Where your node was approved. A staging token doesn't work on production."),
            field("Node id", node, "Lower case, as approved."),
            tokenField,
            field("Input price", pin, "USD per million tokens."),
            field("Output price", pout, "USD per million tokens.")),
          h("div.net-actions", join, leave))),
      h("section.card", h("div.card-h", h("h2", "Offered models")), routes),
      h("section.card", h("div.card-h", h("h2", "Privacy and payment")),
        h("div.card-b.small.muted", "This machine sees each prompt, and every machine on the route sees the model's intermediate state for it, which can reveal the prompt. Only this node's operator is paid.")),
      h("section.card", h("div.card-h", h("h2", "Agent log")), h("div.card-b", log))));
    return { unmount() { clearInterval(timer); } };
  },
};
