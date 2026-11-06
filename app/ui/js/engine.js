// Live engine client: starts/stops this Mac's peer through Tauri, reads its event stream
// (WebSocket on the loopback-only local API), and sends the actions the peer supports.
import { state, settings, setSetting, chatKey, applyEvent, resetState, commit, emit, feed, shortModel } from "./store.js";
import { invoke, isTauri } from "./native.js";
import { uid, fmt } from "./dom.js";

export const HOST_PORT = 27183;
const HOST = `http://localhost:${HOST_PORT}`;
/** Approximate size of the first-run install off Apple Silicon (CUDA PyTorch, unpacked). */
const SETUP_BYTES = 4.5e9;

let ws = null, wsTimer = null, liveTimer = null, epoch = 0;
const toast = (text, kind = "info", detail) => emit("toast", { text, kind, detail });
const post = (path, body, ms) => json(HOST + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, ms);

async function reachable(url, ms = 1200) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { await fetch(url, { mode: "no-cors", signal: c.signal, cache: "no-store" }); return true; }
  catch { return false; }
  finally { clearTimeout(t); }
}
async function json(url, opts = {}, ms = 4000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal, cache: "no-store" });
    let body = null;
    try { body = await r.json(); } catch { /* opaque or empty */ }
    return { ok: r.ok, status: r.status, body };
  } finally { clearTimeout(t); }
}

/** On launch: attach to an engine that's already running (from this app or the CLI). */
export async function attachExisting() {
  stopTimers();
  const owned = isTauri ? await invoke("engine_running").catch(() => false) : false;
  if (await reachable(HOST + "/")) { begin(owned); connectHost(`localhost:${HOST_PORT}`); return true; }
  return false;
}

function begin(owned) {
  const my = ++epoch;
  resetState({ role: "host" });
  state.engine = { phase: "running", owned, line: "", error: "" };
  watchProcess(my);
  commit();
  return my;
}

