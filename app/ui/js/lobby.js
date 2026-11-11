// Lobby: before this machine's node runs, watch the rendezvous census read-only so the Swarm view
// can show who is already online: every pod as a head with satellites, plus idle machines waiting for
// the matchmaker. The census carries chips, memory and layers, never machine names.
// Starting the node calls resetState(), which drops these preview nodes; the engine takes over.
import { state, subscribe, commit } from "./store.js";

const URL_ = "wss://rendezvous.podtorrent.com/v1/census";
const PING_MS = 10_000;

let ws = null, pinger = 0, retry = 0, backoff = 1000;

const wanted = s => s.booted && s.engine.phase === "stopped";

function open() {
  const sock = ws = new WebSocket(URL_);
  if (!state.swarm.peers.length) { state.swarm = { status: "connecting", selfId: "", peers: [] }; commit(); }
  sock.onopen = () => { backoff = 1000; pinger = setInterval(() => sock.readyState === 1 && sock.send("ping"), PING_MS); };
  sock.onmessage = e => {
    if (ws !== sock || !wanted(state)) return;
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "census") apply(msg);
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

/** Census machines become preview nodes, shaped like the engine's so the graph and grid render them.
 *  Names are made up from the chip (the census has none); `pod` and `podHead` let the graph cluster them. */
function apply(census) {
  for (const k of Object.keys(state.nodes)) if (state.nodes[k].preview) delete state.nodes[k];
  const used = new Map();
  const label = chip => { const n = (used.get(chip) || 0) + 1; used.set(chip, n); return `${chip || "Machine"} ${n}`; };
  const add = (m, extra) => {
    const name = label(m.chip);
    const layers = m.layers || [];
    const slices = layers.map(([lo, hi]) => ({ model: extra.model, lo, hi, loaded: true }));
    state.nodes[name] = {
      name, preview: true, role: "worker", address: "", status: m.online === false ? "lost" : layers.length ? "ready" : "joined",
      rtt_ms: null, heartbeat_ts: null, stats: null, load: null, roles: [], chip: m.chip || "",
      mem: m.mem_gb ? { active_gb: 0, total_gb: m.mem_gb } : null,
      lo: layers[0]?.[0] ?? null, hi: layers[0]?.[1] ?? null, slices, busy: !!m.busy,
      firstSeen: Date.now() / 1000, tps: m.tok_s ? [m.tok_s] : [], lastTokens: null, lastCompute: null, lastRtt: [],
      ...extra,
    };
  };
  const pods = census.pods || [];
  for (const p of pods) {
    const base = { pod: p.pod_id, podKind: p.kind, model: p.models[0], onNetwork: p.on_network };
    if (p.head) add(p.head, { ...base, podHead: true });
    for (const s of p.satellites || []) add(s, base);
  }
  for (const m of census.idle || []) add(m, { model: m.models?.[0] });
  state.swarm = { status: "online", selfId: "", peers: [], census: { pods, idle: census.idle || [], waiting: census.waiting || 0 } };
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
