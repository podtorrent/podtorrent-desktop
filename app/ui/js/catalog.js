// Model catalog for the Models view: search MLX models on Hugging Face, see what this Mac already
// holds, and get a model ("Download & serve" with a slice sized to free memory and the swarm's
// gaps). Each result says whether it's on this Mac and whether the swarm already serves it.
import { h, text, fmt } from "./dom.js";
import { state, models, shortModel } from "./store.js";
import { actions } from "./actions.js";

const GB = 2 ** 30;
import { button, badge, armedButton, sheet } from "./ui.js";
import { icon } from "./icons.js";
import { serveSlice, catalogSearch, catalogInfo, catalogLocal, catalogDelete } from "./engine.js";

let local = [];          // this Mac's model folders, from /api/catalog/local
let onLocal = () => {};  // re-render hook set by the section
export const localModels = () => local;
export async function refreshLocal() { local = await catalogLocal(); onLocal(); }

const rangesText = rs => rs.map(([a, b]) => fmt.layers(a, b)).join(", ");
const localOf = repo => local.find(m => m.repo === repo);
const swarmOf = repo => models(state).find(m => m.model === repo);

/** One cell per layer: serving here, on disk, or absent. */
function layerBar(n, onDisk, serving) {
  if (!n) return null;
  const inR = (rs, i) => rs.some(([a, b]) => a <= i && i < b);
  return h("div.lbar-wrap",
    h("div.lbar", { role: "img", "aria-label": `${n} layers` },
      ...Array.from({ length: n }, (_, i) => h(`i${inR(serving, i) ? ".srv" : inR(onDisk, i) ? ".disk" : ""}`))),
    h("div.lbar-key.small.faint", h("span", h("i.srv"), "Serving"), h("span", h("i.disk"), "Downloaded"), h("span", h("i"), "Not here")));
}

/** Section heading: icon, title, live count on the right. */
export function secHead(ic, title, extra) {
  return h("div.sec-h", h("span.sec-ic", icon(ic)), h("h2", title), h("span.spacer"), extra || null);
}

/** Badges for a repo: on this Mac (complete / partial) and in the swarm (available / partial). */
function statusBadges(repo) {
  const l = localOf(repo), m = swarmOf(repo), out = [];
  if (l?.complete) out.push(badge("Downloaded", "serving", { dot: true }));
  else if (l?.layers.length) out.push(badge(`On this machine · ${rangesText(l.layers)}`, "you", { dot: true }));
  if (m?.runnable || m?.state === "available") out.push(badge("Available in swarm", "serving"));
  else if (m && m.state !== "offline") out.push(badge(`Swarm missing ${m.gaps.map(([a, b]) => fmt.layers(a, b)).join(", ")}`, "degraded"));
  return out;
}

/** Node stopped: size and whether it fits this machine's memory; downloading needs the node. */
function offlineInfo(inf, body, go, s) {
  const N = inf.n_layers, mem = inf.mem_total_gb, lb = inf.layer_bytes;
  const fit = lb && mem ? Math.min(N, Math.floor(mem * GB * 0.9 / lb)) : null;
  const fits = fit == null ? (inf.size_bytes ? "" : "Size unknown until download (single-file model).")
    : fit >= N ? `All ${N} layers fit in this machine's ${fmt.gb(mem)} memory.`
    : fit > 0 ? `About ${fit} of ${N} layers fit in this machine's ${fmt.gb(mem)} memory; the swarm serves the rest.`
    : `Not even one layer fits in this machine's ${fmt.gb(mem)} memory.`;
  body.replaceChildren(h("div.col", { style: { gap: "4px" } },
    h("div.small", `${N} layers${inf.size_bytes ? ` · ${fmt.bytes(inf.size_bytes)} in all` : ""}${lb ? ` · about ${fmt.bytes(lb)} per layer` : ""}`),
    fits ? h("div.small", fits) : null,
    h("div.small.muted", "Estimated from total memory. Start your node to see free memory, what the swarm already serves, and to download.")));
  text(go.querySelector("span"), "Start my node");
  go.disabled = false;
  go.onclick = () => { s.close(); actions.startHost(); };
}

