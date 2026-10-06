// Demo Mode: a simulated swarm that emits the same event shapes as the real engine, so every
// view runs through the same reducer. Always badged "Demo" in the UI. Never used in live mode.
import { state, settings, applyEvent, resetState, on, commit, feed } from "./store.js";

const PRESETS = {
  fresh: {
    label: "Fresh pair", hint: "Two Macs joined, model not loaded yet. Click Load model to watch downloads.",
    nodes: [
      { name: "host", chip: "Apple M2 Pro", mem: 16, rtt: 0 },
      { name: "mac-mini", chip: "Apple M2", mem: 16, rtt: 18 },
    ],
    layers: 48, assign: null, loaded: false,
  },
  pair: {
    label: "Two Macs", hint: "Matches today's engine: host 0–23 + worker 24–47, serving.",
    nodes: [
      { name: "host", chip: "Apple M2 Pro", mem: 16, rtt: 0 },
      { name: "mac-mini", chip: "Apple M2", mem: 16, rtt: 22 },
    ],
    layers: 48, assign: [["host", 0, 24], ["mac-mini", 24, 48]], loaded: true,
  },
  swarm: {
    label: "Studio swarm", hint: "Six Macs, overlapping block ranges, two more models. Future-looking.",
    nodes: [
      { name: "host", chip: "Apple M3 Max", mem: 64, rtt: 0 },
      { name: "studio", chip: "Apple M2 Ultra", mem: 128, rtt: 9 },
      { name: "mac-mini", chip: "Apple M4 Pro", mem: 48, rtt: 14 },
      { name: "air-m3", chip: "Apple M3", mem: 24, rtt: 31 },
      { name: "imac", chip: "Apple M4", mem: 32, rtt: 19 },
      { name: "mbp-14", chip: "Apple M4 Max", mem: 36, rtt: 27 },
    ],
    layers: 48,
    assign: [["host", 0, 12], ["mac-mini", 12, 24], ["studio", 12, 36], ["air-m3", 24, 36], ["imac", 36, 48], ["mbp-14", 36, 48]],
    loaded: true,
    extra: [
      { repo: "mlx-community/Llama-3.3-70B-Instruct-4bit", n_layers: 80, assignments: [["studio", 0, 40], ["mbp-14", 40, 56], ["imac", 64, 80]] },
      { repo: "mlx-community/Qwen3-8B-4bit", n_layers: 36, assignments: [["studio", 0, 36], ["mac-mini", 0, 18]] },
    ],
  },
  degraded: {
    label: "Degraded", hint: "One worker dropped (gap) and one is on a slow relay link.",
    nodes: [
      { name: "host", chip: "Apple M2 Pro", mem: 16, rtt: 0 },
      { name: "mac-mini", chip: "Apple M2", mem: 16, rtt: 340 },
      { name: "air-m2", chip: "Apple M2", mem: 16, rtt: 40, lost: true },
    ],
    layers: 48, assign: [["host", 0, 16], ["mac-mini", 16, 32], ["air-m2", 32, 48]], loaded: true,
  },
};
export const presets = PRESETS;

const ANSWERS = [
  `Pipeline parallelism splits a model **by layer**. Each Mac holds a contiguous slice and passes the hidden state to the next:\n\n1. The host embeds the prompt and runs its layers.\n2. The hidden state (about 4 KB per token in fp16) hops to the worker.\n3. The worker runs the rest and sends it back for sampling.\n\nNeither Mac needs the whole model in memory.`,
  `Here's a tiny helper that measures tokens per second:\n\n\`\`\`python\nimport time\n\ndef tok_per_s(stream):\n    t0, n = time.perf_counter(), 0\n    for _ in stream:\n        n += 1\n    return n / (time.perf_counter() - t0)\n\`\`\`\n\nRun it over the token stream and you'll see the network hop is a small slice of each step.`,
  `Unified memory is the trick. On Apple Silicon the GPU reads the same RAM as the CPU, so a 16 GB Mac can hold an ~8.5 GB slice of a 4-bit 30B model plus its KV cache. Two of them together hold the full 17 GB.`,
  `Short answer: **yes**, but latency adds up per hop. With two Macs on a Tailscale mesh you pay one round trip per generated token, typically 10–40 ms on a good link. That's why the host keeps the embeddings and lm_head locally.`,
];

let timers = [], offs = [], running = false, gen = null;
const T = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };
const I = (fn, ms) => { const id = setInterval(fn, ms); timers.push(id); return id; };
const jitter = (x, p = 0.2) => x * (1 + (Math.random() * 2 - 1) * p);
const now = () => Date.now() / 1000;
const ev = (type, data) => applyEvent({ type, ts: now(), ...data });

