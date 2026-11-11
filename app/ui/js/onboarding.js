// First-run welcome: this machine → how it runs (public, private pod, alone) → which model → start.
// One chain diagram stays on top and redraws at every step, so the layer split explains itself.
// Choices wait in settings.pendingPod / pendingServe and apply once the peer is up (engine.js).
// Skippable; replay from Help or Settings.
import { h, text, fmt } from "./dom.js";
import { state, settings, setSetting, on, models } from "./store.js";
import { icon } from "./icons.js";
import { button, segmented, toast } from "./ui.js";
import { go, setDemo } from "./actions.js";
import { startHost, catalogSearch, catalogInfo } from "./engine.js";
import { invoke, isTauri } from "./native.js";

const GB = 2 ** 30;
const SUPPORTED = new Set(["qwen3_moe"]);   // architectures the peer can split (peer.py SUPPORTED)
// Curated MLX models. Runnable ones carry layers and size (from each repo's index); the rest are
// listed so people see what's coming, but can't be picked until the peer runs their architecture.
const run = (id, name, family, quant, layers, gb, tag) => ({ repo: `mlx-community/${id}`, name, family, quant, layers, bytes: gb * 1e9, tag });
const soon = (id, name, family, quant, arch) => ({ repo: `mlx-community/${id}`, name, family, quant, arch, soon: true });
const MODELS = [
  run("Qwen3-30B-A3B-4bit", "Qwen3 30B A3B", "qwen", 4, 48, 17.17, "Default"),
  run("Qwen3-30B-A3B-6bit", "Qwen3 30B A3B", "qwen", 6, 48, 24.81),
  run("Qwen3-30B-A3B-8bit", "Qwen3 30B A3B", "qwen", 8, 48, 32.44),
  run("Qwen3-30B-A3B-Instruct-2507-4bit", "Qwen3 30B A3B Instruct 2507", "qwen", 4, 48, 17.18),
  run("Qwen3-30B-A3B-Instruct-2507-8bit", "Qwen3 30B A3B Instruct 2507", "qwen", 8, 48, 32.44),
  run("Qwen3-30B-A3B-Thinking-2507-4bit", "Qwen3 30B A3B Thinking 2507", "qwen", 4, 48, 17.18),
  run("Qwen3-Coder-30B-A3B-Instruct-4bit", "Qwen3 Coder 30B A3B", "qwen", 4, 48, 17.18),
  run("Qwen3-Coder-30B-A3B-Instruct-6bit", "Qwen3 Coder 30B A3B", "qwen", 6, 48, 24.81),
  run("Qwen3-Coder-30B-A3B-Instruct-8bit", "Qwen3 Coder 30B A3B", "qwen", 8, 48, 32.44),
  run("Qwen3-235B-A22B-3bit", "Qwen3 235B A22B", "qwen", 3, 94, 102.85),
  run("Qwen3-235B-A22B-4bit", "Qwen3 235B A22B", "qwen", 4, 94, 132.24),
  run("Qwen3-235B-A22B-8bit", "Qwen3 235B A22B", "qwen", 8, 94, 249.79),
  run("Qwen3-235B-A22B-Instruct-2507-4bit", "Qwen3 235B A22B Instruct 2507", "qwen", 4, 94, 132.24),
  run("Qwen3-235B-A22B-Thinking-2507-4bit", "Qwen3 235B A22B Thinking 2507", "qwen", 4, 94, 132.24),
  run("Qwen3-Coder-480B-A35B-Instruct-4bit", "Qwen3 Coder 480B A35B", "qwen", 4, 62, 270.09),
  soon("Qwen3-Next-80B-A3B-Instruct-4bit", "Qwen3 Next 80B A3B", "qwen", 4, "qwen3_next"),
  soon("Qwen3-32B-4bit", "Qwen3 32B", "qwen", 4, "qwen3"),
  soon("Qwen3-14B-4bit", "Qwen3 14B", "qwen", 4, "qwen3"),
  soon("Qwen3-8B-4bit", "Qwen3 8B", "qwen", 4, "qwen3"),
  soon("Qwen3-4B-4bit", "Qwen3 4B", "qwen", 4, "qwen3"),
  soon("Llama-3.3-70B-Instruct-4bit", "Llama 3.3 70B Instruct", "llama", 4, "llama"),
  soon("Meta-Llama-3.1-8B-Instruct-4bit", "Llama 3.1 8B Instruct", "llama", 4, "llama"),
  soon("Llama-3.2-3B-Instruct-4bit", "Llama 3.2 3B Instruct", "llama", 4, "llama"),
  soon("Llama-3.2-1B-Instruct-4bit", "Llama 3.2 1B Instruct", "llama", 4, "llama"),
  soon("gpt-oss-120b-MXFP4-Q8", "gpt-oss 120B", "gptoss", "MXFP4", "gpt_oss"),
  soon("gpt-oss-20b-MXFP4-Q8", "gpt-oss 20B", "gptoss", "MXFP4", "gpt_oss"),
  soon("DeepSeek-V3.1-4bit", "DeepSeek V3.1", "deepseek", 4, "deepseek_v3"),
  soon("DeepSeek-R1-Distill-Qwen-7B-4bit", "DeepSeek R1 Distill Qwen 7B", "deepseek", 4, "qwen2"),
  soon("Kimi-K2-Instruct-4bit", "Kimi K2 Instruct", "kimi", 4, "kimi_k2"),
  soon("GLM-4.6-4bit", "GLM 4.6", "glm", 4, "glm4_moe"),
  soon("GLM-4.5-Air-4bit", "GLM 4.5 Air", "glm", 4, "glm4_moe"),
  soon("gemma-3-27b-it-4bit", "Gemma 3 27B", "gemma", 4, "gemma3"),
  soon("gemma-3-12b-it-4bit", "Gemma 3 12B", "gemma", 4, "gemma3"),
  soon("gemma-3-4b-it-4bit", "Gemma 3 4B", "gemma", 4, "gemma3"),
  soon("Mistral-Small-3.2-24B-Instruct-2506-4bit", "Mistral Small 3.2 24B", "mistral", 4, "mistral3"),
  soon("Devstral-Small-2507-4bit", "Devstral Small 24B", "mistral", 4, "mistral"),
  soon("Phi-4-mini-instruct-4bit", "Phi 4 mini", "phi", 4, "phi3"),
];
const GROUPS = [["all", "All"], ["qwen", "Qwen"], ["llama", "Llama"], ["gptoss", "gpt-oss"], ["deepseek", "DeepSeek"],
  ["kimi", "Kimi"], ["glm", "GLM"], ["gemma", "Gemma"], ["mistral", "Mistral"], ["phi", "Phi"], ["hf", "From Hugging Face"]];
