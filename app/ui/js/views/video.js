// Video: text to video with MiniMax-H3. A job runs on the swarm (prompt encoder layers on the machines
// that hold them, then a GPU machine renders) or, on an NVIDIA machine that's set up, all here.
// Setup downloads a headless ComfyUI and ~44 GB of weights once; each job keeps a diagnostics report.
import { h, text, cls, fmt } from "../dom.js";
import { state } from "../store.js";
import { button, segmented, empty, badge, setBadge } from "../ui.js";
import { startHost, videoStatus, videoSetup, videoSubmit, videoCancel, videoReport, videoUrl,
  encoderStatus, encoderFetch, encoderRemove, encoderTest, videoSwarmStatus, videoSwarmSubmit, unserveSlice } from "../engine.js";
import { go as goView } from "../actions.js";
import { icon } from "../icons.js";
import { videoFlow, activeStage } from "../viz/videoflow.js";
import { copyText } from "../actions.js";

const LENGTHS = [5, 8, 10, 15]; // the model is trained on ~5-15 s clips
const STAGES = { queued: "Waiting", starting: "Starting", loading: "Loading model", encoding: "Reading prompt", generating: "Generating",
  decoding: "Decoding", saving: "Saving", done: "Done", failed: "Failed", cancelled: "Cancelled" };
const TONE = { done: "serving", failed: "gap", cancelled: "neutral", queued: "neutral" };
const FINISHED = ["done", "failed", "cancelled"];
const IDEAS = [
  "A red fox trotting through fresh snow at sunrise, soft wind, distant birdsong.",
  "Close-up of rain hitting a city window at night, neon reflections, gentle thunder.",
  "A street drummer in a busy market, handheld camera, crowd chatter and steady beat.",
];

/** First run of encoder layers nobody in the swarm holds, as [lo, hi), or null. Only once some machine
 *  holds layers (an empty swarm has nothing to complete). */
function missingLayers(sw, n) {
  if (!sw?.machines) return null;
  const have = new Array(n).fill(false);
  let any = false;
  for (const m of sw.machines) for (const [a, b] of m.encoder) { any = true; for (let i = a; i < Math.min(b, n); i++) have[i] = true; }
  const lo = have.indexOf(false);
  if (!any || lo < 0) return null;
  let hi = lo;
  while (hi < n && !have[hi]) hi++;
  return [lo, hi];
}

