// Model catalog for the Models view: see what this machine already holds, and get a model ("Download
// & serve" with a slice sized to free memory and the swarm's gaps). Picking a model is the shared
// model table (modelpicker.js).
import { h, text, fmt } from "./dom.js";
import { state, models, shortModel } from "./store.js";
import { actions } from "./actions.js";

const GB = 2 ** 30;
import { button, iconButton, badge, armedButton, sheet } from "./ui.js";
import { icon } from "./icons.js";
import { serveSlice, unserveSlice, catalogInfo, catalogLocal, catalogDelete, cancelDownload } from "./engine.js";

let local = [];          // this machine's model folders, from /api/catalog/local
let onLocal = () => {};  // re-render hook set by the section
export const localModels = () => local;
export async function refreshLocal() { local = await catalogLocal(); onLocal(); }

const rangesText = rs => rs.map(([a, b]) => fmt.layers(a, b)).join(", ");
const localOf = repo => local.find(m => m.repo === repo);
const swarmOf = repo => models(state).find(m => m.model === repo);
const inRuns = (rs, i) => rs.some(([a, b]) => a <= i && i < b);

/** Play / stop for this machine's layers of `repo`: play serves what's on disk (nothing to download),
 *  stop stops serving. Null when this machine has none of it. */
export function playStop(repo) {
  const l = localOf(repo), mine = state.slices.filter(x => x.model === repo);
  if (!l?.layers.length && !mine.length) return null;
  const loaded = mine.filter(x => x.loaded).map(x => [x.lo, x.hi]), idle = mine.length ? [] : l.layers;
  const play = iconButton("play", idle.length ? `Serve layers ${rangesText(idle)} on this machine` : mine.length ? "Already serving" : "Nothing on disk",
    () => { play.disabled = true; idle.forEach(([a, b]) => serveSlice(repo, a, b)); });
  const stop = iconButton("stop", loaded.length ? `Stop serving layers ${rangesText(loaded)} on this machine` : "Not serving",
    () => { stop.disabled = true; loaded.forEach(([a, b]) => unserveSlice(repo, a, b)); });
  play.disabled = !idle.length; stop.disabled = !loaded.length;
  return h("div.ps-group", { role: "group", "aria-label": "This machine" }, play, stop);
}
/** Changes whenever playStop(repo) would draw differently. */
export const playStopKey = repo => JSON.stringify([localOf(repo)?.layers, state.slices.filter(x => x.model === repo).map(x => [x.lo, x.hi, x.loaded])]);

/** One cell per layer: serving here, downloading, on disk, or absent. */
function layerBar(n, onDisk, serving, fetching = [], fetchLabel = "Downloading") {
  if (!n) return null;
  const inR = (rs, i) => rs.some(([a, b]) => a <= i && i < b);
  return h("div.lbar-wrap",
    h("div.lbar", { role: "img", "aria-label": `${n} layers` },
      ...Array.from({ length: n }, (_, i) => h(`i${inR(serving, i) ? ".srv" : inR(fetching, i) ? ".dl" : inR(onDisk, i) ? ".disk" : ""}`))),
    h("div.lbar-key.small.faint", h("span", h("i.srv"), "Serving"), fetching.length ? h("span", h("i.dl"), fetchLabel) : null,
      h("span", h("i.disk"), "Downloaded"), h("span", h("i"), "Not here")));
}

/** Slices of `repo` this machine is still fetching or loading (live, from load_progress). */
const pendingOf = repo => state.slices.filter(s => s.model === repo && !s.loaded);
const pct = s => s.total ? Math.min(100, Math.round(100 * s.done / s.total)) : null;
function progressText(s) {
  const what = `Layers ${fmt.layers(s.lo, s.hi)}`;
  if (s.phase === "downloading" && s.total) return `Downloading ${what} · ${fmt.bytes(s.done)} of ${fmt.bytes(s.total)} (${pct(s)}%)`;
  if (s.phase === "downloading") return `Downloading ${what}…`;
  if (s.phase === "loading") return `Loading ${what} into memory…`;
  return `Preparing ${what}…`;
}

/** One in-progress slice: what, how far, and Cancel while it is still downloading. */
function pendingRow(s, bars) {
  const label = h("span.grow.small"), bar = h("div.progress", h("i"));
  const cancel = button("Cancel", { size: "sm", icon: "x", onclick: async () => { cancel.disabled = true; if (!await cancelDownload(s.model, s.lo, s.hi)) cancel.disabled = false; } });
  const set = x => {
    text(label, progressText(x));
    const p = x.phase === "downloading" ? pct(x) : null;
    bar.classList.toggle("indeterminate", p == null);
    bar.firstChild.style.width = p == null ? "" : p + "%";
    cancel.hidden = x.phase === "loading";   // loading into memory can't be interrupted
  };
  set(s);
  bars.set(`${s.model}:${s.lo}:${s.hi}`, set);
  return h("div.cat-dl", h("div.row", { style: { gap: "8px", alignItems: "center" } }, icon("download"), label, cancel), bar);
}