const bits = m => typeof m.quant === "number" ? `${m.quant}-bit` : m.quant || "";
const MODES = {
  public: { icon: "swarm", t: "With anyone", d: "The matchmaker pairs it with machines that have the same model." },
  private: { icon: "peers", t: "In my pod", d: "Only machines you invite, with a code." },
  alone: { icon: "node", t: "Just this machine", d: "Holds the whole model and links to no other machine." },
};
const CELLS = 24;

/** Big device outline: a laptop when the machine reports a battery, a desktop otherwise. */
function deviceArt() {
  const laptop = state.health?.battery_pct != null;
  const svg = laptop
    ? '<rect x="9" y="6" width="46" height="31" rx="3"/><path d="M4 42h56l-3 5H7z"/><path d="M28 44.5h8"/>'
    : '<rect x="6" y="5" width="52" height="34" rx="3"/><path d="M26 39l-2 8h16l-2-8M20 47h24"/>';
  const el = h("div.onb-device");
  el.innerHTML = `<svg viewBox="0 0 64 52" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${svg}</svg>`;
  return el;
}

/** The layer chain: CELLS cells coloured by who holds them, with a label under each run. */
function chain() {
  const cells = Array.from({ length: CELLS }, (_, i) => h("i", { style: { transitionDelay: `${i * 12}ms` } }));
  const labels = h("div.oc-labels");
  const el = h("div.onb-art", h("div.oc-bar", { role: "img" }, cells), labels);
  return {
    el,
    /** segs: [{ n, kind: "me" | "peer" | "open", label }] covering CELLS. */
    set(segs, aria) {
      let i = 0;
      for (const s of segs) for (let k = 0; k < s.n && i < CELLS; k++) cells[i++].className = s.kind;
      while (i < CELLS) cells[i++].className = "open";
      el.firstChild.setAttribute("aria-label", aria);
      labels.replaceChildren(...segs.filter(s => s.n).map(s => h(`span.${s.kind}`, { style: { flexGrow: s.n } }, h("b"), h("em", s.label))));
    },
  };
}

export function initOnboarding() {
  on("onboarding", () => openOnboarding());
  if (!settings.onboarded) setTimeout(openOnboarding, 350);
}