/** Prompt encoder card: this machine's share of H3's 50 Qwen3-VL layers. Shown on every machine. */
function encoderCard() {
  let enc = null, busyTest = false, testPrompt = "";
  const n = () => enc?.n_layers || 50;
  const bytes = (lo, hi) => (hi - lo) * enc.layer_bytes + (lo === 0 ? enc.embed_bytes : 0);
  // The pick is [pa, pb): set by a chip, or by clicking/dragging the boxes (click one end, then the other).
  let pa = 0, pb = 25, anchor = null, dragging = false;
  const bar = h("div.lbar.pickable", { role: "group", "aria-label": "Encoder layers on this machine. Click or drag to pick layers." });
  const boxAt = e => { const t = e.target.closest?.("i[data-i]"); return t && bar.contains(t) ? +t.dataset.i : null; };
  const span = (x, y) => { pa = Math.min(x, y); pb = Math.max(x, y) + 1; paint(); };
  bar.addEventListener("pointerdown", e => {
    const i = boxAt(e); if (i == null) return;
    e.preventDefault(); dragging = true;
    // A single-box pick is the first end: the next click picks the other end. Shift-click extends.
    anchor = e.shiftKey || (pb - pa === 1 && i !== pa) ? pa : i;
    span(anchor, i);
  });
  bar.addEventListener("pointerover", e => { const i = boxAt(e); if (dragging && i != null && anchor != null) { pa = Math.min(anchor, i); pb = Math.max(anchor, i) + 1; paint(); } });
  addEventListener("pointerup", () => { dragging = false; });
  // A chip is pressed while the pick matches it; pressing it again clears the pick so the boxes take over.
  const chips = [];
  const chip = (range, tip) => {
    const c = h("button.chip-btn", { type: "button", "data-tip": tip, onclick: () => {
      const [a, b] = range();
      if (pa === a && pb === b) pa = pb = 0; else pa = a, pb = b;
      anchor = null; paint();
    } });
    chips.push([c, range]);
    return c;
  };
  const presets = h("div.row.wrap", { style: { gap: "6px" } },
    chip(() => [0, Math.floor(n() / 2)]), chip(() => [Math.floor(n() / 2), n()]), chip(() => [0, n()]));
  // A Mac runs its layers fastest, so it takes as many as its memory allows (from layer 0) and the
  // video machine takes the rest; 1.5 GB stays free for activations.
  // Memory already held by text-model layers on the same budget counts against it.
  const mostThatFit = () => Math.max(1, Math.min(n(), Math.floor(((enc.mem_budget_gb - (enc.shares_budget ? enc.text_gb || 0 : 0)) * 1e9 - enc.embed_bytes - 1.5e9) / enc.layer_bytes)));
  const fitBtn = chip(() => [0, mostThatFit()], "As many layers from layer 0 as this machine's memory holds. The video machine takes the rest.");
  presets.prepend(fitBtn);
  // The layers no machine or peer holds yet: a chip picks them, so one click completes the chain.
  let gap = null;
  const gapChip = chip(() => gap || [0, 0], "The layers no machine or peer holds yet. Taking them completes the chain.");
  presets.append(gapChip);
  const note = h("div.small.muted"), err = h("div.small.gap-text");
  const shared = h("div.next", icon("info"), h("span.grow"), button("Open My Node", { size: "sm", variant: "ghost", onclick: () => goView("node") }));
  // One button for the pick: download the layers this machine lacks, or remove the ones it has.
  let act = null;
  const actBtn = button("Download", { variant: "primary", icon: "download", onclick: async () => {
    if (!act) return;
    actBtn.disabled = true;
    if (act.remove) { text(actBtn.lastChild, "Removing…"); await encoderRemove(act.lo, act.hi); } else await encoderFetch(act.lo, act.hi);
    act = null; paint(); } });
  const prog = h("div.progress", h("i")), progMsg = h("div.small.muted");
  const mine = h("div.col", { style: { gap: "6px" } });
  const tIn = h("input.input", { placeholder: "A red fox runs through fresh snow at dawn.", "aria-label": "Test prompt" });
  tIn.addEventListener("input", () => { testPrompt = tIn.value; });
  const tBtn = button("Test my layers", { icon: "play", tip: "Reads the prompt with the layers on this machine and reports time, memory and the output.",
    onclick: async () => { busyTest = true; paint(); await encoderTest(testPrompt); busyTest = false; paint(); } });
  const result = h("div.small.col", { style: { gap: "2px" } });
  const testRow = h("div.col", { style: { gap: "8px" } }, h("div.row", { style: { gap: "8px" } }, h("div.grow", tIn), tBtn), result);
  const el = h("section.card",
    h("div.card-h", h("h2", "Prompt encoder"), h("span.spacer"), h("span.small.faint", "Qwen3-VL-32B · 50 layers")),
    h("div.card-b.col", { style: { gap: "12px" } },
      h("p.small.muted", "H3 reads your prompt with Qwen3-VL's first 50 layers before the video machine draws it. Machines split these layers, so each one downloads only its share. Pick the layers this machine keeps."),
      h("div.lbar-wrap", bar, h("div.lbar-key.small.faint", ...[["srv", "In memory"], ["disk", "Downloaded"], ["load", "Downloading"], ["pick", "Your pick"]].map(([c, l]) => h("span", h(`i.${c}`), l)))),
      mine,
      presets,
      shared, note, err, prog, progMsg, h("div.row", h("span.spacer"), actBtn),
      h("div", { style: { borderTop: "1px solid var(--line-1)" } }), h("b.small", "Test"), testRow,
      h("p.small.faint", "The test runs only this machine's layers. Video jobs chain them with the other machines' layers automatically.")));

  function paint() {
    enc = state.video.encoder;
    if (!enc) return;
    const N = n(), f = enc.fetching && !enc.fetching.error ? enc.fetching : null;
    const has = i => enc.slices.find(s => s.lo <= i && i < s.hi);
    const mk = JSON.stringify(enc.slices);
    if (mine.dataset.k !== mk) {
      // Layers came or went: start the pick on the first layers this machine doesn't have.
      pa = Array.from({ length: N }, (_, i) => i).find(i => !has(i)) ?? N;
      for (pb = pa; pb < N && !has(pb);) pb++;
      anchor = null;
    }
    pb = Math.min(pb, N); pa = Math.min(pa, pb);
    const a = pa, b = pb, valid = b > a;
    bar.replaceChildren(...Array.from({ length: N }, (_, i) => {
      const s = has(i);
      const c = (s ? (s.loaded ? ".srv" : ".disk") : f && f.lo <= i && i < f.hi ? ".load" : "") + (valid && a <= i && i < b ? ".pick" : "");
      return h(`i${c}`, { title: `Layer ${i}`, "data-i": i });
    }));
    if (mine.dataset.k !== mk) mine.dataset.k = mk, mine.replaceChildren(...enc.slices.map(s => h("div.row.enc-slice", { style: { gap: "8px" } },
      h("b", `Layers ${fmt.layers(s.lo, s.hi)}`), h("span.small.muted", `${fmt.bytes(s.bytes)} · ${s.loaded ? "in memory" : "on disk"}${s.lo === 0 ? " · reads the prompt" : ""}${s.hi === N ? " · makes the final output" : ""}`),
      h("span.spacer"), button("Remove", { size: "sm", variant: "ghost", onclick: () => encoderRemove(s.lo, s.hi) }))));
    const textGb = enc.shares_budget ? enc.text_gb || 0 : 0;
    shared.hidden = !textGb;
    if (textGb) text(shared.children[1], `Text-model layers on this machine use ${fmt.gb(textGb)} of the same memory. To keep more encoder layers here, stop serving some text layers in My Node.`);
    const left = enc.mem_budget_gb - textGb - enc.slices.reduce((x, s) => x + bytes(s.lo, s.hi), 0) / 1e9;
    const held = valid ? Array.from({ length: b - a }, (_, k) => a + k).filter(i => has(i)) : [];
    const lack = valid ? Array.from({ length: b - a }, (_, k) => a + k).filter(i => !has(i)) : [];
    const all = enc.slices.reduce((x, s) => x + s.hi - s.lo, 0) >= N;
    // Download what the pick lacks when that's one run of layers; remove when it's all here already.
    act = !valid ? null : !lack.length ? { remove: true, lo: a, hi: b }
      : lack.at(-1) - lack[0] + 1 === lack.length ? { lo: lack[0], hi: lack.at(-1) + 1 } : null;
    let e = "";
    if (act && !act.remove && bytes(act.lo, act.hi) / 1e9 > left) e = `Too big for this machine's memory: layers ${fmt.layers(act.lo, act.hi)} need ${fmt.gb(bytes(act.lo, act.hi) / 1e9)} and ${fmt.gb(Math.max(left, 0))} is left${textGb ? " (text-model layers use the rest: stop serving some in My Node to make room)" : ""}. Pick fewer layers.`;
    const budget = `${fmt.bytes(enc.disk_free)} free on disk, ${fmt.gb(enc.mem_budget_gb)} memory budget for ${enc.device === "cpu" ? "encoder layers. They run on the CPU from system RAM: the GPU is kept for video" : `models${enc.text_gb ? `, ${fmt.gb(enc.text_gb)} of it used by text-model layers` : ""}`}.`;
    text(note, !valid ? (all ? `All ${N} layers are on this machine. Pick some to remove them.` : "Pick layers: click a box for the first layer, then another for the last, or drag across them.")
      : !act ? "Your pick has layers here and gaps between them. Pick only layers this machine has to remove them, or one run of new layers to download."
      : act.remove ? `Removing layers ${fmt.layers(a, b)} frees about ${fmt.bytes(bytes(a, b))}. Another machine or peer can take them.`
      : `Layers ${fmt.layers(act.lo, act.hi)}: ${act.hi - act.lo} layers${act.lo === 0 ? " plus the token embedding" : ""}, about ${fmt.bytes(bytes(act.lo, act.hi))} to download and about the same in memory`
        + `${held.length ? ` (the other ${held.length} you picked are already here)` : ""}. ${budget}`);
    text(err, e || enc.fetching?.error || "");
    actBtn.hidden = !act;
    if (act) {
      cls(actBtn, "primary", !act.remove); cls(actBtn, "danger", !!act.remove);
      actBtn.firstChild.replaceWith(icon(act.remove ? "x" : "download"));
      text(actBtn.lastChild, `${act.remove ? "Remove" : "Download"} layers ${fmt.layers(act.lo, act.hi)}`);
    }
    actBtn.disabled = !act || !!e || !!f || !!enc.testing;
    prog.hidden = progMsg.hidden = !f;
    if (f) { prog.firstChild.style.width = `${Math.round(100 * f.done / (f.total || 1))}%`; text(progMsg, `Downloading layers ${fmt.layers(f.lo, f.hi)} · ${fmt.bytes(f.done)} of ${fmt.bytes(f.total)}`); }
    gap = missingLayers(state.video.swarm, N);
    gapChip.hidden = !gap;
    fitBtn.hidden = enc.device === "cpu";  // the video machine fills in the rest instead
    const labels = ["First half", "Second half", "All", "Most that fit", "Missing"];
    chips.forEach(([c, range], k) => { const [x, y] = range(); text(c, `${labels[k]} (${fmt.layers(x, y)})`); c.setAttribute("aria-pressed", String(pa === x && pb === y)); });
    tBtn.disabled = busyTest || enc.testing || !enc.slices.length;
    tBtn.lastChild.textContent = busyTest || enc.testing ? "Testing…" : "Test my layers";
    const t = enc.last_test;
    if (!t) result.replaceChildren(h("span.faint", enc.slices.length ? "No test yet. The first test also loads the layers into memory." : "Download some layers to test them."));
    else if (t.error && !t.runs) result.replaceChildren(h("span.gap-text", t.error));
    else result.replaceChildren(
      h("span", h("b", t.ok ? (t.complete ? "Done: full prompt encoding" : "Done: this machine's share") : "Problem"), ` · ${t.tokens} tokens · ${t.seconds}s · peak ${t.peak_gb ? t.peak_gb + " GB" : "–"}`),
      ...t.runs.map(r => h("span.muted", `Layers ${fmt.layers(r.lo, r.hi)}: ${r.load_s ? `loaded in ${r.load_s}s, ` : ""}ran in ${r.run_s}s`)),
      h("span.muted", `Output ${t.shape.join(" × ")} · mean |x| ${t.mean_abs.toFixed(3)} · max |x| ${t.max_abs.toFixed(1)}`),
      t.stand_in ? h("span.faint", "These layers don't start at layer 0, so they ran on a stand-in input: the timing and memory are real, the numbers aren't a real encoding.") : "",
      t.error ? h("span.gap-text", t.error) : "");
  }
  return { el, paint };
}