// ---------- start / stop ----------
/** Start this Mac's peer. Every Mac runs the same peer and finds the others itself. */
export async function startHost() {
  if (state.source === "demo") return toast("Turn off Demo Mode to start a real node", "degraded");
  stopTimers();
  const my = ++epoch;
  resetState({ role: "host" });
  state.engine = { phase: "starting", owned: true, line: "Starting engine (first run installs Python packages)…", error: "" };
  commit();
  try { await invoke("start_engine", { mode: "peer", name: settings.peerName || null }); }
  catch (e) { state.engine = { phase: "stopped", owned: false, line: "", error: String(e) }; commit(); toast("Couldn't start the engine", "gap", String(e)); return; }
  feed("engine", "Started this machine's peer", "It joins the swarm and connects to other machines directly", "info");
  // Give up after ~400 s without progress; a first-run PyTorch download keeps resetting the clock.
  // Progress is cache growth since this start, so later launches (cache already full) show none.
  const base = await invoke("setup_progress").catch(() => 0);
  let got = 0;
  for (let i = 0, idle = 0; idle < 400 && my === epoch; i++, idle++) {
    if (await reachable(HOST + "/")) {
      state.engine.phase = "running"; state.engine.line = ""; state.engine.setup = null;
      commit();
      watchProcess(my);
      connectHost(`localhost:${HOST_PORT}`);
      return;
    }
    if (i % 2 === 0) {
      const bytes = (await invoke("setup_progress").catch(() => 0)) - base;
      if (bytes > got + 1e6) { idle = 0; got = bytes; }
      // Unpacked CUDA PyTorch plus Python is roughly SETUP_BYTES; it's an estimate, so stop short of full.
      state.engine.setup = got > 50e6 ? { bytes: got, frac: Math.min(got / SETUP_BYTES, 0.97) } : null;
      state.engine.line = state.engine.setup
        ? `Installing PyTorch for your GPU (one time, needs internet) · ${(got / 1e9).toFixed(1)} GB so far`
        : (await invoke("engine_log").catch(() => "")).split("\n").pop().slice(0, 140) || state.engine.line;
      commit();
    }
    if (i > 3 && !(await invoke("engine_running").catch(() => true))) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (my !== epoch) return;
  const tail = await invoke("engine_log").catch(() => "");
  state.engine = { phase: "stopped", owned: false, line: "", error: tail || "The engine did not come up. See ~/.podtorrent/engine.log" };
  commit();
  toast("The engine didn't start", "gap", "See Activity → Raw logs");
}

/** Detect an engine that exits under us. */
function watchProcess(my) {
  clearInterval(liveTimer);
  liveTimer = setInterval(async () => {
    if (my !== epoch || !state.engine.owned || state.engine.phase !== "running") return;
    if (!(await invoke("engine_running").catch(() => true))) {
      const tail = await invoke("engine_log").catch(() => "");
      state.engine = { phase: "stopped", owned: false, line: "", error: tail };
      state.conn = "idle";
      stopTimers();
      feed("engine", "Engine stopped unexpectedly", tail, "error");
      commit();
    }
  }, 3000);
}

export async function stopNode() {
  if (state.source === "demo") return;
  if (state.engine.phase === "stopped") return;
  epoch++;
  stopTimers();
  if (state.engine.owned) await invoke("stop_engine").catch(() => {});
  else await fetch(HOST + "/api/shutdown", { method: "POST" }).catch(() => {});
  resetState({ role: null });
  feed("engine", "Node stopped", "", "info");
  toast("Node stopped", "info");
}

export async function quitApp() {
  if (isTauri) return invoke("quit_app");
  await stopNode();
}

/** Stop listening (Demo Mode); the engine process itself keeps running. */
export function detach() { epoch++; stopTimers(); }

function stopTimers() {
  clearTimeout(wsTimer); clearInterval(liveTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---------- the peer's event stream ----------
export function connectHost(addr) {
  const my = epoch;
  clearTimeout(wsTimer);
  state.conn = state.conn === "live" ? "down" : "connecting";
  commit();
  let sock;
  try { sock = new WebSocket(`ws://${addr}/ws?key=${chatKey}`); } catch { state.conn = "down"; commit(); return; }
  ws = sock;
  sock.onopen = () => { if (my !== epoch) return; state.conn = "live"; commit(); applyPendingServe(); };
  sock.onmessage = e => { if (my !== epoch || state.source !== "live") return; try { applyEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  sock.onclose = () => {
    if (my !== epoch) return;
    const was = state.conn;
    state.conn = "down";
    if (was === "live") feed("engine", "Lost connection to the engine", "Reconnecting…", "warn");
    commit();
    wsTimer = setTimeout(() => connectHost(addr), 1500);
  };
}

// ---------- actions ----------
/** Quick start for the default model: this Mac serves the first half, a connected peer the rest. */
export async function loadModel() {
  if (state.source === "demo") return emit("demo:load");
  if (state.engine.phase !== "running") return toast("Start your node first", "degraded");
  state.loadRequested = true; state.lastError = "";
  commit();
  try {
    const r = await post("/api/start", {});
    if (!r.ok) { state.loadRequested = false; state.lastError = r.body?.error || `HTTP ${r.status}`; toast("Couldn't load the model", "gap", state.lastError); }
    else feed("load", "Model load requested", `This machine serves layers 0–${r.body.split - 1}; a connected peer serves the rest`, "info");
  } catch (e) { state.loadRequested = false; toast("Couldn't reach the engine", "gap", String(e)); }
  commit();
}

/** Serve `model` layers [lo, hi) on this Mac (or on a connected peer, by name). Progress arrives as events. */
export async function serveSlice(model, lo, hi, peer = null) {
  const what = `${shortModel(model)} ${fmt.layers(lo, hi)}`;
  if (state.source === "demo") return emit("demo:serve", { model, lo, hi, peer });
  if (state.engine.phase !== "running") return toast("Start your node first", "degraded");
  try {
    const r = await post("/api/serve", { model, lo, hi, peer });
    if (!r.ok) return toast(`Couldn't serve ${what}`, "gap", r.body?.error || `HTTP ${r.status}`);
    feed("load", `${peer || "This machine"} will serve ${what}`, "Downloading only those layers", "info");
    toast(`Serving ${what}${peer ? ` on ${peer}` : ""}`, "info", "Downloads only those layers, then loads them");
    return true;
  } catch (e) { toast("Couldn't reach the engine", "gap", String(e)); }
}

export async function unserveSlice(model, lo, hi) {
  const what = `${shortModel(model)} ${fmt.layers(lo, hi)}`;
  if (state.source === "demo") return emit("demo:unserve", { model, lo, hi });
  try {
    const r = await post("/api/unserve", { model, lo, hi });
    if (!r.ok) return toast(`Couldn't stop serving ${what}`, "gap", r.body?.error || `HTTP ${r.status}`);
    feed("load", `This machine stopped serving ${what}`, "", "info");
    toast(`Stopped serving ${what}`, "info");
  } catch (e) { toast("Couldn't reach the engine", "gap", String(e)); }
}

/** The slice picked during onboarding, served once the peer is up. */
function applyPendingServe() {
  const p = settings.pendingServe;
  if (!p || state.source !== "live") return;
  setSetting("pendingServe", null);
  serveSlice(p.model || state.hostInfo?.repo, p.lo, p.hi);
}

export async function sendPrompt(prompt, model) {
  prompt = prompt.trim();
  if (!prompt || state.chat.busy) return;
  const msgs = state.chat.messages;
  msgs.push({ id: uid(), role: "user", text: prompt });
  const a = { id: uid(), role: "assistant", text: "", prompt, status: "pending", tokens: 0, timings: [], startedAt: performance.now(), model };
  msgs.push(a);
  state.chat.busy = true;
  commit();
  if (state.source === "demo") return emit("demo:chat", { prompt, model });
  try {
    const r = await post("/api/chat", { prompt, model, max_tokens: settings.maxTokens, key: chatKey });
    if (!r.ok) { a.status = "error"; a.error = r.body?.error || `HTTP ${r.status}`; state.chat.busy = false; }
  } catch (e) { a.status = "error"; a.error = String(e); state.chat.busy = false; }
  commit();
}

export async function logTail(name = "engine.log", lines = 800) {
  if (!isTauri) return null;
  return invoke("engine_log_tail", { name, lines });
}

// ---------- catalog: find, download and delete models ----------
const get = (path, ms) => json(HOST + path, {}, ms);
const live = () => state.source === "live" && state.engine.phase === "running";

// Node stopped: browse Hugging Face straight from the UI (mirrors podtorrent/catalog.py), so
// models can be found and sized before starting. Downloading still goes through the node.
const HF = "https://huggingface.co";
async function hfSearch(q) {
  const p = new URLSearchParams({ search: q, filter: "mlx", pipeline_tag: "text-generation", sort: "downloads", direction: "-1", limit: "24" });
  try {
    const r = await json(`${HF}/api/models?${p}`, {}, 15000);
    if (!r.ok) return { error: `Hugging Face search failed: HTTP ${r.status}` };
    return { results: r.body.map(m => ({ repo: m.id, downloads: m.downloads || 0, likes: m.likes || 0, updated: m.lastModified })) };
  } catch (e) { return { error: `Hugging Face search failed: ${e}` }; }
}
async function hfInfo(repo) {
  if (!repo.includes("/")) return { error: "expected owner/name" };
  const file = f => json(`${HF}/${repo}/resolve/main/${f}`, {}, 20000);
  try {
    const c = await file("config.json");
    if (!c.ok) return { error: `couldn't read ${repo}: HTTP ${c.status}` };
    const cfg = "num_hidden_layers" in c.body ? c.body : (c.body.text_config || c.body);
    const n = cfg.num_hidden_layers;
    if (!n) return { error: `${repo} has no num_hidden_layers in config.json` };
    const idx = await file("model.safetensors.index.json").catch(() => null);
    const total = (idx?.ok && idx.body?.metadata?.total_size) || 0;   // single-file model: size unknown up front
    return { offline: true, repo, n_layers: n, size_bytes: total, layer_bytes: total ? Math.floor(total / n) : 0,
      model_type: cfg.model_type || "", mem_total_gb: state.health?.mem_total_gb || 0 };
  } catch (e) { return { error: `couldn't read ${repo}: ${e}` }; }
}

/** MLX models on Hugging Face matching `q` (empty: most downloaded). */
export async function catalogSearch(q) {
  if (!live()) return hfSearch(q);
  try { const r = await get(`/api/catalog/search?q=${encodeURIComponent(q)}`, 15000); return r.ok ? r.body : { error: r.body?.error || `HTTP ${r.status}` }; }
  catch (e) { return { error: String(e) }; }
}
/** Layers, size and a suggested slice for this Mac. */
export async function catalogInfo(repo) {
  if (!live()) return hfInfo(repo);
  try { const r = await get(`/api/catalog/info?repo=${encodeURIComponent(repo)}`, 20000); return r.ok ? r.body : { error: r.body?.error || `HTTP ${r.status}` }; }
  catch (e) { return { error: String(e) }; }
}
/** Model folders on this Mac, with the layers each one holds. */
export async function catalogLocal() {
  if (!live()) return isTauri ? invoke("local_models").catch(() => []) : [];
  try { const r = await get("/api/catalog/local", 15000); return r.ok ? r.body.models : []; }
  catch { return []; }
}
/** Stop a slice that is still downloading; the peer drops the partial file. */
export async function cancelDownload(model, lo, hi) {
  const what = `${shortModel(model)} ${fmt.layers(lo, hi)}`;
  try {
    const r = await post("/api/unserve", { model, lo, hi });
    if (!r.ok) return toast(`Couldn't cancel ${what}`, "gap", r.body?.error || `HTTP ${r.status}`);
    toast(`Cancelled downloading ${what}`, "info", "The partial download was removed.");
    return true;
  } catch (e) { toast("Couldn't reach the engine", "gap", String(e)); }
}

export async function catalogDelete(m) {
  try {
    const r = await post("/api/catalog/delete", { repo: m.repo, dir: m.dir }, 30000);
    if (!r.ok) return toast(`Couldn't delete ${shortModel(m.repo)}`, "gap", r.body?.error || `HTTP ${r.status}`);
    feed("load", `Deleted ${shortModel(m.repo)} from this machine`, fmt.bytes(m.disk_bytes) + " freed", "info");
    toast(`Deleted ${shortModel(m.repo)}`, "info", fmt.bytes(m.disk_bytes) + " freed");
    return true;
  } catch (e) { toast("Couldn't reach the engine", "gap", String(e)); }
}

// ---------- video (MiniMax-H3 on this machine's NVIDIA GPU) ----------
export const videoUrl = (id, kind = "file") => `${HOST}/api/video/${kind}/${id}`;
/** Capability, setup state and job history; also seeds state.video. */
export async function videoStatus() {
  if (!live()) return null;
  try {
    const r = await get("/api/video/status", 8000);
    if (!r.ok) return null;
    state.video.status = r.body;
    state.video.setup = r.body.setup;
    for (const j of r.body.jobs || []) state.video.jobs[j.id] = j;
    commit();
    return r.body;
  } catch { return null; }
}
async function videoPost(path, body, what, ms = 15000) {
  try {
    const r = await post(path, body, ms);
    if (!r.ok) { toast(what, "gap", r.body?.error || `HTTP ${r.status}`); return null; }
    return r.body;
  } catch (e) { toast("Couldn't reach the engine", "gap", String(e)); return null; }
}
export const videoSetup = () => videoPost("/api/video/setup", {}, "Couldn't set up video");
export async function videoSubmit(prompt, preset, seconds, seed, mode = "best") {
  const j = await videoPost("/api/video/jobs", { prompt, preset, seconds, seed, mode }, "Couldn't start the video");
  if (j) { state.video.jobs[j.id] = j; commit(); }
  return j;
}
/** Video roles across the swarm and the route a job would take; stored in state.video.swarm. */
export async function videoSwarmStatus() {
  if (!live()) return null;
  try {
    const r = await get("/api/video/swarm", 8000);
    if (!r.ok) return null;
    state.video.swarm = r.body; commit();
    return r.body;
  } catch { return null; }
}
export async function videoSwarmSubmit(prompt, preset, seconds, seed, mode = "best") {
  const j = await videoPost("/api/video/swarm/jobs", { prompt, preset, seconds, seed, mode }, "Couldn't start the video");
  if (j) { state.video.jobs[j.id] = j; commit(); }
  return j;
}
export const videoCancel = id => videoPost(`/api/video/jobs/${id}/cancel`, {}, "Couldn't cancel");
export async function videoReport(id) {
  try { const r = await get(`/api/video/report/${id}`, 8000); return r.ok ? r.body : null; }
  catch { return null; }
}

// ---------- H3 prompt encoder: this machine's layer slices ----------
export async function encoderStatus() {
  if (!live()) return null;
  try {
    const r = await get("/api/video/encoder", 8000);
    if (!r.ok) return null;
    state.video.encoder = r.body; commit();
    return r.body;
  } catch { return null; }
}
const encoderPost = async (path, body, what, ms) => {
  const r = await videoPost(path, body, what, ms);
  if (r?.slices) { state.video.encoder = r; commit(); }
  return r;
};
export const encoderFetch = (lo, hi) => encoderPost("/api/video/encoder/fetch", { lo, hi }, "Couldn't download the layers");
export const encoderRemove = (lo, hi) => encoderPost("/api/video/encoder/remove", { lo, hi }, "Couldn't remove the layers", 10 * 60000); // splitting a slice copies GBs
export async function encoderTest(prompt) {
  try {
    const r = await post("/api/video/encoder/test", { prompt }, 15 * 60000);
    if (!r.ok) { toast("Couldn't test the encoder", "gap", r.body?.error || `HTTP ${r.status}`); return null; }
    return r.body;
  } catch (e) { toast("Couldn't reach the engine", "gap", String(e)); return null; }
}
