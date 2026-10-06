// Live engine client: starts/stops the Python engine through Tauri, reads the host's event
// stream (WebSocket) or the worker's /status, and sends the few actions the engine supports.
import { state, settings, setSetting, applyEvent, applyWorkerStatus, resetState, commit, emit, feed } from "./store.js";
import { invoke, isTauri } from "./native.js";
import { uid } from "./dom.js";

export const HOST_PORT = 8000, WORKER_PORT = 8001, SPLIT = 24;
const HOST = `http://localhost:${HOST_PORT}`, WORKER = `http://localhost:${WORKER_PORT}`;

let ws = null, wsTimer = null, statusTimer = null, liveTimer = null, epoch = 0;
const toast = (text, kind = "info", detail) => emit("toast", { text, kind, detail });

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
  if (await reachable(HOST + "/")) { begin("host", owned); connectHost(`localhost:${HOST_PORT}`); return true; }
  if (await reachable(WORKER + "/status")) { begin("worker", owned); startWorkerPolling(); return true; }
  return false;
}

function begin(role, owned) {
  const my = ++epoch;
  resetState({ role, self: role === "host" ? "host" : null, hostAddr: settings.hostAddr });
  state.engine = { phase: "running", owned, line: "", error: "" };
  watchProcess(my);
  commit();
  return my;
}

// ---------- start / stop ----------
export async function startHost() {
  if (state.source === "demo") return toast("Turn off Demo Mode to start a real node", "degraded");
  return start("host", null);
}
export async function joinHost(addr) {
  addr = (addr || "").trim();
  if (!addr) return toast("Enter the host's address, e.g. 100.64.0.2:8000", "degraded");
  if (!/:\d+$/.test(addr)) addr += `:${HOST_PORT}`;
  if (state.source === "demo") return toast("Turn off Demo Mode to join a real host", "degraded");
  setSetting("hostAddr", addr);
  return start("worker", addr);
}

