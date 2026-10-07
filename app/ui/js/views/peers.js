// Peers: sortable, filterable, virtualized table with per-row sparklines and a detail sheet.
import { h, text, fmt, cls } from "../dom.js";
import { state, nodeList, nodeState, nodeStateLabel, subscribe } from "../store.js";
import { empty, button, sparkline, sheet, badge } from "../ui.js";
import { icon } from "../icons.js";
import { actions, copyText, copyNodeId } from "../actions.js";
import { peerCard } from "../viz/graph.js";

const ROW = 48;
const COLS = [
  { k: "name", l: "Peer", w: "minmax(160px,1.4fr)", v: n => n.name },
  { k: "state", l: "State", w: "120px", v: n => nodeStateLabel(n) },
  { k: "layers", l: "Layers", w: "90px", v: n => n.lo ?? 1e9 },
  { k: "rtt", l: "Latency", w: "80px", v: n => n.role === "host" ? -1 : n.rtt_ms ?? 1e9 },
  { k: "mem", l: "Memory", w: "minmax(120px,1fr)", v: n => n.mem?.active_gb ?? -1 },
  { k: "tokens", l: "Tokens", w: "90px", v: n => n.stats?.tokens ?? -1 },
  { k: "act", l: "Activity", w: "110px", v: n => n.tps.slice(-5).reduce((a, b) => a + b, 0) },
  { k: "chip", l: "Device", w: "minmax(110px,1fr)", v: n => n.chip || "" },
];

