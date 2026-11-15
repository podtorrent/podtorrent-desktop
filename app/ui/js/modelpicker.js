// The model table from onboarding, shared with the Models view: model families on the left, a filter
// (that also searches Hugging Face) and precision on top, then one row per model with its size and how
// much of it fits this machine. The caller says what fits, what's selected and what a pick does.
import { h, fmt } from "./dom.js";
import { icon } from "./icons.js";
import { segmented } from "./ui.js";
import { catalogSearch, catalogInfo } from "./engine.js";

export const GB = 2 ** 30;
const SUPPORTED = new Set(["qwen3_moe", "qwen3_5_moe"]);   // architectures the peer can split (peer.py SUPPORTED)
// Curated MLX models. Runnable ones carry layers and size (from each repo's index); the rest are
// listed so people see what's coming, but can't be picked until the peer runs their architecture.
const run = (id, name, family, quant, layers, gb, tag) => ({ repo: `mlx-community/${id}`, name, family, quant, layers, bytes: gb * 1e9, tag });
const soon = (id, name, family, quant, arch) => ({ repo: `mlx-community/${id}`, name, family, quant, arch, soon: true });
export const MODELS = [
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
export const perLayer = m => m.bytes / m.layers / GB;

/** GB of memory this machine can give to layers, from system health: with an NVIDIA GPU its memory
 *  less ~1.5 GB CUDA overhead; otherwise about 75% of RAM less 2 GB (what macOS lets the GPU use).
 *  Less ~1 GB for the requester's head. Null when unknown. */
export function roomFor(hl) {
  const mem = hl?.mem_total_gb, gpuMem = hl?.gpu?.mem_total_gb;
  return gpuMem ? gpuMem - 2.5 : mem ? mem * 0.75 - 3 : null;
}

/**
 * o.fit(m) → { n, label, ok, warn }: layers of m this machine would hold, the "On this machine" text,
 *   whether m can be picked, and whether the label is a warning.
 * o.selected(m), o.pick(m): the selected row and what a click does.
 * o.tags(m): extra tags after the name. o.tail(): rows after the list when not filtering.
 * o.checked(m): a Hugging Face result turned out runnable. o.rows: height of the list, in rows.
 */
export function modelPicker(o) {
  let group = "all", quant = "any", query = "";
  const extra = [];   // models picked from a Hugging Face search, once checked
  const hf = { status: "", results: [], timer: 0, seq: 0 };
  const all = () => MODELS.concat(extra);

  const rail = h("nav.onb-rail", { "aria-label": "Model families" });
  const search = h("input.input", { type: "search", placeholder: "Filter, or search Hugging Face", "aria-label": "Find a model", spellcheck: "false",
    oninput: e => { query = e.target.value; paint(); searchHF(); } });
  const prec = segmented([{ value: "any", label: "Any" }, { value: "4", label: "4-bit" }, { value: "8", label: "8-bit" }], quant, v => { quant = v; paint(); }, "Precision");
  const rows = h("div.onb-rows", { role: "radiogroup", "aria-label": "Model" });
  if (o.rows) rows.style.maxHeight = `${o.rows * 40}px`;
  const el = h("div.onb-picker", rail,
    h("div.onb-table",
      h("div.onb-tools", h("span.onb-search", icon("search"), search), prec),
      h("div.onb-thead.small", h("span", "Model"), h("span", "Size"), h("span", "On this machine")),
      rows,
      h("div.onb-hint.small.faint", "Not listed? Type a name to search every MLX model on Hugging Face. Qwen3 MoE models run today; more architectures are coming.")));

  const row = m => {
    if (m.soon || m.error || m.checking) return h("button.onb-tr", { type: "button", disabled: true, title: m.arch ? `${m.arch} models don't run on PodTorrent yet` : "" },
      h("span.onb-c-name", h("b", m.name), h("span.small.faint", bits(m))),
      h("span.onb-c-num.small", m.bytes ? fmt.gb(m.bytes / GB) : "–"),
      h("span.onb-c-fit.small", m.checking ? "Checking…" : m.error ? "Couldn't read it" : h("span.onb-tag", "Coming soon")));
    const f = o.fit(m), sel = !!o.selected?.(m);
    return h(`button.onb-tr${sel ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(sel), disabled: !f.ok, onclick: () => o.pick(m) },
      h("span.onb-c-name", h("b", m.name), h("span.small.faint", bits(m)), m.tag ? h("span.onb-tag", m.tag) : null, ...(o.tags?.(m) || [])),
      h("span.onb-c-num.small", m.bytes ? fmt.gb(m.bytes / GB) : "–"),
      h("span.onb-c-fit.small", h("span.onb-meter", h("i", { style: { width: `${Math.round(100 * Math.min(f.n, m.layers) / m.layers)}%` } })),
        h("span", { class: f.warn ? "warn" : "" }, f.label)));
  };

  function paint() {
    const q = query.trim().toLowerCase();
    const visible = all().filter(m => (group === "all" || m.family === group) && (quant === "any" || m.quant === +quant)
      && (!q || `${m.name} ${m.repo}`.toLowerCase().includes(q))).sort((a, b) => !!a.soon - !!b.soon);
    rail.replaceChildren(...GROUPS.filter(([id]) => id !== "hf" || extra.length).map(([id, label]) =>
      h(`button.onb-rail-i${group === id ? ".on" : ""}`, { type: "button", onclick: () => { group = id; paint(); } },
        h("span.grow", label), h("span.faint", String(all().filter(m => id === "all" || m.family === id).length)))));
    // Hugging Face results not checked yet: picking one reads its config to see whether it runs here.
    const hfRows = q.length < 2 ? [] : hf.results.filter(r => !all().some(m => m.repo === r.repo)).map(r =>
      h("button.onb-tr", { type: "button", onclick: () => checkHF(r.repo) },
        h("span.onb-c-name", h("b", r.repo.split("/")[1]), h("span.small.faint", r.repo.split("/")[0])),
        h("span.onb-c-num.small.faint", `${fmt.compact(r.downloads)} ↓`),
        h("span.onb-c-fit.small.faint", "Select to check")));
    rows.replaceChildren(...visible.map(row),
      ...[visible.length || q.length >= 2 ? null : h("div.small.faint.onb-emptyrow", "No model matches."),
        q.length >= 2 ? h("div.onb-sec.small", "On Hugging Face", h("span.faint", hf.status)) : null, ...hfRows,
        ...(q ? [] : o.tail?.() || [])].filter(Boolean));
  }
  function searchHF() {
    clearTimeout(hf.timer);
    const q = query.trim();
    if (q.length < 2) { hf.results = []; hf.status = ""; return; }
    hf.timer = setTimeout(async () => {
      const my = ++hf.seq;
      hf.status = "Searching…"; paint();
      const r = await catalogSearch(q);
      if (my !== hf.seq) return;
      hf.results = (r.results || []).slice(0, 8);
      hf.status = r.error || (hf.results.length ? "" : "No MLX models match");
      paint();
    }, 400);
  }
  /** Read a searched model's config: runnable architectures become pickable, others show as coming. */
  async function checkHF(repo) {
    const m = { repo, name: repo.split("/")[1], family: "hf", quant: +(/(\d)bit/i.exec(repo)?.[1]) || "", checking: true };
    extra.push(m); paint();
    const inf = await catalogInfo(repo);
    delete m.checking;
    if (inf.error) m.error = inf.error;
    else if (!SUPPORTED.has(inf.model_type)) Object.assign(m, { soon: true, arch: inf.model_type || "unknown" });
    else { Object.assign(m, { layers: inf.n_layers, bytes: inf.size_bytes || 0 }); o.checked?.(m); }
    paint();
  }
  paint();
  return { el, paint, all, search };
}
