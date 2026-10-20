// Video: text to video with MiniMax-H3 on this machine's NVIDIA GPU (release 1: local only).
// Setup downloads a headless ComfyUI and ~44 GB of weights once; each job keeps a diagnostics report.
import { h, text, cls, fmt } from "../dom.js";
import { state } from "../store.js";
import { button, segmented, empty, badge, setBadge } from "../ui.js";
import { startHost, videoStatus, videoSetup, videoSubmit, videoCancel, videoReport, videoUrl } from "../engine.js";
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

let pick = { preset: "draft", seconds: 5, mode: "best" }, draft = "";
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
    const composer = h("section.card",
      h("div.card-h", h("h2", "New video"), h("span.spacer"), h("span.small.faint", "Ctrl+Enter to generate")),
      h("div.card-b.col", { style: { gap: "12px" } }, prompt, ideas,
        h("div.row.wrap", { style: { gap: "12px" } }, h("span.small.muted", "Shape"), presetSeg, h("span.small.muted", "Length"), lenSeg),
        h("div.row.wrap", { style: { gap: "12px" } }, h("span.small.muted", "Quality"), modeSeg, h("span.spacer"), cmpBtn, goBtn),
        warn));
    async function go() {
      if (!draft.trim()) return prompt.focus();
      goBtn.disabled = true;
      const j = await videoSubmit(draft.trim(), pick.preset, pick.seconds, null, pick.mode);
      goBtn.disabled = false;
      if (j) { prompt.value = draft = ""; paintGo(); }
    }
    async function compare() {
      if (!draft.trim()) return prompt.focus();
      const seed = Math.floor(Math.random() * 2 ** 40);
      cmpBtn.disabled = true;
      const a = await videoSubmit(draft.trim(), pick.preset, pick.seconds, seed, "fast");
      if (a) await videoSubmit(draft.trim(), pick.preset, pick.seconds, seed, "best");
      cmpBtn.disabled = false;
    }
    const paintGo = () => { goBtn.disabled = cmpBtn.disabled = !draft.trim(); };
    paintGo();

    // ---- jobs ----
    const jobsBox = h("div.col.video-jobs", { style: { gap: "12px" } });
    const jobEls = new Map();
    function jobEl(j) {
      const b = badge("", "neutral"), bar = h("div.progress", h("i")), detail = h("span.small.muted"), time = h("span.small.faint");
      const media = h("div.video-media"), err = h("div.small.gap-text");
      const cancel = button("Cancel", { size: "sm", onclick: () => videoCancel(j.id) });
      const report = button("Copy report", { size: "sm", icon: "copy", tip: "Diagnostics for this video: timings and memory. Paste it to whoever is helping you.",
        onclick: async () => { const r = await videoReport(j.id); r ? copyText(JSON.stringify(r, null, 2), "Report copied") : copyText(JSON.stringify(state.video.jobs[j.id], null, 2), "Job details copied"); } });
      const el = h("section.card.video-job",
        h("div.card-h", b, h("span.ellipsis.grow.video-title", { title: j.prompt }, j.prompt), time),
        h("div.card-b.col", { style: { gap: "8px" } }, media, bar, h("div.row", detail, h("span.spacer"), h("span.small.faint", `${j.width}×${j.height} · ${j.seconds}s · ${j.mode === "fast" ? "Fast" : "Best"} · seed ${j.seed}`)), err),
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

    const page = h("div.page.video");
    root.append(page);
    let shown = null, asked = false;
    const show = (key, ...els) => { if (shown !== key) { shown = key; page.replaceChildren(...els); } };
    const tick = setInterval(() => paintJobs(state), 1000);

    return {
      unmount() { clearInterval(tick); },
      update(s) {
        if (s.source !== "live" || s.engine.phase !== "running") { asked = false; return show("offline", offline); }
        if (!s.video.status) { if (!asked) { asked = true; videoStatus(); } return show("loading", loading); }
        const st = s.video.status, cap = st.capability;
        const ready = st.installed && st.models_ready;
        if (!cap.ok && !ready) {
          unsupported.replaceChildren(empty({ icon: "video", title: "This machine can't make videos yet", body: cap.reason }));
          return show(`unsupported:${cap.reason}`, unsupported);
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
          return show("setup", setupCard);
        }
        if (!presetSeg.firstChild) presetSeg.append(segmented(Object.entries(st.presets).map(([k, p]) => ({ value: k, label: p.label, tip: `${p.width}×${p.height}` })), pick.preset, v => { pick.preset = v; }, "Shape"));
        if (!modeSeg.firstChild) modeSeg.append(segmented(Object.entries(st.modes || { best: { label: "Best" } }).map(([k, m]) => ({ value: k, label: m.label, tip: `${m.steps} steps` })), pick.mode, v => { pick.mode = v; }, "Quality"));
        text(warn, [cap.warn, "Draft is fastest (minutes). HD on a 12 GB GPU can take an hour or more. Best is sharper; Fast takes about half the time."].filter(Boolean).join(" "));
        show("ready", composer, jobsBox);
        paintJobs(s);
      },
      focus() { prompt.focus(); },
    };
  },
};
