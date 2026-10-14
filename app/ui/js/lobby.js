// Lobby: before this machine's node runs, watch the global rendezvous registry read-only so the
// Swarm view can show who is already online. We never send "hello", so we don't appear as a peer.
// Starting the node calls resetState(), which drops these preview nodes; the engine takes over.
import { state, subscribe, commit } from "./store.js";

const URL_ = "wss://rendezvous.podtorrent.com/v1/swarm";
const PING_MS = 10_000;

let ws = null, pinger = 0, retry = 0, backoff = 1000;

const wanted = s => s.source === "live" && s.booted && s.engine.phase === "stopped";

function open() {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const sock = ws = new WebSocket(`${URL_}?peer_id=${id}`);
  if (!state.swarm.peers.length) { state.swarm = { status: "connecting", selfId: "", peers: [] }; commit(); }
  sock.onopen = () => { backoff = 1000; pinger = setInterval(() => sock.readyState === 1 && sock.send("ping"), PING_MS); };
  sock.onmessage = e => {
    if (ws !== sock || !wanted(state)) return;
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "peers") apply(msg.peers || []);
  };
  sock.onclose = () => {
    clearInterval(pinger);
    if (ws !== sock) return;
    ws = null;
    if (!wanted(state)) return;
    state.swarm = { ...state.swarm, status: "offline" }; commit();
    retry = setTimeout(() => { retry = 0; if (wanted(state) && !ws) open(); }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}

function close() {
  clearTimeout(retry);
  const sock = ws; ws = null;
  if (sock) try { sock.close(1000); } catch { /* closing */ }
}

/** Registry records become preview nodes, shaped like the engine's so the graph and grid render them. */
function apply(peers) {
  for (const k of Object.keys(state.nodes)) if (state.nodes[k].preview) delete state.nodes[k];
  for (const p of peers) {
    const name = p.name || p.peer_id.slice(0, 8);
    const slices = p.slices || [];
    const first = slices.find(x => x.loaded) || slices[0];
    state.nodes[name] = {
      name, preview: true, role: "worker", address: "", status: slices.some(x => x.loaded) ? "ready" : "joined",
      rtt_ms: null, heartbeat_ts: null, stats: null, load: null, roles: [], chip: p.chip || "",
      mem: p.mem_total_gb ? { active_gb: 0, total_gb: p.mem_total_gb } : null,
      lo: first ? first.lo : null, hi: first ? first.hi : null, slices,
      firstSeen: (p.seen_ms || Date.now()) / 1000, tps: [], lastTokens: null, lastCompute: null, lastRtt: [],
    };
  }
  state.swarm = { status: "online", selfId: "", peers: peers.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")) };
  commit();
}

export function initLobby() {
  subscribe(s => {
    if (wanted(s)) { if (!ws && !retry) open(); }
    else if (ws || retry) {
      close(); retry = 0;
      let dropped = false;
      for (const k of Object.keys(state.nodes)) if (state.nodes[k].preview) { delete state.nodes[k]; dropped = true; }
      if (dropped) commit();
    }
  });
}
