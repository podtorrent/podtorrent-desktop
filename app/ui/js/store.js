// App state, the engine-event reducer (shared by live and Demo Mode), and derived selectors.
// Mutations mark the store dirty; subscribers run once per animation frame.
import { median, fmt, ranges } from "./dom.js";

const SETTINGS_KEY = "pt.settings";
const HISTORY_KEY = "pt.history";
const DEFAULT_SETTINGS = {
  theme: "system", reduceEffects: false, demo: false, demoPreset: "pair", demoAutoplay: true,
  sidebarCollapsed: false, swarmLayout: "graph", inspector: true, maxTokens: 256, onboarded: false,
  hostAddr: "", notifications: true,
  valuationBasis: null, macPrice: null, amortMonths: null,
};

function load(key, dflt) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === "object" ? { ...dflt, ...v } : { ...dflt }; }
  catch { return { ...dflt }; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

export const settings = load(SETTINGS_KEY, DEFAULT_SETTINGS);
export function setSetting(k, v) { settings[k] = v; save(SETTINGS_KEY, settings); commit(); emit("setting", { k, v }); }

function blank() {
  return {
    source: settings.demo ? "demo" : "live",
    role: null,              // what this Mac runs: null | "host" | "worker"
    engine: { phase: "stopped", owned: false, line: "", error: "" }, // stopped|starting|running|unreachable
    conn: "idle",            // host event stream: idle|connecting|live|down
    self: null,              // node name of this Mac
    hostAddr: settings.hostAddr,
    hostInfo: null,
    nodes: {},
    layerMap: null,
    ready: false,
    loadRequested: false,
    lastError: "",
    extraModels: [],         // Demo Mode only: additional models
    chat: { messages: [], busy: false, session: null }, // session: who the host is generating for {by, started}
    tps: [],                 // swarm tokens/s, 1 s samples, last 180
    tokenTimes: [],
    ttfts: [],
    feed: [],
    download: null,
    health: null,
    swarm: { status: "offline", selfId: "", peers: [] }, // global registry: every PodTorrent Mac online
    booted: false,
  };
}

export let state = blank();
export function resetState(keep = {}) {
  const health = state.health, download = state.download;
  state = Object.assign(blank(), { health, download, booted: true }, keep);
  commit();
}

// ---------- pub/sub ----------
const subs = new Set();
let dirty = false;
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function commit() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(flush);
}
function flush() {
  dirty = false;
  for (const fn of subs) { try { fn(state); } catch (e) { console.error(e); } }
}
const bus = new Map();
export function on(type, fn) { if (!bus.has(type)) bus.set(type, new Set()); bus.get(type).add(fn); return () => bus.get(type).delete(fn); }
export function emit(type, data) { for (const fn of bus.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } }

// ---------- activity feed ----------
export function feed(kind, title, detail = "", level = "info", ts = Date.now() / 1000) {
  state.feed.push({ id: state.feed.length + ":" + ts, ts, kind, title, detail, level });
  if (state.feed.length > 2000) state.feed.splice(0, state.feed.length - 2000);
  emit("feed", state.feed[state.feed.length - 1]);
}

// ---------- reducer ----------
function node(name) {
  return state.nodes[name] ||= {
    name, role: "worker", address: "", status: "joined", rtt_ms: null, heartbeat_ts: null, mem: null,
    stats: null, load: null, lo: null, hi: null, roles: [], chip: "", firstSeen: Date.now() / 1000,
    tps: [], lastTokens: null, lastCompute: null, lastRtt: [],
  };
}