/** Section heading: icon, title, live count on the right. */
export function secHead(ic, title, extra) {
  return h("div.sec-h", h("span.sec-ic", icon(ic)), h("h2", title), h("span.spacer"), extra || null);
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
    let fresh = 0; for (let i = a; i <= b; i++) if (!inRuns(l?.layers || [], i)) fresh++;
    const dl = inf.layer_bytes ? ` (about ${fmt.bytes(fresh * inf.layer_bytes)})` : "";
    text(est, e ? "" : `${n} layers. ${fresh ? `Downloads ${fresh === n ? "them" : `the ${fresh} not on disk yet`}${dl}` : "All on disk: nothing to download"}. Keeps ${sz ? `about ${sz}` : "them"} in memory while serving (${fmt.gb(inf.mem_free_gb)} free).`);
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

/** Sheet: add layers before or after the ones this machine has, and serve the wider range. The node
 *  downloads only the new layers and swaps the old slice out once the wider one is loaded. */
export async function openAdjust(repo) {
  const l = localOf(repo);
  // The run being extended: the one served here, else the longest on disk.
  const srv = state.slices.find(x => x.model === repo && x.loaded);
  const [lo0, hi0] = srv ? [srv.lo, srv.hi] : [...(l?.layers || [])].sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0] || [0, 0];
  const body = h("div.col", { style: { gap: "14px" } }, h("div.small.muted", "Reading model info…"));
  const go = button("Serve", { variant: "primary", icon: "play", disabled: true });
  const s = sheet({ title: `Adjust ${shortModel(repo)}`, body, footer: [button("Cancel", { onclick: () => s.close() }), go] });
  const inf = await catalogInfo(repo);
  if (inf.error) { body.replaceChildren(h("div.small", { style: { color: "var(--c-gap)" } }, inf.error)); return; }
  if (inf.offline) {
    body.replaceChildren(h("div.small", "Start your node to change the layers it serves."));
    text(go.querySelector("span"), "Start my node"); go.disabled = false; go.onclick = () => { s.close(); actions.startHost(); };
    return;
  }
  const N = inf.n_layers, lb = inf.layer_bytes || 0;
  let before = 0, after = 0;
  const bar = h("div"), sum = h("div.small"), err = h("div.small", { style: { color: "var(--c-gap)" } });
  const stepper = (label, get, set, max) => {
    const v = h("b.num"), minus = iconButton("minus", `Fewer layers ${label.toLowerCase()}`, () => { set(get() - 1); paint(); }),
      plus = iconButton("plus", `More layers ${label.toLowerCase()}`, () => { set(get() + 1); paint(); });
    return { el: h("div.field", h("label", label), h("div.stepper", minus, v, plus)), paint: () => { text(v, String(get())); minus.disabled = get() <= 0; plus.disabled = get() >= max; } };
  };
  const front = stepper("Before", () => before, x => { before = x; }, lo0), back = stepper("After", () => after, x => { after = x; }, N - hi0);
  function paint() {
    front.paint(); back.paint();
    const lo = lo0 - before, hi = hi0 + after, n = hi - lo, added = [];
    if (before) added.push([lo, lo0]); if (after) added.push([hi0, hi]);
    let fresh = 0; for (let i = lo; i < hi; i++) if (!inRuns(l?.layers || [], i)) fresh++;
    bar.replaceChildren(layerBar(N, l?.layers || [], srv ? [[srv.lo, srv.hi]] : [], added, "Adding"));
    const need = n * lb / GB, room = inf.mem_free_gb + (srv ? (srv.hi - srv.lo) * lb / GB : 0);
    text(err, lb && need > room * 0.95 ? `Layers ${fmt.layers(lo, hi)} need about ${fmt.gb(need)}; this machine has ${fmt.gb(room)} for them.` : "");
    text(sum, `Layers ${fmt.layers(lo, hi)}, ${n} of ${N}. ${fresh ? `Downloads ${fresh} new layer${fresh > 1 ? "s" : ""}${lb ? ` (about ${fmt.bytes(fresh * lb)})` : ""}` : "Nothing to download"}${lb ? `, keeps about ${fmt.bytes(n * lb)} in memory while serving` : ""}.`);
    text(go.querySelector("span"), srv && !before && !after ? "Serving" : `Serve ${fmt.layers(lo, hi)}`);
    go.disabled = !!err.textContent || (srv && !before && !after);
  }
  go.onclick = async () => {
    go.disabled = true;
    if (await serveSlice(repo, lo0 - before, hi0 + after)) { s.close(); setTimeout(refreshLocal, 1500); } else go.disabled = false;
  };
  body.replaceChildren(
    h("div.small.muted", `${srv ? "Serving" : "On disk"}: layers ${fmt.layers(lo0, hi0)}. Add layers before or after to serve more of the model.`),
    h("div.row", { style: { gap: "24px" } }, front.el, back.el), bar, sum, err);
  paint();
}