/** Sheet: size, what's already here and in the swarm, and an editable suggested slice. */
export async function openGet(repo) {
  const body = h("div.col", { style: { gap: "14px" } }, h("div.small.muted", "Reading model info from Hugging Face…"));
  const go = button("Download & serve", { variant: "primary", icon: "download", disabled: true });
  const s = sheet({ title: shortModel(repo), body, footer: [button("Cancel", { onclick: () => s.close() }), go] });
  const inf = await catalogInfo(repo);
  if (inf.error) { body.replaceChildren(h("div.small", { style: { color: "var(--c-gap)" } }, inf.error)); return; }
  if (inf.offline) return offlineInfo(inf, body, go, s);

  const N = inf.n_layers, sug = inf.suggest, l = localOf(repo), m = inf.swarm;
  const lo = h("input.input.num", { type: "number", min: "0", max: String(N - 1), step: "1", value: sug.lo, "aria-label": "First layer" });
  const last = h("input.input.num", { type: "number", min: "0", max: String(N - 1), step: "1", value: Math.max(sug.hi - 1, sug.lo), "aria-label": "Last layer" });
  const est = h("div.small.muted"), err = h("div.small", { style: { color: "var(--c-gap)" } });
  const sync = () => {
    const a = +lo.value, b = +last.value, n = b - a + 1;
    let e = "";
    if (!(Number.isInteger(a) && Number.isInteger(b)) || a < 0 || b < a) e = "The last layer must be at or after the first.";
    else if (b >= N) e = `This model's last layer is ${N - 1}.`;
    else if (n > sug.fits) e = `About ${sug.fits} layers fit in free memory (${fmt.gb(inf.mem_free_gb)}).`;
    text(err, e);
    const sz = inf.layer_bytes ? fmt.bytes(n * inf.layer_bytes) : null;
    text(est, e ? "" : sz ? `${n} layers · downloads up to ${sz} and keeps about ${sz} in memory while serving (${fmt.gb(inf.mem_free_gb)} free). Layers already on disk aren't downloaded again.`
      : `${n} layers. Layers already on disk aren't downloaded again.`);
    go.disabled = !!e;
  };
  lo.addEventListener("input", sync); last.addEventListener("input", sync);
  go.onclick = async () => {
    go.disabled = true;
    if (await serveSlice(repo, +lo.value, +last.value + 1)) { s.close(); setTimeout(refreshLocal, 1500); } else go.disabled = false;
  };

  const facts = [
    `${N} layers${inf.size_bytes ? ` · ${fmt.bytes(inf.size_bytes)} in all` : ""}`,
    l?.layers.length ? `This machine already has ${l.complete ? "every layer" : "layers " + rangesText(l.layers)}.` : "Nothing downloaded on this machine yet.",
    !m || m.state === "offline" ? "Nobody in the swarm serves it yet." : m.gaps.length ? `The swarm serves it but is missing layers ${m.gaps.map(([a, b]) => fmt.layers(a, b)).join(", ")}.` : "The swarm already serves every layer.",
  ];
  body.replaceChildren(
    h("div.col", { style: { gap: "4px" } }, ...facts.map(f => h("div.small", f))),
    h("div.next", icon("layers"), h("span.grow", sug.hi > sug.lo ? `Suggested: layers ${sug.lo}–${sug.hi - 1}. ${sug.reason}${sug.fits_all ? "" : `, sized to ${fmt.gb(inf.mem_free_gb)} free memory`}.` : sug.reason)),
    h("div.row", { style: { gap: "12px" } },
      h("div.field.grow", h("label", "From layer"), lo),
      h("div.field.grow", h("label", "Through layer"), last)),
    est, err);
  sync();
}