/** Apply one engine event (host WebSocket shape). Demo Mode feeds the same shapes. */
export function applyEvent(ev) {
  const ts = ev.ts || Date.now() / 1000;
  switch (ev.type) {
    case "node_joined": {
      const fresh = !state.nodes[ev.node];
      const n = node(ev.node);
      Object.assign(n, { role: ev.role || "worker", address: ev.address || "", status_url: ev.status_url, chip: ev.chip || n.chip, mem_total_gb: ev.mem_total_gb });
      if (n.role === "host") { n.status = "host"; n.chip ||= state.hostInfo?.chip || ""; }
      else if (n.status === "lost") n.status = "joined";
      if (fresh && n.role !== "host") { feed("join", `${ev.node} joined the swarm`, ev.address, "success", ts); emit("signal", { kind: "joined", node: ev.node }); }
      break;
    }
    case "host_info":
      state.hostInfo = ev;
      if (state.nodes[ev.name || "host"]) state.nodes[ev.name || "host"].chip = ev.chip || "";
      break;
    case "node_status": {
      const n = node(ev.node), was = n.status;
      n.status = ev.status; n.heartbeat_ts = ev.heartbeat_ts;
      if (ev.rtt_ms != null) { n.rtt_ms = ev.rtt_ms; n.lastRtt.push(ev.rtt_ms); if (n.lastRtt.length > 60) n.lastRtt.shift(); }
      if (ev.status === "lost" && was !== "lost") { feed("lost", `${ev.node} went offline`, "Heartbeat failed. Its layers have no peer until it returns.", "error", ts); emit("signal", { kind: "lost", node: ev.node }); }
      if (was === "lost" && ev.status !== "lost") feed("back", `${ev.node} is reachable again`, "", "success", ts);
      break;
    }
    case "swarm": applySwarm(ev); break;
    case "memory": node(ev.node).mem = { active_gb: ev.active_gb, peak_gb: ev.peak_gb, total_gb: ev.total_gb }; break;
    case "node_stats": node(ev.node).stats = ev; break;
    case "load_progress": {
      const n = node(ev.node), was = n.load?.phase;
      n.load = { phase: ev.phase, done: ev.done, total: ev.total };
      if (ev.phase !== was) {
        if (ev.phase === "downloading" && !was) feed("load", `${ev.node} is downloading its layers`, "", "info", ts);
        if (ev.phase === "loading") feed("load", `${ev.node} is loading layers into memory`, "", "info", ts);
        if (ev.phase === "ready") feed("load", `${ev.node} loaded its layers`, n.lo != null ? `Layers ${fmt.layers(n.lo, n.hi)}` : "", "success", ts);
        if (ev.phase === "error") feed("load", `${ev.node} failed to load`, ev.message || "", "error", ts);
      }
      break;
    }
    case "layer_map":
      state.layerMap = ev;
      for (const a of ev.assignments) Object.assign(node(a.node), { lo: a.lo, hi: a.hi, roles: a.roles || [] });
      feed("rebalance", "Layers assigned", ev.assignments.map(a => `${a.node} ${fmt.layers(a.lo, a.hi)}`).join(" · "), "info", ts);
      break;
    case "ready":
      if (!state.ready) { feed("covered", "Model fully covered", "Every layer has a peer. The Playground is unlocked.", "success", ts); emit("signal", { kind: "ready" }); }
      state.ready = true; state.loadRequested = false; state.lastError = "";
      break;
    case "chat_session":
      state.chat.session = ev.busy ? { started: ev.started } : null;
      break;
    case "token": {
      state.tokenTimes.push(performance.now());
      const m = streamingMsg(ev);
      if (m) { m.status = "streaming"; m.text += ev.text; m.tokens++; if (!m.firstAt) m.firstAt = performance.now(); }
      emit("token", ev);
      break;
    }
    case "token_timing": {
      const m = streamingMsg(ev);
      if (m) m.timings.push(ev);
      for (const s of ev.stages) if (state.nodes[s.node]) state.nodes[s.node].lastCompute = s.compute_ms;
      emit("timing", ev);
      break;
    }
    case "done": {
      const m = streamingMsg(ev);
      if (m) { m.status = "done"; m.done = ev; }
      if (mine(ev)) state.chat.busy = false;
      if (ev.ttft_ms != null) { state.ttfts.push(ev.ttft_ms); if (state.ttfts.length > 200) state.ttfts.shift(); }
      if (!ev.ambient) feed("generate", `Generated ${ev.tokens} tokens`, `${fmt.fixed(ev.tok_s)} tok/s · first token ${fmt.ms(ev.ttft_ms)}`, "info", ts);
      emit("signal", { kind: "generated", tokens: ev.tokens });
      break;
    }
    case "error": {
      state.lastError = ev.message;
      const m = streamingMsg(ev);
      if (m) { m.status = "error"; m.error = ev.message; state.chat.busy = false; }
      if (state.loadRequested) state.loadRequested = false;
      feed("error", "Engine error", ev.message, "error", ts);
      break;
    }
  }
  commit();
}

