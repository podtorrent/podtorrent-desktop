// App state, the engine-event reducer (shared by live and Demo Mode), and derived selectors.
// Mutations mark the store dirty; subscribers run once per animation frame.
import { median, fmt } from "./dom.js";

const SETTINGS_KEY = "pt.settings";
const HISTORY_KEY = "pt.history";
const DEFAULT_SETTINGS = {
  theme: "system", reduceEffects: false, demo: false, demoPreset: "swarm", demoAutoplay: true,
  sidebarCollapsed: false, swarmLayout: "graph", inspector: true, maxTokens: 256, onboarded: false,
  peerName: "", pendingServe: null, notifications: true,
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
    role: null,              // "host" while this Mac's peer runs (every Mac is a peer; the name is historical)
    engine: { phase: "stopped", owned: false, line: "", error: "" }, // stopped|starting|running|unreachable
    conn: "idle",            // the peer's event stream: idle|connecting|live|down
    self: null,              // node name of this Mac
    hostInfo: null,          // this peer: name, peer_id, default model
    slices: [],              // what this Mac serves: [{model, lo, hi, loaded, n_layers, phase, done?, total?}]
    memFree: null,           // GB left for more slices
    engineModels: null,      // the engine's coverage summary per model (route, gaps, state)
    nodes: {},
    layerMap: null,
    ready: false,
    loadRequested: false,
    lastError: "",
    chat: { messages: [], busy: false, session: null }, // session: who the host is generating for {by, started}
    tps: [],                 // swarm tokens/s, 1 s samples, last 180
    tokenTimes: [],
    ttfts: [],
    feed: [],
    health: null,
    swarm: { status: "offline", selfId: "", peers: [] }, // global registry: every PodTorrent Mac online
    video: { status: null, setup: null, jobs: {}, encoder: null, swarm: null }, // MiniMax-H3 on this machine: capability, setup, jobs by id
    booted: false,
  };
}