/** "Find models" + "On this Mac" cards. Returns { mine, finder, update(s) }, placed separately by the view. */
export function catalogSection() {
  const q = h("input.input", { type: "search", placeholder: "Search MLX models on Hugging Face, like qwen3 or llama", spellcheck: "false", "aria-label": "Search models" });
  const results = h("div.cat-list");
  const status = h("div.small.muted");
  const chips = h("div.cat-chips", h("span.faint.small", "Try"),
    ...["qwen3", "llama", "gemma", "mistral", "deepseek", "phi"].map(w =>
      h("button.chip-btn", { type: "button", onclick: () => { q.value = w; run(); } }, w)));
  const finder = h("section.card.cat-card",
    secHead("search", "Find models", status),
    h("div.cat-search", icon("search"), q), chips, results);
  const localList = h("div.cat-list");
  const mine = h("section.card.cat-card", secHead("memory", "On this machine", h("span.small.muted.disk")), localList);

  let items = [], seq = 0, t, searched = false;
  async function run() {
    const my = ++seq;
    text(status, "Searching…");
    const r = await catalogSearch(q.value.trim());
    if (my !== seq) return;
    if (r.error) { items = []; text(status, r.error); } else { items = r.results; text(status, items.length ? "" : "No MLX models match"); }
    renderResults();
  }
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 350); });

  function row(repo, sub, badges, actions, bar = null) {
    return h("div.list-row",
      h("div.grow", h("div.t", shortModel(repo), h("span.faint.small", " " + repo.split("/")[0])), sub ? h("div.d", sub) : null, bar),
      h("div.row.wrap", ...badges), ...actions);
  }
  function renderResults() {
    results.replaceChildren(...items.map(it => row(it.repo, `${fmt.compact(it.downloads)} downloads · ${fmt.compact(it.likes)} likes`,
      statusBadges(it.repo),
      [button(localOf(it.repo)?.complete ? "Serve…" : "Get…", { size: "sm", icon: "download", onclick: () => openGet(it.repo) })])));
  }
  function renderLocal() {
    text(mine.querySelector(".disk"), local.length ? `${fmt.bytes(local.reduce((a, m) => a + m.disk_bytes, 0))} on disk` : "");
    mine.hidden = !local.length;
    localList.replaceChildren(...local.map(m => row(m.repo,
      `${m.complete ? "Every layer" : m.layers.length ? "Layers " + rangesText(m.layers) : "No layers yet"}${m.n_layers ? ` of ${m.n_layers}` : ""} · ${fmt.bytes(m.disk_bytes)}`,
      [m.serving.length ? badge(`Serving ${rangesText(m.serving)}`, "serving", { dot: true }) : badge("Not serving", "neutral")],
      [m.serving.length || !m.repo.includes("/") ? null : button("Serve…", { size: "sm", icon: "play", onclick: () => openGet(m.repo) }),
        armedButton("Delete", "Delete files?", async () => { if (await catalogDelete(m)) refreshLocal(); }, { size: "sm" })].filter(Boolean),
      layerBar(m.n_layers, m.layers, m.serving))));
  }
  onLocal = () => { renderLocal(); renderResults(); };

  let slicesKey = null, swarmKey = null;
  return {
    finder, mine,
    update(s) {
      const running = s.source === "live" && s.engine.phase === "running";
      if (!searched) { searched = true; run(); }   // browsing works with the node stopped (straight to Hugging Face)
      if (!running) { mine.hidden = true; return; }
      const k = JSON.stringify(s.slices);   // served slices changed: re-scan the disk
      if (k !== slicesKey) { slicesKey = k; refreshLocal(); }
      const sk = models(s).map(m => m.model + m.state + m.gaps).join("|");
      if (sk !== swarmKey) { swarmKey = sk; renderResults(); }
    },
  };
}