export function openOnboarding() {
  const hl = state.health || {};
  const mem = hl.mem_total_gb, gpuMem = hl.gpu?.mem_total_gb;
  // Room for layers: with an NVIDIA GPU its memory less ~1.5 GB CUDA overhead; otherwise about 75% of
  // RAM less 2 GB (what macOS lets the GPU use). Less ~1 GB for the requester's head.
  const room = gpuMem ? gpuMem - 2.5 : mem ? mem * 0.75 - 3 : null;
  const perLayer = m => m.bytes / m.layers / GB;
  const fitLayers = m => !m.bytes ? m.layers : room == null ? m.layers : Math.max(0, Math.min(m.layers, Math.floor(room / perLayer(m))));
  const fitsWhole = m => fitLayers(m) >= m.layers;
  let freeDisk = null;

  // Restore earlier choices when onboarding is replayed.
  const pp = settings.pendingPod, ps = settings.pendingServe;
  let step = 0, name = settings.peerName || "";
  let mode = pp?.code ? "private" : pp?.kind || "public";
  let podAct = pp?.code ? "join" : "create";
  let podName = pp?.kind === "private" ? pp.name : "", code = pp?.code || "";
  let pick = ps === null && settings.onboarded ? null : MODELS.find(m => m.repo === ps?.model)?.repo || MODELS[0].repo;
  let group = "all", quant = "any", query = "";
  const extra = [];   // models picked from a Hugging Face search, once checked
  const hf = { status: "", results: [], timer: 0, seq: 0 };
  const all = () => MODELS.concat(extra);
  const model = () => all().find(m => m.repo === pick);
  const joining = () => mode === "private" && podAct === "join";
  const steps = () => joining() ? [0, 1, 3] : [0, 1, 2, 3];
  /** Layers this machine would hold of `m` in the current mode. */
  const share = m => !m ? 0 : mode === "alone" ? m.layers : room == null ? Math.ceil(m.layers / 2) : fitLayers(m);
  const usable = m => !!m.layers && !m.soon && (mode === "alone" ? fitsWhole(m) : fitLayers(m) > 0);

  const scrim = h("div.scrim.onb-scrim");
  const card = h("div.onb.card", { role: "dialog", "aria-modal": "true", "aria-label": "Welcome to PodTorrent" });
  const ch = chain();
  const body = h("div.onb-body"), foot = h("div.onb-f");
  card.append(ch.el, body, foot);
  document.body.append(scrim, card);
  requestAnimationFrame(() => { scrim.classList.add("show"); card.classList.add("show"); });
  if (isTauri) invoke("data_location").then(l => { freeDisk = l.free_gb; if (step === 2) render(); }).catch(() => {});

  const me = () => name.trim() || "This machine";
  function paintChain() {
    const m = model(), n = m ? m.layers : 48;
    const mine = step === 0 ? 10 : mode === "alone" ? CELLS : joining() ? 8
      : !m ? 0 : Math.max(1, Math.min(CELLS * 2 / 3, Math.round(CELLS * share(m) / n)));   // leave room to show the others
    const rest = CELLS - mine;
    const segs = step === 0 ? [{ n: mine, kind: "me", label: me() }, { n: rest, kind: "open", label: "Other machines" }]
      : mode === "alone" ? [{ n: CELLS, kind: "me", label: `${me()} · every layer` }]
      : joining() ? [{ n: 8, kind: "peer", label: "Pod owner" }, { n: 8, kind: "me", label: me() }, { n: 8, kind: "open", label: "Other members" }]
      : !m ? [{ n: 0, kind: "me", label: me() }, { n: CELLS, kind: "open", label: "Machines in the swarm serve the model; you chat" }]
      : [{ n: mine, kind: "me", label: `${me()} · ${share(m) >= n ? "up to every layer" : `about ${share(m)} of ${n} layers`}` },
        { n: rest, kind: "open", label: mode === "private" ? "Machines you invite" : "Machines the matchmaker finds" }];
    ch.set(segs, segs.map(s => s.label).join(", "));
  }

  const save = () => {
    setSetting("peerName", name.trim().slice(0, 40));
    const m = model();
    setSetting("pendingPod", mode === "alone" ? { kind: "alone", name: "solo" }
      : mode === "private" ? (podAct === "join" ? { code: code.trim() } : { kind: "private", name: podName.trim() || `${me()} pod` })
      : null);
    // Alone serves every layer; otherwise the node sizes the slice to free memory and the swarm's gaps.
    setSetting("pendingServe", joining() || !m ? null : mode === "alone" ? { model: m.repo, lo: 0, hi: m.layers } : { model: m.repo, auto: true });
  };
  const finish = (to = "swarm") => {
    setSetting("onboarded", true);
    scrim.classList.remove("show"); card.classList.remove("show");
    setTimeout(() => { scrim.remove(); card.remove(); }, 300);
    document.removeEventListener("keydown", key, true);
    go(to);
  };
  const key = e => { if (e.key === "Escape") { e.preventDefault(); finish(); } };
  document.addEventListener("keydown", key, true);

  // ---- 0: this machine ----
  function machinePage() {
    const input = h("input.onb-name", { value: name, placeholder: "Name this machine", maxlength: "40", spellcheck: "false", "aria-label": "Name for this machine",
      oninput: e => { name = e.target.value; paintChain(); } });
    const facts = [hl.chip, mem ? `${fmt.gb(mem)} memory` : null, gpuMem ? `${fmt.gb(gpuMem)} GPU` : null, hl.os].filter(Boolean);
    return [
      h("div.onb-machine", deviceArt(), h("div.grow",
        input,
        h("div.small.faint", facts.length ? facts.join(" · ") : "Other machines see this name"))),
      h("p", "Models are split into layers and each machine serves a slice, so a few machines together can run a model too big for any one of them."),
    ];
  }

  // ---- 1: how it runs ----
  function modePage() {
    const opt = id => {
      const o = MODES[id], on = mode === id;
      const extra = on && id === "private" ? podControls() : null;
      return h(`div.onb-mode${on ? ".on" : ""}`,
        h("button.onb-mode-h", { type: "button", role: "radio", "aria-checked": String(on), onclick: () => { if (mode !== id) { mode = id; render(); } } },
          h("span.onb-mode-ic", icon(o.icon)), h("span.grow", h("b", o.t), h("span.small.muted", o.d)), h("span.onb-radio")),
        extra);
    };
    return [
      h("h1", "How should it run?"),
      h("div.onb-modes", { role: "radiogroup", "aria-label": "How this machine runs" }, ...Object.keys(MODES).map(opt)),
      h("div.small.faint", "A machine is in one pod at a time. Change it any time from Pod."),
    ];
  }
  function podControls() {
    const field = podAct === "create"
      ? h("input.input", { value: podName, placeholder: `${me()} pod`, maxlength: "64", "aria-label": "Pod name", oninput: e => { podName = e.target.value; } })
      : h("input.input.mono", { value: code, placeholder: "pod1-…", spellcheck: "false", autocomplete: "off", "aria-label": "Invite code",
        oninput: e => { code = e.target.value; hint(); syncNext(); } });
    const tip = h("div.small.faint");
    const hint = () => text(tip, podAct === "create" ? "After you start, invite machines from Pod. Each code works once."
      : code.trim() && !code.trim().startsWith("pod1-") ? "Invite codes start with pod1-." : "The owner's machine must be online. The owner picks which layers this machine serves.");
    hint();
    return h("div.onb-pod",
      segmented([{ value: "create", label: "Create a pod" }, { value: "join", label: "Join with a code" }], podAct, v => { podAct = v; render(); }, "Pod"),
      field, tip);
  }

  // ---- 2: which model (B's table: groups on the left, filters on top) ----
  function modelPage() {
    const swarm = new Map(models(state).map(m => [m.model, m]));
    const inGroup = m => group === "all" || m.family === group;
    const q = query.trim().toLowerCase();
    const visible = all().filter(m => inGroup(m) && (quant === "any" || m.quant === +quant)
      && (!q || `${m.name} ${m.repo}`.toLowerCase().includes(q))).sort((a, b) => !!a.soon - !!b.soon);
    const rail = h("nav.onb-rail", { "aria-label": "Model families" }, ...GROUPS.filter(([id]) => id !== "hf" || extra.length).map(([id, label]) =>
      h(`button.onb-rail-i${group === id ? ".on" : ""}`, { type: "button", onclick: () => { group = id; render(); } },
        h("span.grow", label), h("span.faint", String(all().filter(m => id === "all" || m.family === id).length)))));
    const search = h("input.input", { type: "search", value: query, placeholder: "Filter, or search Hugging Face", "aria-label": "Find a model", spellcheck: "false",
      oninput: e => { query = e.target.value; render(); searchHF(); } });
    const row = m => {
      if (m.soon || m.error || m.checking) return h("button.onb-tr", { type: "button", disabled: true, title: m.arch ? `${m.arch} models don't run on PodTorrent yet` : "" },
        h("span.onb-c-name", h("b", m.name), h("span.small.faint", bits(m))),
        h("span.onb-c-num.small", m.bytes ? fmt.gb(m.bytes / GB) : "–"),
        h("span.onb-c-fit.small", m.checking ? "Checking…" : m.error ? "Couldn't read it" : h("span.onb-tag", "Coming soon")));
      const ok = usable(m), sel = pick === m.repo, n = share(m), dl = n * perLayer(m), sw = swarm.get(m.repo);
      const here = room == null || !m.bytes ? "–" : mode === "alone" ? (ok ? "Whole model" : `Needs ${fmt.gb(m.bytes / GB + 3)}`)
        : n >= m.layers ? "Whole model" : n ? `${n} of ${m.layers} layers` : "Too big";
      const noDisk = freeDisk != null && ok && m.bytes && dl > freeDisk;
      return h(`button.onb-tr${sel ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(sel), disabled: !ok,
        onclick: () => { pick = m.repo; render(); } },
        h("span.onb-c-name", h("b", m.name), h("span.small.faint", bits(m)), m.tag ? h("span.onb-tag", m.tag) : null,
          sw?.runnable ? h("span.onb-tag.live", "In swarm") : null),
        h("span.onb-c-num.small", m.bytes ? fmt.gb(m.bytes / GB) : "–"),
        h("span.onb-c-fit.small", h("span.onb-meter", h("i", { style: { width: `${Math.round(100 * Math.min(n, m.layers) / m.layers)}%` } })),
          h("span", { class: noDisk ? "warn" : "" }, noDisk ? "Not enough disk" : here)));
    };
    // Hugging Face results not checked yet: picking one reads its config to see whether it runs here.
    const hfRows = q.length < 2 ? [] : hf.results.filter(r => !all().some(m => m.repo === r.repo)).map(r =>
      h("button.onb-tr", { type: "button", onclick: () => checkHF(r.repo) },
        h("span.onb-c-name", h("b", r.repo.split("/")[1]), h("span.small.faint", r.repo.split("/")[0])),
        h("span.onb-c-num.small.faint", `${fmt.compact(r.downloads)} ↓`),
        h("span.onb-c-fit.small.faint", "Select to check")));
    const none = h(`button.onb-tr.none${pick === null ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(pick === null), onclick: () => { pick = null; render(); } },
      h("span.onb-c-name", h("b", "Nothing for now"), h("span.small.faint", "Chat with what the swarm serves")));
    const m = model();
    const facts = [mem ? `${fmt.gb(mem)} memory, about ${fmt.gb(Math.max(0, room))} for layers` : null,
      freeDisk != null ? `${fmt.gb(freeDisk)} free on disk` : null].filter(Boolean);
    return [
      h("div.onb-h2", h("h1", "Pick a model"), h("span.small.muted", mode === "alone" ? "It has to fit whole in memory." : "You download only your share of the layers.")),
      h("div.onb-picker", rail,
        h("div.onb-table",
          h("div.onb-tools", h("span.onb-search", icon("search"), search),
            segmented([{ value: "any", label: "Any" }, { value: "4", label: "4-bit" }, { value: "8", label: "8-bit" }], quant, v => { quant = v; render(); }, "Precision")),
          h("div.onb-thead.small", h("span", "Model"), h("span", "Size"), h("span", "On this machine")),
          h("div.onb-rows", { role: "radiogroup", "aria-label": "Model" }, ...visible.map(row),
            visible.length || q.length >= 2 ? null : h("div.small.faint.onb-emptyrow", "No model matches."),
            q.length >= 2 ? h("div.onb-sec.small", "On Hugging Face", h("span.faint", hf.status)) : null, ...hfRows,
            mode === "alone" || q ? null : none),
          h("div.onb-hint.small.faint", "Not listed? Type a name to search every MLX model on Hugging Face. Qwen3 MoE models run today; more architectures are coming."))),
      h("div.onb-facts.small.faint", facts.join(" · "), isTauri ? h("button.onb-link", { type: "button", onclick: changeDisk }, "Change drive") : null,
        m?.bytes && mode !== "alone" ? h("span.grow.right", `Downloads about ${fmt.gb(share(m) * perLayer(m))}`) : null),
    ];
  }
  function searchHF() {
    clearTimeout(hf.timer);
    const q = query.trim();
    if (q.length < 2) { hf.results = []; hf.status = ""; return; }
    hf.timer = setTimeout(async () => {
      const my = ++hf.seq;
      hf.status = "Searching…"; render();
      const r = await catalogSearch(q);
      if (my !== hf.seq || step !== 2) return;
      hf.results = (r.results || []).slice(0, 8);
      hf.status = r.error || (hf.results.length ? "" : "No MLX models match");
      render();
    }, 400);
  }
  /** Read a searched model's config: runnable architectures become pickable, others show as coming. */
  async function checkHF(repo) {
    const m = { repo, name: repo.split("/")[1], family: "hf", quant: +(/(\d)bit/i.exec(repo)?.[1]) || "", checking: true };
    extra.push(m); render();
    const inf = await catalogInfo(repo);
    delete m.checking;
    if (inf.error) m.error = inf.error;
    else if (!SUPPORTED.has(inf.model_type)) Object.assign(m, { soon: true, arch: inf.model_type || "unknown" });
    else { Object.assign(m, { layers: inf.n_layers, bytes: inf.size_bytes || 0 }); pick = repo; }
    if (step === 2) render();
  }
  async function changeDisk() {
    if (state.engine.phase === "running" || state.engine.phase === "starting") return toast("Stop your node first", "degraded", "The storage folder can only change while the node is stopped.");
    const p = await invoke("pick_folder").catch(() => null);
    if (!p) return;
    try { freeDisk = (await invoke("set_data_location", { path: p })).free_gb; render(); }
    catch (e) { toast("Couldn't use that folder", "degraded", String(e)); }
  }

  // ---- 3: start ----
  function startPage() {
    const m = model();
    const what = joining() ? "joins the pod. The owner picks which layers it serves."
      : !m ? "joins the swarm without serving. You can chat with any model it covers."
      : mode === "alone" ? `serves all of ${m.name} by itself.`
      : `serves about ${share(m) >= m.layers ? "every layer" : `${share(m)} of ${m.layers} layers`} of ${m.name}${mode === "private" ? " in your pod" : ", matched with other machines"}.`;
    const next = joining() ? "Starts joining as soon as the node is up."
      : mode === "private" ? "Next, invite your other machines from Pod with a one-time code."
      : m && mode !== "alone" ? "Downloads in the background. Chat works while it does." : null;
    return [
      h("h1", "Ready"),
      h("p", h("b", me()), " ", what),
      next ? h("div.onb-next.small", icon("arrowright"), next) : null,
      h("div.onb-actions",
        button("Start My Node", { variant: "primary", size: "xl", icon: "play", onclick: () => { save(); finish(mode === "private" ? "pod" : m ? "models" : "swarm"); startHost(); } }),
        button("Explore Demo first", { size: "xl", icon: "sparkle", onclick: () => { save(); finish("swarm"); setDemo(true); } })),
    ];
  }

  let next = null;
  const syncNext = () => { if (next) next.disabled = joining() && step === 1 && !code.trim().startsWith("pod1-"); };
  function move(d) {
    const s = steps(), i = s.indexOf(step);
    step = s[Math.max(0, Math.min(s.length - 1, i + d))];
    if (step === 2 && pick && !usable(model())) pick = MODELS.find(usable)?.repo || null;
    render();
  }
  function render() {
    const s = steps();
    card.classList.toggle("wide", step === 2);
    const typing = document.activeElement?.type === "search" && card.contains(document.activeElement) ? document.activeElement.selectionStart : null;
    body.replaceChildren(...[machinePage, modePage, modelPage, startPage][step]().filter(Boolean));
    if (typing != null) { const s = body.querySelector("input[type=search]"); s?.focus(); s?.setSelectionRange(typing, typing); }
    next = step < 3 ? button("Continue", { variant: "primary", onclick: () => { save(); move(1); } }) : null;
    foot.replaceChildren(
      h("div.onb-dots", s.map(x => h(`i${x === step ? ".on" : ""}`))), h("span.spacer"),
      button("Skip", { variant: "ghost", onclick: () => finish() }),
      ...[step > 0 ? button("Back", { onclick: () => move(-1) }) : null, next].filter(Boolean));
    syncNext();
    paintChain();
    if (step !== 2) (body.querySelector("input") || foot.querySelector(".btn.primary") || body.querySelector(".btn.primary"))?.focus();
  }
  render();
}