let pick = { preset: "draft", seconds: 5, mode: "best", where: "swarm" }, draft = "";
const elapsed = (a, b) => { const s = Math.max(0, Math.round((b || Date.now() / 1000) - a)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };

export default {
  title: "Video",
  subtitle: s => s.video.status?.gpu?.name || "",
  mount(root) {
    // ---- not running / unsupported ----
    const offline = empty({ icon: "video", title: "Start your node to make videos", body: "Video runs on this machine's GPU through the PodTorrent engine.",
      actions: [button("Start My Node", { variant: "primary", icon: "power", onclick: () => startHost() })] });
    const unsupported = h("div");
    const pausedMsg = h("div.grow");
    const pausedBox = h("div.next", icon("alert"), pausedMsg,
      button("Stop serving text layers", { size: "sm", variant: "primary", onclick: async () => {
        for (const x of [...state.slices]) await unserveSlice(x.model, x.lo, x.hi);
        videoStatus(); } }));
    const loading = h("div.card.pad.muted", "Checking this machine…");

    // ---- setup ----
    const setupMsg = h("div.small.muted"), setupBar = h("div.progress", h("i")), setupErr = h("div.small.gap-text");
    const setupBtn = button("Set up video", { variant: "primary", icon: "download", onclick: () => videoSetup() });
    const setupSize = h("b"), setupTitle = h("h2");
    const setupFirst = h("p", "PodTorrent downloads the MiniMax-H3 video model (", setupSize, ") and a video engine the first time. It runs here, on your GPU. This takes a while; you can leave the app open and do other things.");
    const updateSize = h("span");
    const setupUpdate = h("p", "The video engine has an update that fixes blocky, noisy video. It downloads about ", updateSize, ".");
    const setupCard = h("section.card.video-setup",
      h("div.card-h", setupTitle),
      h("div.card-b.col", { style: { gap: "10px" } },
        setupFirst, setupUpdate,
        h("p.small.muted", "By setting up, you accept the MiniMax H3 Community License."),
        setupBar, setupMsg, setupErr),
      h("div.card-f", setupBtn));

    // ---- composer ----
    const prompt = h("textarea.input.video-prompt", { rows: 4, placeholder: "Describe the scene, the camera and the sound. For example: " + IDEAS[0], "aria-label": "Video prompt" });
    prompt.value = draft;
    prompt.addEventListener("input", () => { draft = prompt.value; paintGo(); });
    prompt.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
    const presetSeg = h("span"), modeSeg = h("span"), lenSeg = segmented(LENGTHS.map(s => ({ value: s, label: `${s}s` })), pick.seconds, v => { pick.seconds = v; }, "Length");
    const goBtn = button("Generate", { variant: "primary", icon: "video", onclick: () => go() });
    const cmpBtn = button("Compare Fast and Best", { size: "sm", tip: "Renders this prompt twice with the same seed, once in each mode, so you can see the difference.", onclick: () => compare() });
    const ideas = h("div.suggest", IDEAS.map(t => h("button.suggest-btn", { type: "button", onclick: () => { prompt.value = draft = t; paintGo(); prompt.focus(); } }, t)));
    const warn = h("div.small.muted");
    const whereSeg = segmented([{ value: "swarm", label: "Swarm", tip: "Encoder layers on the machines that hold them, then a GPU machine renders" },
      { value: "local", label: "This machine", tip: "Everything on this machine's GPU" }], pick.where, v => { pick.where = v; paintRoute(); }, "Where");
    const whereRow = h("div.row.wrap", { style: { gap: "12px" } }, h("span.small.muted", "Where"), whereSeg);
    const routeBox = h("div.col", { style: { gap: "6px" } });
    let canLocal = false, swarmSt = null;
    function paintRoute() {
      const where = canLocal ? pick.where : "swarm";
      whereRow.hidden = !canLocal || !swarmSt?.route;
      if (where === "local") return routeBox.replaceChildren(h("span.small.muted", "Runs entirely on this machine."));
      const k = JSON.stringify([swarmSt?.route, swarmSt?.reason]);
      if (routeBox.dataset.k === k) return;
      routeBox.dataset.k = k;
      routeBox.replaceChildren(...(swarmSt?.route ? [h("span.small.muted", "Route"), videoFlow(swarmSt.route)]
        : [h("span.small.gap-text", swarmSt ? swarmSt.reason : "Looking for machines and peers…")]));
    }
    const composer = h("section.card",
      h("div.card-h", h("h2", "New video"), h("span.spacer"), h("span.small.faint", "Ctrl+Enter to generate")),
      h("div.card-b.col", { style: { gap: "12px" } }, prompt, ideas,
        h("div.row.wrap", { style: { gap: "12px" } }, h("span.small.muted", "Shape"), presetSeg, h("span.small.muted", "Length"), lenSeg),
        whereRow, routeBox,
        h("div.row.wrap", { style: { gap: "12px" } }, h("span.small.muted", "Quality"), modeSeg, h("span.spacer"), cmpBtn, goBtn),
        warn));
    const submit = (...a) => (canLocal && pick.where === "local" ? videoSubmit : videoSwarmSubmit)(...a);
    async function go() {
      if (!draft.trim()) return prompt.focus();
      goBtn.disabled = true;
      const j = await submit(draft.trim(), pick.preset, pick.seconds, null, pick.mode);
      goBtn.disabled = false;
      if (j) { prompt.value = draft = ""; paintGo(); }
    }
    async function compare() {
      if (!draft.trim()) return prompt.focus();
      const seed = Math.floor(Math.random() * 2 ** 40);
      cmpBtn.disabled = true;
      const a = await submit(draft.trim(), pick.preset, pick.seconds, seed, "fast");
      if (a) await submit(draft.trim(), pick.preset, pick.seconds, seed, "best");
      cmpBtn.disabled = false;
    }
    const paintGo = () => { goBtn.disabled = cmpBtn.disabled = !draft.trim(); };
    paintGo();

    // ---- jobs ----
    const jobsBox = h("div.col.video-jobs", { style: { gap: "12px" } });
    const jobEls = new Map();
    function jobEl(j) {
      const b = badge("", "neutral"), bar = h("div.progress", h("i")), detail = h("span.small.muted"), time = h("span.small.faint");
      const media = h("div.video-media"), err = h("div.small.gap-text"), flow = h("div");
      const cancel = button("Cancel", { size: "sm", onclick: () => videoCancel(j.id) });
      const report = button("Copy report", { size: "sm", icon: "copy", tip: "Diagnostics for this video: timings and memory. Paste it to whoever is helping you.",
        onclick: async () => { const r = await videoReport(j.id); r ? copyText(JSON.stringify(r, null, 2), "Report copied") : copyText(JSON.stringify(state.video.jobs[j.id], null, 2), "Job details copied"); } });
      const el = h("section.card.video-job",
        h("div.card-h", b, h("span.ellipsis.grow.video-title", { title: j.prompt }, j.prompt), time),
        h("div.card-b.col", { style: { gap: "8px" } }, media, flow, bar, h("div.row", detail, h("span.spacer"), h("span.small.faint", `${j.width}×${j.height} · ${j.seconds}s · ${j.mode === "fast" ? "Fast" : "Best"} · seed ${j.seed}`)), err),
        h("div.card-f", cancel, report));
      const o = { el, paint(j) {
        setBadge(b, STAGES[j.state] || j.state, TONE[j.state] || "active");
        const done = FINISHED.includes(j.state);
        cls(bar, "indeterminate", !done && j.state !== "generating");
        bar.hidden = done;
        bar.firstChild.style.width = j.state === "generating" ? `${Math.round(100 * j.step / (j.steps || 1))}%` : "";
        text(detail, done ? (j.state === "done" ? `Made in ${elapsed(j.started, j.finished)}` : "") : j.detail || "");
        text(time, j.started ? elapsed(j.started, j.finished) : fmt.ago(Date.now() / 1000 - j.created));
        text(err, j.error || "");
        const at = j.route && !done ? activeStage(j, j.route) : null;
        if (j.route && flow.dataset.k !== (at || "")) { flow.dataset.k = at || ""; flow.replaceChildren(videoFlow(j.route, at)); }
        cancel.hidden = done;
        report.hidden = !done;
        if (j.state === "done" && j.video && !media.firstChild) media.append(h("video", { controls: true, preload: "metadata", src: videoUrl(j.id) }));
        if (j.state === "done" && !j.video && !media.firstChild) media.append(h("div.small.muted", j.fake ? "Simulated run: no video file." : "No video file."));
      } };
      return o;
    }
    function paintJobs(s) {
      const list = Object.values(s.video.jobs).sort((a, b) => b.created - a.created);
      const keep = new Set(list.map(j => j.id));
      for (const [id, o] of jobEls) if (!keep.has(id)) { o.el.remove(); jobEls.delete(id); }
      list.forEach((j, i) => {
        let o = jobEls.get(j.id);
        if (!o) { o = jobEl(j); jobEls.set(j.id, o); }
        o.paint(j);
        if (jobsBox.children[i] !== o.el) jobsBox.insertBefore(o.el, jobsBox.children[i] || null);
      });
    }

    const enc = encoderCard();
    let encAsked = false;
    const page = h("div.page.video");
    root.append(page);
    let shown = null, asked = false, swarmAsked = 0, slicesKey = null;
    const show = (key, ...els) => { if (shown !== key) { shown = key; page.replaceChildren(...els); } };
    const tick = setInterval(() => paintJobs(state), 1000);

    return {
      unmount() { clearInterval(tick); },
      update(s) {
        if (s.source !== "live" || s.engine.phase !== "running") { asked = encAsked = false; return show("offline", offline); }
        if (!encAsked) { encAsked = true; encoderStatus(); }
        enc.paint();
        if (Date.now() - swarmAsked > 3000) { swarmAsked = Date.now(); videoSwarmStatus(); }
        const sk = JSON.stringify(s.slices.map(x => [x.model, x.lo, x.hi, x.loaded]));
        if (sk !== slicesKey) { if (slicesKey !== null) { videoStatus(); encoderStatus(); } slicesKey = sk; }
        if (!s.video.status) { if (!asked) { asked = true; videoStatus(); } return show("loading", loading); }
        const st = s.video.status, cap = st.capability;
        const ready = st.installed && st.models_ready;
        swarmSt = s.video.swarm; canLocal = ready;
        const viaSwarm = !!swarmSt?.route;
        if (!presetSeg.firstChild) presetSeg.append(segmented(Object.entries(st.presets).map(([k, p]) => ({ value: k, label: p.label, tip: `${p.width}×${p.height}` })), pick.preset, v => { pick.preset = v; }, "Shape"));
        if (!modeSeg.firstChild) modeSeg.append(segmented(Object.entries(st.modes || { best: { label: "Best" } }).map(([k, m]) => ({ value: k, label: m.label, tip: `${m.steps} steps` })), pick.mode, v => { pick.mode = v; }, "Quality"));
        paintRoute();
        text(warn, [ready ? cap.warn : "", "Draft is fastest (minutes). HD on a 12 GB GPU can take an hour or more. Best is sharper; Fast takes about half the time."].filter(Boolean).join(" "));
        const work = ready || viaSwarm ? [composer] : [];
        const tail = [enc.el, jobsBox];
        if (!cap.ok && !ready) {
          const renderer = swarmSt?.machines?.some(m => m.video);
          unsupported.replaceChildren(empty({ icon: "video", title: renderer ? "Almost ready: the prompt encoder needs layers" : "No machine or peer can render videos yet",
            body: renderer ? `${swarmSt.reason} This machine can keep some of them (below).`
              : `${cap.reason} Start PodTorrent on a machine that has one. This machine can still take part by keeping prompt encoder layers (below).` }));
          show(`unsupported:${cap.reason}:${viaSwarm}`, ...work, ...(viaSwarm ? [] : [unsupported]), ...tail);
          return paintJobs(s);
        }
        if (!ready) {
          const su = s.video.setup || st.setup || {};
          const busy = ["install", "models"].includes(su.phase);
          text(setupSize, `about ${st.missing_gb || st.models_gb} GB`);
          text(updateSize, `${st.missing_gb || 3} GB`);  // 3 GB: engine-only update
          text(setupTitle, st.update ? "Update the video engine" : "Set up video on this machine");
          setupFirst.hidden = !!st.update; setupUpdate.hidden = !st.update;
          setupBar.hidden = !busy;
          cls(setupBar, "indeterminate", su.phase === "install" || !su.total);
          setupBar.firstChild.style.width = su.phase === "models" && su.total ? `${Math.round(100 * su.done / su.total)}%` : "";
          text(setupMsg, busy ? (su.phase === "models" && su.total ? `${su.message} · ${fmt.bytes(su.done)} of ${fmt.bytes(su.total)}` : su.message) : "");
          text(setupErr, su.phase === "error" ? `${su.message}. Press Set up video to continue where it stopped.` : "");
          setupBtn.disabled = busy;
          setupBtn.lastChild.textContent = su.phase === "error" ? "Try again" : busy ? (st.update ? "Updating…" : "Setting up…") : st.update ? "Update" : "Set up video";
          show(`setup:${viaSwarm}`, ...work, setupCard, ...tail);
          return paintJobs(s);
        }
        pausedBox.hidden = !st.paused;
        text(pausedMsg, st.paused || "");
        show("ready", pausedBox, composer, ...tail);
        paintJobs(s);
      },
      focus() { prompt.focus(); },
    };
  },
};