async function start(role, addr) {
  stopTimers();
  const my = ++epoch;
  resetState({ role, self: role === "host" ? "host" : null, hostAddr: addr || "" });
  state.engine = { phase: "starting", owned: true, line: "Starting engine (first run installs Python packages)…", error: "" };
  commit();
  try { await invoke("start_engine", { mode: role === "host" ? "host" : "join", addr }); }
  catch (e) { state.engine = { phase: "stopped", owned: false, line: "", error: String(e) }; commit(); toast("Couldn't start the engine", "gap", String(e)); return; }
  feed("engine", role === "host" ? "Started as host" : `Joining host ${addr}`, "", "info");
  const url = role === "host" ? HOST + "/" : WORKER + "/status";
  for (let i = 0; i < 400 && my === epoch; i++) {
    if (await reachable(url)) {
      state.engine.phase = "running"; state.engine.line = "";
      commit();
      watchProcess(my);
      if (role === "host") connectHost(`localhost:${HOST_PORT}`);
      else startWorkerPolling();
      return;
    }
    if (i % 2 === 0) { state.engine.line = (await invoke("engine_log").catch(() => "")).split("\n").pop().slice(0, 140) || state.engine.line; commit(); }
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
  else await fetch((state.role === "host" ? HOST : WORKER) + "/api/shutdown", { method: "POST" }).catch(() => {});
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
  clearTimeout(wsTimer); clearInterval(statusTimer); clearInterval(liveTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---------- host event stream ----------
export function connectHost(addr) {
  const my = epoch;
  clearTimeout(wsTimer);
  state.conn = state.conn === "live" ? "down" : "connecting";
  commit();
  let sock;
  try { sock = new WebSocket(`ws://${addr}/ws`); } catch { state.conn = "down"; commit(); return; }
  ws = sock;
  sock.onopen = () => { if (my !== epoch) return; state.conn = "live"; commit(); };
  sock.onmessage = e => { if (my !== epoch || state.source !== "live") return; try { applyEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  sock.onclose = () => {
    if (my !== epoch) return;
    const was = state.conn;
    state.conn = "down";
    if (was === "live") feed("engine", state.role === "host" ? "Lost connection to the engine" : "Lost connection to the host", "Reconnecting…", "warn");
    commit();
    wsTimer = setTimeout(() => connectHost(addr), state.role === "worker" ? 5000 : 1500);
  };
}

// ---------- worker ----------
function startWorkerPolling() {
  const my = epoch;
  let fails = 0;
  const tick = async () => {
    try {
      const r = await json(WORKER + "/status", {}, 2500);
      if (my !== epoch || state.source !== "live") return;
      if (r.body) { applyWorkerStatus(r.body); fails = 0; if (state.engine.phase === "unreachable") { state.engine.phase = "running"; commit(); } }
    } catch {
      if (my !== epoch) return;
      if (++fails >= 3 && state.engine.phase === "running") { state.engine.phase = "unreachable"; commit(); }
    }
  };
  tick();
  statusTimer = setInterval(tick, 1000);
  // Best effort: the host's event stream gives a worker the full swarm view.
  if (state.hostAddr) connectHost(state.hostAddr);
}

// ---------- actions ----------
export async function loadModel(split = SPLIT) {
  if (state.source === "demo") return emit("demo:load");
  if (state.role !== "host") return toast("Only the host can load the model", "degraded");
  state.loadRequested = true; state.lastError = "";
  commit();
  try {
    const r = await json(HOST + "/api/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ split }) });
    if (!r.ok) { state.loadRequested = false; state.lastError = r.body?.error || `HTTP ${r.status}`; toast("Couldn't load the model", "gap", state.lastError); }
    else feed("load", "Model load requested", `Split at layer ${r.body?.split ?? split}`, "info");
  } catch (e) { state.loadRequested = false; toast("Couldn't reach the engine", "gap", String(e)); }
  commit();
}

export async function sendPrompt(prompt) {
  prompt = prompt.trim();
  if (!prompt || state.chat.busy) return;
  const msgs = state.chat.messages;
  msgs.push({ id: uid(), role: "user", text: prompt });
  const a = { id: uid(), role: "assistant", text: "", prompt, status: "pending", tokens: 0, timings: [], startedAt: performance.now(), model: state.hostInfo?.repo };
  msgs.push(a);
  state.chat.busy = true;
  commit();
  if (state.source === "demo") return emit("demo:chat", { prompt });
  try {
    const r = await json(HOST + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, max_tokens: settings.maxTokens }) });
    if (!r.ok) { a.status = "error"; a.error = r.body?.error || `HTTP ${r.status}`; state.chat.busy = false; }
  } catch (e) { a.status = "error"; a.error = String(e); state.chat.busy = false; }
  commit();
}

// ---------- slice downloads (replaces the old launcher) ----------
let dlTimer = null;
export async function refreshDownload() {
  if (!isTauri) return;
  try { state.download = { ...(state.download || {}), ...(await invoke("download_status", { split: SPLIT })) }; } catch { /* ignore */ }
  const p = state.download?.progress;
  if (state.download?.busy && p && (p.phase === "done" || p.phase === "error")) {
    state.download.busy = false;
    if (p.phase === "done") { toast(`${p.role === "host" ? "Host" : "Worker"} layers downloaded`, "serving"); feed("download", "Slice downloaded", p.role, "success"); }
    else toast("Download failed", "gap", p.message);
  }
  commit();
}
export async function downloadSlice(role) {
  try {
    await invoke("start_download", { role, split: SPLIT });
    state.download = { ...(state.download || {}), busy: true, role, progress: null };
    feed("download", `Downloading ${role} layers`, role === "host" ? `Layers 0–${SPLIT - 1} + embeddings + head` : `Layers ${SPLIT}–47`, "info");
    commit();
  } catch (e) { toast("Couldn't start the download", "gap", String(e)); }
}
export function initDownloads() {
  if (!isTauri) return;
  refreshDownload();
  clearInterval(dlTimer);
  let n = 0;
  dlTimer = setInterval(() => { if (state.download?.busy || (!document.hidden && ++n % 5 === 0)) refreshDownload(); }, 1000);
}

export async function logTail(name = "engine.log", lines = 800) {
  if (!isTauri) return null;
  return invoke("engine_log_tail", { name, lines });
}