export default {
  title: "Peers",
  subtitle: s => { const n = Object.keys(s.nodes).length; return n ? `${n} known` : ""; },
  mount(root) {
    let sort = { k: "layers", dir: 1 }, filter = "";
    const q = h("input.input", { placeholder: "Filter by name, state or chip", "aria-label": "Filter peers", style: { maxWidth: "280px" } });
    q.addEventListener("input", () => { filter = q.value.toLowerCase(); paint(state); });
    const thead = h("div.thead", { role: "row" }, COLS.map(c => h("button", { type: "button", role: "columnheader", "data-k": c.k, onclick: () => { sort = { k: c.k, dir: sort.k === c.k ? -sort.dir : 1 }; paint(state); } }, c.l, icon("chevdown"))));
    const rowsBox = h("div", { style: { position: "relative" } });
    const scroller = h("div.table-scroll", rowsBox);
    const table = h("div.table.peers-table", { role: "grid", "aria-label": "Peers", style: { "--cols": COLS.map(c => c.w).join(" ") } }, thead, scroller);
    const note = h("div.small.muted.solo-note");
    const card = h("div.card", { style: { overflowX: "auto", overflowY: "hidden" } }, table);
    const page = h("div.page", h("div.row", q, h("span.spacer"), note), card);
    const emptyBox = h("div.page");
    const swarmBox = h("div.page.swarm-page");
    root.append(swarmBox, page, emptyBox);
    scroller.addEventListener("scroll", () => paint(state));
    const pool = new Map();

    function makeRow() {
      const sp = sparkline("row-spark", 100, 24);
      const el = h("div.tr", { role: "row", tabIndex: 0 },
        h("div.row.cell-name", h("span.statedot"), h("b.ellipsis.nm"), h("span.badge.you", "You"), h("span.faint.small.rl")),
        h("div.small.st"), h("div.num.ly"), h("div.num.rt"),
        h("div.col.mm", { style: { gap: "4px" } }, h("span.small.num.mt"), h("div.progress", h("i"))),
        h("div.num.tk"), h("div.ac", sp), h("div.small.muted.ellipsis.ch"));
      el.addEventListener("click", () => peerSheet(el.dataset.name));
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); peerSheet(el.dataset.name); } });
      return el;
    }
    function fill(el, n, s) {
      const st = nodeState(n, s), me = n.name === s.self;
      el.dataset.name = n.name;
      el.querySelector(".statedot").className = `statedot ${st === "idle" ? "off" : st}`;
      text(el.querySelector(".nm"), n.name);
      el.querySelector(".badge.you").hidden = !me; cls(el, "you", me);
      text(el.querySelector(".rl"), n.role === "host" ? "host" : "");
      text(el.querySelector(".st"), nodeStateLabel(n, s));
      text(el.querySelector(".ly"), n.lo != null ? fmt.layers(n.lo, n.hi) : "–");
      text(el.querySelector(".rt"), n.role === "host" ? "local" : n.rtt_ms != null ? fmt.ms(n.rtt_ms) : "–");
      text(el.querySelector(".mt"), n.mem ? `${fmt.gb(n.mem.active_gb)} / ${fmt.gb(n.mem.total_gb)}` : "–");
      el.querySelector(".progress i").style.width = n.mem ? Math.min(100, (100 * n.mem.active_gb) / n.mem.total_gb) + "%" : 0;
      text(el.querySelector(".tk"), fmt.compact(n.stats?.tokens));
      const sp = el.querySelector(".row-spark"); sp.style.color = `var(--c-${st === "idle" ? "net" : st})`; sp.set(n.tps.slice(-30));
      text(el.querySelector(".ch"), n.chip || "–");
      el.setAttribute("aria-label", `${n.name}, ${nodeStateLabel(n, s)}`);
    }

    function paint(s) {
      const col = COLS.find(c => c.k === sort.k);
      thead.querySelectorAll("button").forEach(b => b.dataset.k === sort.k ? b.setAttribute("aria-sort", sort.dir > 0 ? "descending" : "ascending") : b.removeAttribute("aria-sort"));
      let list = nodeList(s);
      if (filter) list = list.filter(n => [n.name, nodeStateLabel(n, s), n.chip, n.role].join(" ").toLowerCase().includes(filter));
      list.sort((a, b) => { const x = col.v(a), y = col.v(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
      // virtualize: only rows in view (+ overscan) exist in the DOM
      const vh = scroller.clientHeight || 600, top = scroller.scrollTop;
      const from = Math.max(0, Math.floor(top / ROW) - 6), to = Math.min(list.length, Math.ceil((top + vh) / ROW) + 6);
      rowsBox.style.height = list.length * ROW + "px";
      const live = new Set();
      for (let i = from; i < to; i++) {
        const n = list[i]; live.add(n.name);
        let el = pool.get(n.name);
        if (!el) { el = makeRow(); pool.set(n.name, el); rowsBox.append(el); }
        el.style.cssText = `position:absolute;left:0;right:0;top:${i * ROW}px`;
        fill(el, n, s);
      }
      for (const [k, el] of pool) if (!live.has(k)) { el.remove(); pool.delete(k); }
      rowsBox.querySelector(".empty")?.remove();
      if (!list.length && filter) rowsBox.append(h("div.empty", { style: { padding: "28px" } }, h("p", `No peers match "${filter}".`)));
    }

    let emptyKey = "", swarmKey = "";
    return {
      update(s) {
        const sk = JSON.stringify([s.swarm, s.engine.phase]);
        if (sk !== swarmKey) { swarmKey = sk; swarmBox.replaceChildren(swarmCard(s)); }
        const n = Object.keys(s.nodes).length;
        page.hidden = !n; emptyBox.hidden = !!n;
        if (!n) {
          const k = s.engine.phase;
          if (k !== emptyKey) {
            emptyKey = k;
            emptyBox.replaceChildren(empty({ icon: "peers", title: s.engine.phase === "starting" ? "Starting your node…" : "No peers yet", body: "Peers appear here as Macs join. Start as host, then have the other Mac join with your address.", actions: [button("Start as Host", { variant: "primary", onclick: actions.startHost }), button("Join a Host…", { onclick: actions.join })] }));
          }
          return;
        }
        emptyKey = "";
        if (n === 1 && s.role === "host") {
          const a = s.hostInfo?.addresses?.[0];
          note.replaceChildren("Only this Mac so far. ", a ? h("a", { href: "#", onclick: e => { e.preventDefault(); copyNodeId(); } }, `Copy ${a}:${s.hostInfo.port}`) : "", a ? " and enter it on the other Mac." : "");
        } else if (s.role === "worker" && s.conn !== "live") note.textContent = "A worker only sees itself; the host has the full list.";
        else note.textContent = "";
        paint(s);
      },
    };
  },
};

const SWARM_STATUS = { online: ["Connected", "serving"], connecting: ["Connecting…", "degraded"], offline: ["Offline", "gap"] };

/** Every PodTorrent Mac online anywhere, from the global rendezvous registry. */
function swarmCard(s) {
  const sw = s.swarm, [label, kind] = SWARM_STATUS[sw.status] || SWARM_STATUS.offline;
  const others = sw.peers.filter(p => p.peer_id !== sw.selfId).length;
  const head = h("div.card-h", h("b", "Online in the swarm"), badge(label, kind, { dot: true, pulse: sw.status === "connecting" }),
    h("span.spacer"), h("span.small.muted", sw.status === "online" ? `${sw.peers.length} Mac${sw.peers.length === 1 ? "" : "s"} · ${others} besides you` : ""));
  if (s.engine.phase !== "running" && !sw.peers.length)
    return h("div.card", head, h("div.card-b.small.muted", "Start your node to appear in the global swarm and see every other Mac running PodTorrent."));
  if (sw.status !== "online")
    return h("div.card", head, h("div.card-b.small.muted", "Can't reach the discovery service. Retrying…"));
  return h("div.card", head, h("div.swarm-list", sw.peers.map(p => {
    const me = p.peer_id === sw.selfId;
    const slices = (p.slices || []).map(x => `${x.model.split("/").pop()} ${fmt.layers(x.lo, x.hi)}`).join(" · ") || "Serves nothing yet";
    const pub = (p.endpoints || []).find(e => e.kind === "stun");
    return h("div.swarm-row", h("span.statedot.serving"),
      h("div.col", h("div.row", h("b.ellipsis", p.name || p.peer_id.slice(0, 8)), me ? badge("You", "you") : null),
        h("span.small.muted.ellipsis", [p.chip, p.mem_total_gb ? fmt.gb(p.mem_total_gb) : ""].filter(Boolean).join(" · "))),
      h("span.small.ellipsis", slices),
      h("span.small.faint.num", { "data-tip": "Public address (from STUN)" }, pub ? `${pub.ip}:${pub.port}` : "behind NAT"));
  })));
}

/** Detail sheet for one peer (updates live while open). */
export function peerSheet(name) {
  const n = state.nodes[name];
  if (!n) return;
  const top = h("div");
  const rtt = sparkline("sheet-spark", 480, 60), tps = sparkline("sheet-spark", 480, 60);
  rtt.style.color = "var(--c-net)"; tps.style.color = "var(--c-active)";
  const rttL = h("span.small.faint"), tpsL = h("span.small.faint");
  let unsub = null;
  const s = sheet({
    title: name, onclose: () => unsub?.(),
    body: h("div.col", { style: { gap: "14px" } }, top,
      h("div.col", h("div.row", h("span.caps", "Throughput"), h("span.spacer"), tpsL), tps),
      n.role !== "host" ? h("div.col", h("div.row", h("span.caps", "Latency to host"), h("span.spacer"), rttL), rtt) : null),
    footer: [n.address ? button("Copy address", { icon: "copy", onclick: () => copyText(n.address, "Address copied") }) : null, n.status_url ? button("Worker status page", { icon: "link", onclick: () => window.open(n.status_url) }) : null, button("Done", { variant: "primary", onclick: () => s.close() })].filter(Boolean),
  });
  const paint = st => {
    const cur = st.nodes[name];
    if (!cur) return;
    top.replaceChildren(peerCard(cur));
    tps.set(cur.tps.slice(-60)); text(tpsL, `${fmt.fixed(cur.tps.slice(-5).reduce((a, b) => a + b, 0) / Math.max(1, cur.tps.slice(-5).length))} tok/s now`);
    rtt.set(cur.lastRtt); text(rttL, cur.rtt_ms != null ? `${fmt.ms(cur.rtt_ms)} last heartbeat` : "no heartbeat");
  };
  paint(state);
  unsub = subscribe(paint);
  return s;
}