export let state = blank();
export function resetState(keep = {}) {
  const health = state.health;
  state = Object.assign(blank(), { health, booted: true }, keep);
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
      if (ev.name) state.self = ev.name;
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
    case "node_left":
      if (state.nodes[ev.node]) { delete state.nodes[ev.node]; feed("lost", `${ev.node} left the swarm`, "", "info", ts); }
      break;
    case "swarm": applySwarm(ev); break;
    case "memory": node(ev.node).mem = { active_gb: ev.active_gb, peak_gb: ev.peak_gb, total_gb: ev.total_gb }; break;
    case "node_stats": node(ev.node).stats = ev; break;
    case "load_progress": {
      const n = node(ev.node), was = n.load?.phase;
      n.load = { phase: ev.phase, done: ev.done, total: ev.total };
      const what = ev.model ? `${shortModel(ev.model)} ${fmt.layers(ev.lo, ev.hi)}` : n.lo != null ? `Layers ${fmt.layers(n.lo, n.hi)}` : "";
      if (ev.model && ev.node === state.self) {
        let sl = state.slices.find(x => x.model === ev.model && x.lo === ev.lo && x.hi === ev.hi);
        if (!sl && ev.phase !== "error" && ev.phase !== "cancelled") state.slices.push(sl = { model: ev.model, lo: ev.lo, hi: ev.hi, loaded: false });
        if (sl) Object.assign(sl, { phase: ev.phase, done: ev.done, total: ev.total, loaded: ev.phase === "ready" || sl.loaded });
        if (ev.phase === "error" || ev.phase === "cancelled") state.slices = state.slices.filter(x => x.loaded || x !== sl);
      }
      if (ev.phase !== was) {
        if (ev.phase === "downloading" && !was) feed("load", `${ev.node} is downloading ${what || "its layers"}`, "", "info", ts);
        if (ev.phase === "loading") feed("load", `${ev.node} is loading ${what || "layers"} into memory`, "", "info", ts);
        if (ev.phase === "ready") feed("load", `${ev.node} is serving ${what || "its layers"}`, "", "success", ts);
        if (ev.phase === "cancelled") feed("load", `${ev.node} cancelled the download of ${what || "its layers"}`, "", "info", ts);
        if (ev.phase === "error") feed("load", `${ev.node} couldn't serve ${what || "its layers"}`, ev.message || "", "error", ts);
      }
      break;
    }
    case "slices":
      state.slices = ev.slices || [];
      if (ev.mem_free_gb != null) state.memFree = ev.mem_free_gb;
      break;
    case "models": {
      const before = new Map((state.engineModels || []).map(m => [m.model, m.state]));
      state.engineModels = ev.models || [];
      for (const m of state.engineModels) {
        const was = before.get(m.model);
        if (was && was !== "available" && m.state === "available") { feed("covered", `${shortModel(m.model)} is available`, "Every layer has a reachable peer.", "success", ts); emit("signal", { kind: "ready", model: m.model }); }
        if (was === "available" && m.state !== "available") feed("lost", `${shortModel(m.model)} is no longer covered`, m.gaps.length ? `Layers ${m.gaps.map(([a, b]) => fmt.layers(a, b)).join(", ")} have no reachable peer` : "", "warn", ts);
      }
      break;
    }
    case "reroute":
      feed("rebalance", `Re-routed around ${ev.failed}`, `${ev.reason} · now ${(ev.route || []).map(([n, lo, hi]) => `${n} ${fmt.layers(lo, hi)}`).join(" → ")} · replayed ${ev.replay_tokens} tokens`, "warn", ts);
      break;
    case "layer_map":
      state.layerMap = ev;
      for (const a of ev.assignments) Object.assign(node(a.node), { lo: a.lo, hi: a.hi, roles: a.roles || [] });
      feed("rebalance", "Layers assigned", ev.assignments.map(a => `${a.node} ${fmt.layers(a.lo, a.hi)}`).join(" · "), "info", ts);
      break;
    case "ready":
      if (!state.ready) { feed("covered", "Model fully covered", "Every layer has a peer. The Playground is unlocked.", "success", ts); emit("signal", { kind: "ready" }); }
      state.ready = true; state.loadRequested = false; state.lastError = "";
      break;
    case "video_setup": {
      const was = state.video.setup?.phase;
      state.video.setup = ev;
      if (state.video.status) Object.assign(state.video.status, { installed: ev.installed, models_ready: ev.models_ready });
      if (ev.phase === "ready" && was && was !== "ready") feed("download", "Video is ready on this machine", "", "success", ts);
      if (ev.phase === "error" && was !== "error") feed("error", "Video setup stopped", ev.message, "error", ts);
      break;
    }
    case "video_encoder": {
      const { type, ts: _t, ...enc } = ev;
      const was = state.video.encoder;
      state.video.encoder = enc;
      if (was?.fetching && !was.fetching.error && !enc.fetching) feed("download", "Encoder layers downloaded", `Layers ${fmt.layers(was.fetching.lo, was.fetching.hi)}`, "success", ts);
      if (enc.fetching?.error && !was?.fetching?.error) feed("error", "Encoder download stopped", enc.fetching.error, "error", ts);
      break;
    }
    case "video_job": {
      const was = state.video.jobs[ev.id]?.state;
      const { type, ts: _t, ...job } = ev;
      state.video.jobs[ev.id] = job;
      if (was && was !== job.state) {
        if (job.state === "done") { feed("generate", "Video finished", job.prompt.slice(0, 80), "success", ts); emit("signal", { kind: "video", id: job.id }); }
        if (job.state === "failed") feed("error", "Video failed", job.error, "error", ts);
      }
      break;
    }
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
    for (const p of peers) if (!was.has(p.peer_id) && p.peer_id !== ev.self_id) feed("join", `${p.name || "A machine"} came online`, p.chip || "", "info");
  }
  state.swarm = { status: ev.status, selfId: ev.self_id || "", peers };
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
    d.block_s += state.slices.filter(x => x.loaded).reduce((a, x) => a + x.hi - x.lo, 0);
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
  if (n.name === s.self) return s.slices.some(x => x.loaded);
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

export const shortModel = repo => (repo || "").split("/").pop();