export function startDemo(presetName = settings.demoPreset) {
  stopDemo();
  running = true;
  const P = PRESETS[presetName] || PRESETS.pair;
  resetState({ source: "demo", role: "host", self: "host" });
  state.engine = { phase: "running", owned: false, line: "", error: "" };
  state.conn = "live";
  ev("host_info", { addresses: ["100.101.24.7", "192.168.1.20"], port: 8000, repo: "mlx-community/Qwen3-30B-A3B-4bit", n_layers: P.layers, chip: P.nodes[0].chip, name: "host" });
  const counters = {};
  P.nodes.forEach((n, i) => {
    counters[n.name] = { tokens: 0, requests: 0 };
    T(() => {
      ev("node_joined", { node: n.name, address: n.name === "host" ? "localhost:8000" : `100.101.${30 + i}.${10 + i}:50051`, role: n.name === "host" ? "host" : "worker", chip: n.chip, mem_total_gb: n.mem });
      ev("memory", { node: n.name, active_gb: n.mem * 0.08, peak_gb: n.mem * 0.1, total_gb: n.mem });
    }, i * 140);
  });
  const doAssign = assign => {
    ev("layer_map", { total_layers: P.layers, assignments: assign.map(([node, lo, hi]) => ({ node, lo, hi, roles: node === "host" ? ["tokenizer", "embeddings", "lm_head"] : [] })) });
  };
  if (P.loaded) T(() => {
    doAssign(P.assign);
    for (const n of P.nodes) {
      const a = P.assign.filter(x => x[0] === n.name), L = a.reduce((s, x) => s + x[2] - x[1], 0);
      ev("memory", { node: n.name, active_gb: Math.min(n.mem * 0.85, 0.36 * L + 0.4), peak_gb: Math.min(n.mem * 0.9, 0.37 * L + 0.6), total_gb: n.mem });
      ev("load_progress", { node: n.name, phase: "ready", done: 1, total: 1 });
      if (n.name !== "host") ev("node_status", { node: n.name, status: n.lost ? "lost" : "ready", rtt_ms: n.lost ? null : n.rtt, heartbeat_ts: now() });
    }
    if (!P.assign.some(a => P.nodes.find(n => n.name === a[0])?.lost)) ev("ready", {});
    state.extraModels = (P.extra || []).map(m => ({
      ...m, id: m.repo, assignments: m.assignments.map(([node, lo, hi]) => ({ node, lo, hi, roles: [] })),
      demoState: (a, n) => !n || n.status === "lost" ? "gap" : "serving",
    }));
    commit();
  }, P.nodes.length * 140 + 200);

  // heartbeats, memory, stats: same cadence as the engine (2 s)
  I(() => {
    for (const n of P.nodes) {
      if (n.name !== "host") ev("node_status", { node: n.name, status: n.lost ? "lost" : (state.nodes[n.name]?.load?.phase === "ready" ? "ready" : "joined"), rtt_ms: n.lost ? null : jitter(n.rtt || 1, 0.25), heartbeat_ts: now() });
      const c = counters[n.name], cur = state.nodes[n.name];
      if (cur?.mem) ev("memory", { node: n.name, ...cur.mem, active_gb: jitter(cur.mem.active_gb, 0.01) });
      const busy = !!gen && !n.lost && gen.route.includes(n.name);
      ev("node_stats", { node: n.name, busy, active_requests: busy ? 1 : 0, tokens: c.tokens, requests: c.requests, ...(n.name === "host" ? { prompt_tokens: c.prompt || 0, generated_tokens: c.gen || 0 } : {}) });
    }
  }, 2000);

  // Load model (fresh preset): fast-forward download → load → ready
  offs.push(on("demo:load", () => {
    if (!running || state.ready || state.loadRequested) return;
    state.loadRequested = true;
    const assign = [["host", 0, 24], ["mac-mini", 24, 48]];
    doAssign(assign);
    for (const [name] of assign) {
      const total = 8.76e9; let done = 0;
      const id = I(() => {
        done = Math.min(total, done + jitter(total / 14, 0.3));
        ev("load_progress", { node: name, phase: "downloading", done, total });
        if (done >= total) {
          clearInterval(id);
          ev("load_progress", { node: name, phase: "loading", done: 0, total: 0 });
          T(() => {
            ev("load_progress", { node: name, phase: "ready", done: 1, total: 1 });
            ev("memory", { node: name, active_gb: 8.7, peak_gb: 9.1, total_gb: 16 });
            if (name !== "host") ev("node_status", { node: name, status: "ready", rtt_ms: 18, heartbeat_ts: now() });
            if (assign.every(([n]) => state.nodes[n]?.load?.phase === "ready")) ev("ready", {});
          }, 1400);
        }
      }, 260);
    }
  }));

  // generation: route = one peer per stage, picked from the layer map
  function routeNodes() {
    const a = (state.layerMap?.assignments || []).filter(x => state.nodes[x.node]?.status !== "lost");
    const out = [], n = state.layerMap?.total_layers || 48;
    let at = 0;
    while (at < n) {
      const opts = a.filter(x => x.lo <= at && x.hi > at);
      if (!opts.length) return null;
      const pick = opts.reduce((b, x) => x.hi > b.hi ? x : b, opts[0]);
      out.push(pick.node); at = pick.hi;
    }
    return out;
  }
  function generate(text, user) {
    const route = routeNodes();
    if (!route || !state.ready) {
      if (user) ev("error", { message: "model not started" });
      return;
    }
    const words = text.match(/\s*\S+|\s+/g) || [];
    const me = gen = { route, user };
    const c = counters.host;
    c.requests++; const promptTokens = 24 + Math.floor(Math.random() * 40); c.prompt = (c.prompt || 0) + promptTokens;
    let i = 0;
    const multi = route.length > 2;
    const step = () => {
      if (!running || gen !== me) return;
      if (i >= words.length) {
        const total = (performance.now() - gen.t0) / 1000;
        ev("done", { tokens: i, ttft_ms: gen.ttft, tok_s: (i - 1) / Math.max(total - gen.ttft / 1000, 1e-3), total_ms: total * 1000, prompt_tokens: promptTokens, ambient: !user });
        gen = null;
        return;
      }
      const prefill = i === 0, scale = prefill ? 9 : 1;
      const stages = [{ node: "host", compute_ms: 0, pre_ms: jitter(6 * scale), post_ms: jitter(2.2) }];
      stages[0].compute_ms = stages[0].pre_ms + stages[0].post_ms;
      const workers = route.filter(r => r !== "host");
      let wait = stages[0].compute_ms;
      if (multi) {
        for (const w of workers) {
          const rtt = P.nodes.find(n => n.name === w)?.rtt || 15;
          const net = jitter(rtt / 2, 0.3), cm = jitter(7 * scale);
          stages.push({ node: "network", compute_ms: net }, { node: w, compute_ms: cm });
          wait += net + cm;
          counters[w].tokens += prefill ? promptTokens : 1; counters[w].requests++;
        }
        const back = jitter((P.nodes.find(n => n.name === workers[workers.length - 1])?.rtt || 15) / 2, 0.3);
        stages.push({ node: "network", compute_ms: back }); wait += back;
      } else {
        for (const w of workers) {
          const rtt = jitter(P.nodes.find(n => n.name === w)?.rtt || 15, 0.3), cm = jitter(14 * scale);
          stages.push({ node: "network", compute_ms: rtt }, { node: w, compute_ms: cm });
          wait += rtt + cm;
          counters[w].tokens += prefill ? promptTokens : 1; counters[w].requests++;
        }
      }
      c.tokens += prefill ? promptTokens : 1; c.gen = (c.gen || 0) + 1;
      if (prefill) { gen.t0 = performance.now(); gen.ttft = wait; }
      T(() => {
        if (!running || gen !== me) return;
        ev("token", { index: i, text: words[i], token: 1000 + i });
        ev("token_timing", { index: i, prefill, bytes: 4096, stages });
        i++;
        step();
      }, Math.max(16, wait));
    };
    step();
  }
  offs.push(on("demo:chat", ({ prompt }) => {
    if (!running) return;
    if (gen && !gen.user) gen = null; // the user's prompt pre-empts ambient traffic
    const pick = /code|python|function|script/i.test(prompt) ? ANSWERS[1] : /memory|ram|unified/i.test(prompt) ? ANSWERS[2] : /latency|fast|slow|network/i.test(prompt) ? ANSWERS[3] : ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    T(() => generate(pick, true), 250);
  }));
  // ambient traffic so the graph shows pulses (another app on the host calling the swarm)
  I(() => {
    if (!settings.demoAutoplay || gen || state.chat.busy || !state.ready || document.hidden) return;
    generate(ANSWERS[Math.floor(Math.random() * ANSWERS.length)].slice(0, 220), false);
  }, 9000);
  T(() => feed("demo", `Demo Mode: ${P.label}`, P.hint, "info"), 50);
}

export function stopDemo() {
  running = false; gen = null;
  timers.forEach(id => { clearTimeout(id); clearInterval(id); });
  timers = [];
  offs.forEach(f => f()); offs = [];
}
