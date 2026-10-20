// Video: text to video with MiniMax-H3. A job runs on the swarm (prompt encoder layers on the machines
// that hold them, then a GPU machine renders) or, on an NVIDIA machine that's set up, all here.
// Setup downloads a headless ComfyUI and ~44 GB of weights once; each job keeps a diagnostics report.
import { h, text, cls, fmt } from "../dom.js";
import { state } from "../store.js";
import { button, segmented, empty, badge, setBadge } from "../ui.js";
import { startHost, videoStatus, videoSetup, videoSubmit, videoCancel, videoReport, videoUrl,
  encoderStatus, encoderFetch, encoderRemove, encoderTest, videoSwarmStatus, videoSwarmSubmit } from "../engine.js";
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

/** Prompt encoder card: this machine's share of H3's 50 Qwen3-VL layers. Shown on every machine. */
function encoderCard() {
  let enc = null, busyTest = false, testPrompt = "";
  const n = () => enc?.n_layers || 50;
  const bytes = (lo, hi) => (hi - lo) * enc.layer_bytes + (lo === 0 ? enc.embed_bytes : 0);
  const bar = h("div.lbar", { role: "img", "aria-label": "Encoder layers on this machine" });
  const lo = h("input.input.num", { type: "number", min: "0", step: "1", value: "0", "aria-label": "First layer" });
  const last = h("input.input.num", { type: "number", min: "0", step: "1", value: "24", "aria-label": "Last layer" });
  const presets = h("div.row.wrap", { style: { gap: "6px" } },
    ...[["First half", 0, 25], ["Second half", 25, 50], ["All 50", 0, 50]].map(([l, a, b]) =>
      button(`${l} (${a}–${b - 1})`, { size: "sm", variant: "ghost", onclick: () => { lo.value = a; last.value = b - 1; paint(); } })));
  const note = h("div.small.muted"), err = h("div.small.gap-text");
  const dl = button("Download these layers", { variant: "primary", icon: "download", onclick: async () => {
    dl.disabled = true; await encoderFetch(+lo.value, +last.value + 1); paint(); } });
  const prog = h("div.progress", h("i")), progMsg = h("div.small.muted");
  const mine = h("div.col", { style: { gap: "6px" } });
  const tIn = h("input.input", { placeholder: "A red fox runs through fresh snow at dawn.", "aria-label": "Test prompt" });
  tIn.addEventListener("input", () => { testPrompt = tIn.value; });
  const tBtn = button("Test my layers", { icon: "play", tip: "Reads the prompt with the layers on this machine and reports time, memory and the output.",
    onclick: async () => { busyTest = true; paint(); await encoderTest(testPrompt); busyTest = false; paint(); } });
  const result = h("div.small.col", { style: { gap: "2px" } });
  const testRow = h("div.col", { style: { gap: "8px" } }, h("div.row", { style: { gap: "8px" } }, h("div.grow", tIn), tBtn), result);
  for (const el of [lo, last]) el.addEventListener("input", () => paint());
  const el = h("section.card",
    h("div.card-h", h("h2", "Prompt encoder"), h("span.spacer"), h("span.small.faint", "Qwen3-VL-32B · 50 layers")),
    h("div.card-b.col", { style: { gap: "12px" } },
      h("p.small.muted", "H3 reads your prompt with Qwen3-VL's first 50 layers before the video machine draws it. Machines split these layers, so each one downloads only its share. Pick the layers this machine keeps."),
      h("div.lbar-wrap", bar, h("div.lbar-key.small.faint", ...[["srv", "In memory"], ["disk", "Downloaded"], ["load", "Downloading"], ["pick", "Your pick"]].map(([c, l]) => h("span", h(`i.${c}`), l)))),
      mine,
      h("div.row.wrap", { style: { gap: "12px", alignItems: "flex-end" } },
        h("div.field", h("label", "From layer"), lo), h("div.field", h("label", "Through layer"), last), presets),
      note, err, prog, progMsg, h("div.row", h("span.spacer"), dl),
      h("div", { style: { borderTop: "1px solid var(--line-1)" } }), h("b.small", "Test"), testRow,
      h("p.small.faint", "The test runs only this machine's layers. Video jobs chain them with the other machines' layers automatically.")));

  function paint() {
    enc = state.video.encoder;
    if (!enc) return;
    const N = n(), a = +lo.value, b = +last.value + 1, f = enc.fetching && !enc.fetching.error ? enc.fetching : null;
    lo.max = last.max = String(N - 1);
    const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= N;
    const has = i => enc.slices.find(s => s.lo <= i && i < s.hi);
    bar.replaceChildren(...Array.from({ length: N }, (_, i) => {
      const s = has(i);
      const c = s ? (s.loaded ? ".srv" : ".disk") : f && f.lo <= i && i < f.hi ? ".load" : valid && a <= i && i < b ? ".pick" : "";
      return h(`i${c}`, { title: `Layer ${i}` });
    }));
    const mk = JSON.stringify(enc.slices);
    if (mine.dataset.k !== mk) mine.dataset.k = mk, mine.replaceChildren(...enc.slices.map(s => h("div.row", { style: { gap: "8px" } },
      h("b", `Layers ${fmt.layers(s.lo, s.hi)}`), h("span.small.muted", `${fmt.bytes(s.bytes)} · ${s.loaded ? "in memory" : "on disk"}${s.lo === 0 ? " · reads the prompt" : ""}${s.hi === N ? " · makes the final output" : ""}`),
      h("span.spacer"), button("Remove", { size: "sm", variant: "ghost", onclick: () => encoderRemove(s.lo, s.hi) }))));
    let e = "";
    if (!valid) e = `Pick layers from 0 through ${N - 1}, with the last at or after the first.`;
    else if (enc.slices.some(s => s.lo < b && a < s.hi)) e = "This machine already has some of these layers.";
    text(note, valid ? `Layers ${fmt.layers(a, b)}: ${b - a} layers${a === 0 ? " plus the token embedding" : ""}, about ${fmt.bytes(bytes(a, b))} to download and about the same in memory. `
      + `${fmt.bytes(enc.disk_free)} free on disk, ${fmt.gb(enc.mem_budget_gb)} memory budget for models.` : "");
    text(err, e || enc.fetching?.error || "");
    dl.disabled = !!e || !!f;
    prog.hidden = progMsg.hidden = !f;
    if (f) { prog.firstChild.style.width = `${Math.round(100 * f.done / (f.total || 1))}%`; text(progMsg, `Downloading layers ${fmt.layers(f.lo, f.hi)} · ${fmt.bytes(f.done)} of ${fmt.bytes(f.total)}`); }
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
    let shown = null, asked = false, swarmAsked = 0;
    const show = (key, ...els) => { if (shown !== key) { shown = key; page.replaceChildren(...els); } };
    const tick = setInterval(() => paintJobs(state), 1000);

    return {
      unmount() { clearInterval(tick); },
      update(s) {
        if (s.source !== "live" || s.engine.phase !== "running") { asked = encAsked = false; return show("offline", offline); }
        if (!encAsked) { encAsked = true; encoderStatus(); }
        enc.paint();
        if (Date.now() - swarmAsked > 3000) { swarmAsked = Date.now(); videoSwarmStatus(); }
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
          unsupported.replaceChildren(empty({ icon: "video", title: viaSwarm ? "This machine doesn't render, the swarm does" : "No machine or peer can make videos yet",
            body: viaSwarm ? "Videos you make here are rendered by a GPU machine in the swarm. This machine helps by keeping prompt encoder layers (below)."
              : `${cap.reason} ${swarmSt?.reason || ""} This machine can still take part by keeping some prompt encoder layers (below).` }));
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
        show("ready", composer, ...tail);
        paintJobs(s);
      },
      focus() { prompt.focus(); },
    };
  },
};
