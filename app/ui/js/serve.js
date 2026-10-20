// "Serve layers" sheet: pick a model and a layer range, and whether this Mac or a connected
// peer serves it. Opened from Models ("Serve missing layers" pre-fills the gap), My Node and ⌘K.
import { h, text, fmt } from "./dom.js";
import { state, models, shortModel } from "./store.js";
import { button, sheet } from "./ui.js";
import { serveSlice } from "./engine.js";

const DEFAULT_REPO = "mlx-community/Qwen3-30B-A3B-4bit";

/** @param {{model?: string, lo?: number, hi?: number}} pre */
export function openServe(pre = {}) {
  const ms = models(state);
  const known = [...new Set([pre.model, state.hostInfo?.repo, ...ms.map(m => m.model), DEFAULT_REPO].filter(Boolean))];
  const layersOf = repo => ms.find(m => m.model === repo)?.n_layers ?? null;

  const model = h("input.input.mono", { list: "pt-models", value: pre.model || known[0], spellcheck: "false", "aria-label": "Model repo" });
  const list = h("datalist#pt-models", known.map(k => h("option", { value: k })));
  const lo = h("input.input.num", { type: "number", min: "0", step: "1", value: pre.lo ?? 0, "aria-label": "First layer" });
  const last = h("input.input.num", { type: "number", min: "0", step: "1", "aria-label": "Last layer" });
  const peers = state.swarm.peers.filter(p => p.peer_id !== state.swarm.selfId && p.link?.state === "direct");
  const where = h("select.input", { "aria-label": "Serve on" },
    h("option", { value: "" }, `This machine${state.memFree != null ? ` · ${fmt.gb(state.memFree)} free for models` : ""}`),
    ...peers.map(p => {
      const free = p.link?.info?.mem_free_gb ?? p.mem_free_gb;
      return h("option", { value: p.name || p.peer_id }, `${p.name || p.peer_id.slice(0, 8)}${free != null ? ` · ${fmt.gb(free)} free` : ""}`);
    }));
  const note = h("div.small.muted");
  const err = h("div.small", { style: { color: "var(--c-gap)" } });

  const n = () => layersOf(model.value.trim());
  const sync = () => {
    const N = n();
    last.max = N != null ? String(N - 1) : "";
    lo.max = N != null ? String(N - 1) : "";
    const a = +lo.value, b = +last.value;
    text(note, `${shortModel(model.value.trim()) || "This model"}${N != null ? ` has ${N} layers` : " (layer count shows once a peer serves it)"}. `
      + (Number.isInteger(a) && Number.isInteger(b) && b >= a ? `Serving layers ${a}–${b} (${b - a + 1} layers). Only those tensors are downloaded; the slice is refused up front if it won't fit in memory.` : ""));
    let e = "";
    if (!model.value.trim().includes("/")) e = "Enter a Hugging Face repo, like owner/name.";
    else if (!(Number.isInteger(a) && Number.isInteger(b)) || a < 0 || b < a) e = "The last layer must be at or after the first.";
    else if (N != null && b >= N) e = `This model's last layer is ${N - 1}.`;
    text(err, e);
    go.disabled = !!e;
  };
  const first = pre.hi != null ? pre.hi - 1 : (n() ?? 48) - 1;
  last.value = first;
  for (const el of [model, lo, last]) el.addEventListener("input", sync);

  const go = button("Serve", {
    variant: "primary", icon: "download", onclick: async () => {
      go.disabled = true;
      const ok = await serveSlice(model.value.trim(), +lo.value, +last.value + 1, where.value || null);
      if (ok || state.source === "demo") s.close(); else go.disabled = false;
    },
  });
  const s = sheet({
    title: "Serve text-model layers",
    body: h("div.col", { style: { gap: "14px" } },
      h("div.field", h("label", "Model"), model),
      h("div.row", { style: { gap: "12px" } },
        h("div.field.grow", h("label", "From layer"), lo),
        h("div.field.grow", h("label", "Through layer"), last)),
      h("div.field", h("label", "Serve on"), where),
      note, err, list),
    footer: [button("Cancel", { onclick: () => s.close() }), go],
  });
  sync();
}