/** "On this machine" card. Returns { mine, update(s) }, placed by the view. */
export function catalogSection() {
  const localList = h("div.cat-list");
  const mine = h("section.card.cat-card", secHead("memory", "On this machine", h("span.small.muted.disk")), localList);

  function row(repo, sub, badges, actions, bar = null) {
    return h("div.list-row",
      h("div.grow", h("div.t", shortModel(repo), h("span.faint.small", " " + repo.split("/")[0])), sub ? h("div.d", sub) : null, bar),
      h("div.row.wrap", ...badges), ...actions);
  }
  const bars = new Map();   // "model:lo:hi" -> update fn for that slice's progress line
  function renderLocal() {
    bars.clear();
    // A model whose first slice is still starting may have no folder on disk yet: show it anyway.
    const rows = [...local];
    for (const s of state.slices) if (!s.loaded && !rows.some(m => m.repo === s.model))
      rows.push({ repo: s.model, dir: null, layers: [], n_layers: s.n_layers, disk_bytes: 0, serving: [], complete: false });
    text(mine.querySelector(".disk"), local.length ? `${fmt.bytes(local.reduce((a, m) => a + m.disk_bytes, 0))} on disk` : "");
    mine.hidden = !rows.length;
    localList.replaceChildren(...rows.map(m => {
      const pend = running ? pendingOf(m.repo) : [];
      const fetching = pend.map(s => [s.lo, s.hi]);
      const r = row(m.repo,
        `${m.complete ? "Every layer" : m.layers.length ? "Layers " + rangesText(m.layers) : "No layers yet"}${m.n_layers ? ` of ${m.n_layers}` : ""} · ${fmt.bytes(m.disk_bytes)}`,
        [m.serving.length ? badge(`Serving ${rangesText(m.serving)}`, "serving", { dot: true }) : null,
          pend.length ? badge(`Downloading ${rangesText(fetching)}`, "active", { dot: true }) : null,
          !m.serving.length && !pend.length ? badge("Not serving", "neutral") : null].filter(Boolean),
        // Play / stop sit on the model's row in the swarm; here only for models the swarm doesn't list.
        [swarmOf(m.repo) ? null : playStop(m.repo),
          running && m.repo.includes("/") && m.layers.length && !pend.length ? button("Adjust", { size: "sm", icon: "layers", onclick: () => openAdjust(m.repo) }) : null,
          running && m.dir && armedButton("Delete", pend.length ? "Cancel and delete files?" : "Delete files?", async () => { if (await catalogDelete(m)) refreshLocal(); }, { size: "sm" })].filter(Boolean),
        layerBar(m.n_layers, m.layers, m.serving, fetching));
      if (pend.length) r.querySelector(".grow").append(...pend.map(s => pendingRow(s, bars)));
      return r;
    }));
  }
  onLocal = renderLocal;

  let slicesKey = null, swarmKey = null, running = null;
  return {
    mine,
    update(s) {
      const was = running;
      running = s.source === "live" && s.engine.phase === "running";
      if (s.source !== "live") { mine.hidden = true; return; }
      if (running !== was) { slicesKey = null; if (!running) refreshLocal(); }   // stopped: read the disk natively
      if (!running) return;
      // Slices added, removed, loaded or moved to another phase: re-scan the disk. Byte counts only move
      // the progress bars in place.
      const k = JSON.stringify(s.slices.map(x => [x.model, x.lo, x.hi, x.loaded, x.phase]));
      if (k !== slicesKey) { slicesKey = k; refreshLocal(); }
      else for (const x of s.slices) bars.get(`${x.model}:${x.lo}:${x.hi}`)?.(x);
      const sk = models(s).map(m => m.model).join("|");   // which rows get play / stop here
      if (sk !== swarmKey) { swarmKey = sk; renderLocal(); }
    },
  };
}