/** The slices a node serves: this Mac's from the engine, others' from their swarm record. */
export function nodeSlices(name, s = state) {
  if (name === s.self) return s.slices;
  if (s.nodes[name]?.preview) return s.nodes[name].slices || [];
  const p = s.swarm.peers.find(x => (x.name || x.peer_id.slice(0, 8)) === name);
  return p ? peerSlices(p) : [];
}
/** "Qwen3-30B-A3B-4bit 0–23 · Qwen3-8B 0–35", with the model left out when only one model is served. */
export function slicesLabel(list, empty = "Nothing") {
  if (!list.length) return empty;
  const many = new Set(list.map(x => x.model)).size > 1 || list.some(x => x.model !== state.hostInfo?.repo);
  return list.map(x => `${many ? shortModel(x.model) + " " : ""}${fmt.layers(x.lo, x.hi)}`).join(" · ");
}
const layerList = gaps => gaps.map(([a, b]) => b - a > 1 ? `${a}–${b - 1}` : `${a}`).join(", ");
const peerSlices = p => p.link?.info?.slices || p.slices || [];

/** Model coverage: one entry per model anyone online serves, from the engine's summary (route,
 * gaps, state) plus the swarm records (who serves which layers, and whether we reach them). */
export function models(s = state) {
  return (s.engineModels || []).map(m => coverage(m, s)).sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
}

function coverage(m, s) {
  const n = m.n_layers;
  const layers = Array.from({ length: n }, (_, i) => ({ i, peers: [], state: "gap", serving: 0 }));
  const assignments = [];
  const add = (node, lo, hi, st, roles = []) => {
    assignments.push({ node, lo, hi, roles, state: st });
    for (let i = Math.max(lo, 0); i < hi && i < n; i++) layers[i].peers.push({ node, state: st, roles });
  };
  const self = s.self || "You";
  for (const x of s.slices) if (x.model === m.model) add(self, x.lo, x.hi, x.loaded ? "serving" : x.phase === "error" ? "gap" : "loading");
  for (const p of s.swarm.peers) {
    if (p.peer_id === s.swarm.selfId) continue;
    const reach = p.link?.state === "direct";
    for (const x of peerSlices(p)) if (x.model === m.model) add(p.name || p.peer_id.slice(0, 8), x.lo, x.hi, !x.loaded ? "loading" : reach ? "serving" : "planned");
  }
  const rank = { serving: 4, loading: 3, planned: 2, gap: 1 };
  for (const L of layers) {
    L.serving = L.peers.filter(p => p.state === "serving").length;
    L.state = L.peers.reduce((b, p) => rank[p.state] > rank[b] ? p.state : b, "gap");
  }
  const missing = layers.filter(L => !L.serving).map(L => L.i);
  const loading = layers.filter(L => L.state === "loading").length;
  const unreachable = layers.filter(L => L.state === "planned").length;
  const name = shortModel(m.model);
  const routes = m.redundancy || 0;
  let verdict;
  if (m.state === "available") verdict = { level: "serving", title: `Available · ${routes} route${routes === 1 ? "" : "s"}`, reason: `Every layer has a reachable peer${routes > 1 ? `; each layer has at least ${routes}, so a failure re-routes` : ""}.` };
  else if (loading && m.state !== "available") verdict = { level: "degraded", title: "Loading", reason: `${loading} of ${n} layers are still downloading or loading.${m.gaps.length ? ` Layers ${layerList(m.gaps)} have no peer yet.` : ""}` };
  else if (m.state === "partial") verdict = { level: "gap", title: `Partial · layers ${layerList(m.gaps)} missing`, reason: unreachable ? `Some layers are only on machines this one can't reach directly.` : `No reachable peer serves layers ${layerList(m.gaps)}. Serve them on this machine, or ask a connected machine to.` };
  else verdict = { level: "gap", title: "Offline", reason: unreachable ? "Online machines serve it, but none are reachable from here." : "Nobody online serves it right now." };
  const redundancy = Math.max(1, ...layers.map(L => L.peers.length));
  return {
    ...m, id: m.model, repo: m.model, name, layers, assignments, missing, gaps: m.gaps, serving: n - missing.length, loading, verdict,
    redundancy, routes, runnable: m.state === "available", primary: !!m.default,
  };
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