/** Global discovery: the rendezvous registry's peer list, as reported by this Mac's engine. */
function applySwarm(ev) {
  const was = new Set(state.swarm.peers.map(p => p.peer_id));
  const peers = (ev.peers || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (state.swarm.status === "online" && ev.status === "online") {
    for (const p of peers) if (!was.has(p.peer_id) && p.peer_id !== ev.self_id) feed("join", `${p.name || "A Mac"} came online`, p.chip || "", "info");
  }
  state.swarm = { status: ev.status, selfId: ev.self_id || "", peers };
}

/** Worker mode: this Mac's /status (polled). */
export function applyWorkerStatus(s) {
  state.self = s.name;
  const n = node(s.name);
  const was = n.load?.phase;
  Object.assign(n, {
    role: "worker", chip: s.chip || n.chip, lo: s.loaded ? s.layer_lo : n.lo, hi: s.loaded ? s.layer_hi : n.hi,
    mem: { active_gb: s.mem_active_gb, peak_gb: s.mem_peak_gb, total_gb: s.mem_total_gb },
    stats: { busy: s.busy, active_requests: s.active_requests, tokens: s.tokens, requests: s.served },
    load: { phase: s.phase === "idle" ? null : s.phase, done: s.done, total: s.total },
    uptime_s: s.uptime_s, lastCompute: s.served ? s.last_compute_ms : null, last_forward_ts: s.last_forward_ts,
  });
  if (!n.load.phase) n.load = null;
  if (s.swarm) applySwarm(s.swarm);
  if (state.conn !== "live") n.status = s.loaded ? "ready" : s.phase === "downloading" || s.phase === "loading" ? "loading" : "joined";
  if (s.phase !== (was || "idle") && s.phase === "ready") feed("load", "This Mac loaded its layers", `Layers ${fmt.layers(s.layer_lo, s.layer_hi)}`, "success");
  if (s.phase !== (was || "idle") && s.phase === "error") feed("load", "Loading failed on this Mac", s.message, "error");
  commit();
}

/** Random per-launch key: the host streams a reply's text only to the socket holding the key
 * that sent the prompt, so one Mac never receives another Mac's chat. */
export const chatKey = crypto.randomUUID();
/** The host marks the requester's copy of generation events; others get them without text. */
const mine = ev => !!ev.mine || state.source === "demo";

function streamingMsg(ev = {}) {
  if (!mine(ev)) return null;
  const m = state.chat.messages[state.chat.messages.length - 1];
  return m && m.role === "assistant" && (m.status === "pending" || m.status === "streaming") ? m : null;
}

/** 1 Hz sampler: swarm throughput and per-node token rates (from real counters). */
export function sample() {
  const now = performance.now();
  state.tokenTimes = state.tokenTimes.filter(t => now - t < 3000);
  const tps = state.tokenTimes.filter(t => now - t < 1000).length;
  // worker mode without the host stream: derive from this node's own token counter
  let v = tps;
  for (const n of Object.values(state.nodes)) {
    const tok = n.role === "host" ? n.stats?.generated_tokens : n.stats?.tokens;
    if (tok != null) {
      const d = n.lastTokens == null ? 0 : Math.max(0, tok - n.lastTokens);
      n.lastTokens = tok;
      n.tps.push(d); if (n.tps.length > 60) n.tps.shift();
      if (state.conn !== "live" && n.name === state.self) v = d;
    }
  }
  state.tps.push(v); if (state.tps.length > 180) state.tps.shift();
  recordHistory();
  commit();
}

// ---------- contribution history (this Mac, persisted per day) ----------
let lastSelfTokens = null, lastSelfReq = null;
export const history = load(HISTORY_KEY, { days: {}, stats: {} });
history.stats ||= {};
const today = () => new Date().toISOString().slice(0, 10);
/** Per-day counters beyond tokens: requests, online/active seconds, block-seconds hosted. */
export const dayStats = k => history.stats[k] ||= { req: 0, online_s: 0, active_s: 0, block_s: 0 };
function recordHistory() {
  if (state.source !== "live") return;
  const me = state.nodes[state.self];
  const day = today();
  let dirtyH = false;
  if (me && state.engine.phase === "running") {
    const d = dayStats(day);
    d.online_s++;
    if (nodeState(me) === "active" || (me.tps.at(-1) || 0) > 0) d.active_s++;
    if (me.lo != null && nodeLoaded(me)) d.block_s += me.hi - me.lo;
    history.first ||= Date.now() / 1000;
    dirtyH = true;
  }
  const req = me?.stats?.requests;
  if (req == null) lastSelfReq = null;
  else { if (lastSelfReq != null && req > lastSelfReq) dayStats(day).req += req - lastSelfReq; lastSelfReq = req; }
  const tok = me?.stats?.tokens;
  if (tok == null) lastSelfTokens = null;
  else {
    if (lastSelfTokens != null && tok > lastSelfTokens) {
      history.days[day] = (history.days[day] || 0) + (tok - lastSelfTokens);
      const all = Object.values(history.days).reduce((a, b) => a + b, 0), prev = all - (tok - lastSelfTokens);
      for (const m of [1e3, 1e4, 1e5, 1e6]) if (prev < m && all >= m) emit("signal", { kind: "milestone", tokens: m });
    }
    lastSelfTokens = tok;
  }
  // online seconds tick every sample; persist at most every 10 s
  if (dirtyH && Date.now() - (recordHistory.saved || 0) > 10000) { save(HISTORY_KEY, history); recordHistory.saved = Date.now(); }
}

// ---------- selectors ----------
export const nodeList = s => Object.values(s.nodes).sort((a, b) => (a.role === "host" ? -1 : b.role === "host" ? 1 : (a.lo ?? 99) - (b.lo ?? 99) || a.name.localeCompare(b.name)));

/** Semantic state of a node: serving | active | degraded | gap | idle */
export function nodeState(n, s = state) {
  if (!n) return "gap";
  if (n.status === "lost") return "gap";
  if (n.load?.phase === "error") return "gap";
  if (n.stats?.busy || (n.last_forward_ts && Date.now() / 1000 - n.last_forward_ts < 1.5)) return "active";
  if (n.load && (n.load.phase === "downloading" || n.load.phase === "loading")) return "degraded";
  if (n.rtt_ms != null && n.rtt_ms > 250) return "degraded";
  if (nodeLoaded(n, s)) return "serving";
  return "idle";
}
export function nodeLoaded(n, s = state) {
  if (n.load?.phase === "ready") return true;
  if (n.role === "host") return s.ready;
  return n.status === "ready";
}
export const stateLabel = { serving: "Serving", active: "Computing", degraded: "Degraded", gap: "Offline", idle: "Idle" };
export function nodeStateLabel(n, s = state) {
  const st = nodeState(n, s);
  if (st === "degraded" && n.load?.phase === "downloading") return "Downloading";
  if (st === "degraded" && n.load?.phase === "loading") return "Loading";
  if (st === "degraded") return "Slow link";
  if (st === "gap" && n.load?.phase === "error") return "Load failed";
  if (st === "idle") return n.lo != null ? "Not loaded" : "Joined";
  return stateLabel[st];
}

/** Model coverage: per-layer peers and a plain-English verdict. */
export function models(s = state) {
  const out = [];
  if (s.hostInfo || s.source === "demo" || s.role === "host") {
    const n = s.hostInfo?.n_layers || 48;
    const repo = s.hostInfo?.repo || "mlx-community/Qwen3-30B-A3B-4bit";
    let assignments = s.layerMap?.assignments, planned = false;
    if (!assignments) {
      planned = true;
      const host = Object.values(s.nodes).find(x => x.role === "host");
      const w = Object.values(s.nodes).find(x => x.role === "worker" && x.status !== "lost");
      const k = Math.floor(n / 2);
      assignments = [{ node: host?.name || "host", lo: 0, hi: k, roles: ["tokenizer", "embeddings", "lm_head"] }];
      if (w) assignments.push({ node: w.name, lo: k, hi: n, roles: [] });
    }
    out.push(coverage({ id: repo, repo, n_layers: n, assignments, planned, primary: true }, s));
  } else if (s.role === "worker") {
    const me = s.nodes[s.self];
    if (me && me.lo != null) out.push(coverage({ id: "worker", repo: "mlx-community/Qwen3-30B-A3B-4bit", n_layers: 48, assignments: [{ node: me.name, lo: me.lo, hi: me.hi, roles: [] }], partialView: true, primary: true }, s));
  }
  for (const m of s.extraModels) out.push(coverage(m, s));
  return out;
}

function coverage(m, s) {
  const layers = Array.from({ length: m.n_layers }, (_, i) => ({ i, peers: [], state: "gap", serving: 0 }));
  for (const a of m.assignments) {
    const n = s.nodes[a.node];
    for (let i = a.lo; i < a.hi && i < m.n_layers; i++) {
      let st;
      if (m.demoState) st = m.demoState(a, n);
      else if (!n || n.status === "lost" || n.load?.phase === "error") st = "gap";
      else if (n.load && (n.load.phase === "downloading" || n.load.phase === "loading")) st = "loading";
      else if (!m.planned && nodeLoaded(n, s)) st = "serving";
      else st = "planned";
      layers[i].peers.push({ node: a.node, state: st, roles: a.roles || [] });
    }
  }
  const rank = { serving: 4, loading: 3, planned: 2, gap: 1 };
  for (const L of layers) {
    L.serving = L.peers.filter(p => p.state === "serving").length;
    L.state = L.peers.reduce((b, p) => rank[p.state] > rank[b] ? p.state : b, "gap");
  }
  const missing = layers.filter(L => L.state === "gap").map(L => L.i);
  const loading = layers.filter(L => L.state === "loading").length;
  const serving = layers.filter(L => L.state === "serving").length;
  const name = m.name || m.repo.split("/").pop();
  let verdict;
  if (m.partialView) verdict = { level: "info", title: "Partial view", reason: "This Mac is a worker. The host sees the whole model; this Mac only knows its own layers." };
  else if (serving === m.n_layers) verdict = { level: "serving", title: "Ready to run", reason: `All ${m.n_layers} layers are loaded on ${new Set(m.assignments.map(a => a.node)).size} peers.` };
  else if (missing.length) verdict = { level: "gap", title: "Can't run", reason: `Layers ${ranges(missing)} have no peer${m.planned && !s.layerMap ? ": a worker needs to join" : ""}.` };
  else if (loading) verdict = { level: "degraded", title: "Loading", reason: `${serving + loading} of ${m.n_layers} layers assigned; ${loading} still downloading or loading.` };
  else verdict = { level: "planned", title: "Not loaded", reason: "Every layer has a peer. Load the model to download and load each slice." };
  const redundancy = Math.max(1, ...layers.map(L => L.peers.length));
  return { ...m, name, layers, missing, serving, loading, verdict, redundancy, runnable: serving === m.n_layers };
}

export function swarmStats(s = state) {
  const nodes = Object.values(s.nodes);
  const online = nodes.filter(n => n.status !== "lost");
  const pooled = online.reduce((a, n) => a + (n.mem?.total_gb ?? n.mem_total_gb ?? 0), 0);
  const ms = models(s);
  const recent = s.tps.slice(-5);
  return {
    online: online.length, total: nodes.length, pooled,
    tps: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
    ttft: median(s.ttfts), covered: ms.filter(m => m.runnable).length, models: ms.length,
  };
}

export const selfNode = (s = state) => s.nodes[s.self];
export const isBusyLocally = (s = state) => !!selfNode(s)?.stats?.busy || s.chat.busy;
addEventListener("pagehide", () => save(HISTORY_KEY, history));
