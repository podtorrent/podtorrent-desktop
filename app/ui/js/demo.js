// Demo Mode: a simulated swarm that emits the same event shapes as the real peer (swarm, slices,
// models, layer_map, token_timing with routes...), so every view runs through the same reducer.
// Always badged "Demo" in the UI. Never used in live mode.
import { state, settings, applyEvent, resetState, on, commit, feed, shortModel } from "./store.js";
import { fmt } from "./dom.js";

const QWEN = "mlx-community/Qwen3-30B-A3B-4bit", BIG = "mlx-community/Qwen3-235B-A22B-4bit";
const N_LAYERS = { [QWEN]: 48, [BIG]: 94 };
const GB_PER_LAYER = { [QWEN]: 0.33, [BIG]: 1.4 };
const SELF = "this-mac";

// Each peer: name, chip, memory, RTT from this Mac, link (direct | unreachable), slices [model, lo, hi],
// and optionally `joinAt` (seconds after start) to join live.
const PRESETS = {
  swarm: {
    label: "Four Macs, two models",
    hint: "Two models, one gap in the big one, an unreachable peer, and a Mac that joins after ~12 s and fills the gap.",
    mine: [[QWEN, 0, 16]],
    peers: [
      { name: "studio", chip: "Apple M2 Ultra", mem: 128, rtt: 9, slices: [[QWEN, 16, 48], [BIG, 0, 60]] },
      { name: "mac-mini", chip: "Apple M4 Pro", mem: 48, rtt: 14, slices: [[QWEN, 32, 48], [BIG, 60, 80]] },
      { name: "air", chip: "Apple M3", mem: 24, rtt: null, link: "unreachable", error: "hole punch timed out", slices: [[QWEN, 0, 16]] },
      { name: "mbp-16", chip: "Apple M4 Max", mem: 64, rtt: 23, slices: [[BIG, 76, 94]], joinAt: 12 },
    ],
  },
  pair: {
    label: "Two Macs",
    hint: "The everyday setup: this Mac serves layers 0–23 of Qwen3-30B-A3B, another Mac serves 24–47.",
    mine: [[QWEN, 0, 24]],
    peers: [{ name: "mac-mini", chip: "Apple M2", mem: 16, rtt: 22, slices: [[QWEN, 24, 48]] }],
  },
  fresh: {
    label: "Fresh pair",
    hint: "Two Macs connected, nothing served yet. Click Load model, or Serve layers, to watch the downloads.",
    mine: [],
    peers: [{ name: "mac-mini", chip: "Apple M2", mem: 16, rtt: 18, slices: [] }],
  },
  degraded: {
    label: "Degraded",
    hint: "A Mac behind a symmetric NAT can't be reached, so its layers are a gap; another is on a slow link.",
    mine: [[QWEN, 0, 16]],
    peers: [
      { name: "mac-mini", chip: "Apple M2", mem: 16, rtt: 340, slices: [[QWEN, 16, 32]] },
      { name: "air-m2", chip: "Apple M2", mem: 16, rtt: null, link: "unreachable", error: "hole punch timed out (symmetric NAT?)", slices: [[QWEN, 32, 48]] },
    ],
  },
};
export const presets = PRESETS;

const ANSWERS = [
  `Pipeline parallelism splits a model **by layer**. Each Mac holds a contiguous slice and passes the hidden state to the next:\n\n1. This Mac embeds the prompt.\n2. The hidden state (about 4 KB per token in fp16) hops through each peer's layers in order.\n3. It comes back here for the head and sampling.\n\nNo Mac needs the whole model in memory.`,
  `Here's a tiny helper that measures tokens per second:\n\n\`\`\`python\nimport time\n\ndef tok_per_s(stream):\n    t0, n = time.perf_counter(), 0\n    for _ in stream:\n        n += 1\n    return n / (time.perf_counter() - t0)\n\`\`\`\n\nRun it over the token stream and you'll see each network hop is a small slice of every step.`,
  `Unified memory is the trick. On Apple Silicon the GPU reads the same RAM as the CPU, so a 16 GB Mac can hold half of a 4-bit 30B model plus its KV cache. Two of them together hold the whole thing.`,
  `Short answer: **yes**, but latency adds up per hop. Every generated token crosses each hop once, typically 5–40 ms per hop between home networks. That's why the route planner prefers fewer, closer peers.`,
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
  const P = PRESETS[presetName] || PRESETS.swarm, hl = state.health;
  const me = { name: SELF, chip: hl?.chip || "Apple M3 Pro", mem: hl?.mem_total_gb ? Math.round(hl.mem_total_gb) : 36 };
  const mine = P.mine.map(([model, lo, hi]) => ({ model, lo, hi, loaded: true, phase: "ready" }));
  const peers = P.peers.map((p, i) => ({
    ...p, id: `demo${i}${"0".repeat(14)}`, link: p.link || "direct", online: !p.joinAt,
    slices: p.slices.map(([model, lo, hi]) => ({ model, lo, hi, loaded: true })), counters: { tokens: 0, requests: 0 },
  }));
  const counters = { tokens: 0, requests: 0, prompt: 0, gen: 0 };
  resetState({ source: "demo", role: "host", self: SELF });
  state.engine = { phase: "running", owned: false, line: "", error: "" };
  state.conn = "live";

  const layersOf = list => list.reduce((a, x) => a + (x.loaded ? (x.hi - x.lo) * (GB_PER_LAYER[x.model] || 0.33) : 0), 0);
  const memOf = (mem, list) => Math.min(mem * 0.85, layersOf(list) + 0.6);
  const freeOf = (mem, list) => Math.max(0, mem * 0.75 - memOf(mem, list));
  const direct = () => peers.filter(p => p.online && p.link === "direct");

  /** Cheapest route: fewest hops, then lowest RTT (the real planner is a Dijkstra in route.py). */
  function plan(model, exclude = new Set()) {
    const n = N_LAYERS[model];
    const offers = [...mine.filter(x => x.model === model && x.loaded).map(x => ({ node: SELF, lo: x.lo, hi: x.hi, rtt: 0 })),
      ...direct().filter(p => !exclude.has(p.name)).flatMap(p => p.slices.filter(x => x.model === model && x.loaded).map(x => ({ node: p.name, lo: x.lo, hi: x.hi, rtt: p.rtt })))];
    const best = new Map([[0, { cost: 0, path: [] }]]);
    const points = [...new Set([0, n, ...offers.flatMap(o => [o.lo, o.hi])])].filter(x => x >= 0 && x <= n).sort((a, b) => a - b);
    for (const at of points) {
      const cur = best.get(at);
      if (!cur) continue;
      for (const o of offers) {
        if (!(o.lo <= at && at < o.hi)) continue;
        for (const to of points) {
          if (to <= at || to > Math.min(o.hi, n)) continue;
          const c = cur.cost + o.rtt + (to - at) + 1000;
          if (!best.has(to) || c < best.get(to).cost) best.set(to, { cost: c, path: [...cur.path, [o.node, at, to]] });
        }
      }
    }
    const merged = [];
    for (const hop of best.get(n)?.path || []) {
      const last = merged[merged.length - 1];
      if (last && last[0] === hop[0] && last[2] === hop[1]) last[2] = hop[2]; else merged.push([...hop]);
    }
    const covered = Array(n).fill(0);
    for (const o of offers) for (let i = o.lo; i < Math.min(o.hi, n); i++) covered[i]++;
    const gaps = [];
    let start = null;
    covered.concat([1]).forEach((c, i) => { if (!c && start == null) start = i; else if (c && start != null) { gaps.push([start, i]); start = null; } });
    return { route: best.has(n) ? merged : [], gaps, covered };
  }

  const record = p => ({
    peer_id: p.id, name: p.name, chip: p.chip, mem_total_gb: p.mem, mem_free_gb: freeOf(p.mem, p.slices),
    slices: p.slices.map(x => ({ ...x, n_layers: N_LAYERS[x.model] })),
    link: p.link === "direct"
      ? { state: "direct", via: p.rtt < 15 ? "lan" : "stun", addr: `203.0.113.${20 + p.name.length}:4${p.name.length}11`, rtt_ms: jitter(p.rtt, 0.15), info: { slices: p.slices.map(x => ({ ...x, n_layers: N_LAYERS[x.model] })), mem_free_gb: freeOf(p.mem, p.slices) } }
      : { state: "unreachable", error: p.error || "hole punch timed out", via: "", addr: "", rtt_ms: null },
  });
  function publish() {
    if (!running) return;
    ev("swarm", {
      status: "online", self_id: "self",
      peers: [{ peer_id: "self", name: SELF, chip: me.chip, mem_total_gb: me.mem, slices: mine.filter(x => x.loaded) }, ...peers.filter(p => p.online).map(record)],
    });
    ev("slices", { slices: mine.map(x => ({ ...x, n_layers: N_LAYERS[x.model] })), mem_free_gb: freeOf(me.mem, mine) });
    const names = new Set([QWEN, ...mine.map(x => x.model), ...peers.filter(p => p.online).flatMap(p => p.slices.map(x => x.model))]);
    ev("models", {
      models: [...names].map(model => {
        const { route, gaps, covered } = plan(model);
        return {
          model, n_layers: N_LAYERS[model], coverage: covered, online_coverage: covered, gaps, route,
          state: route.length ? "available" : covered.some(Boolean) ? "partial" : "offline", redundancy: Math.min(...covered),
          peers: [...new Set(route.map(r => r[0]))], default: model === QWEN,
        };
      }),
    });
    const q = plan(QWEN).route;
    if (q.length) {
      ev("layer_map", { total_layers: 48, assignments: [...(q.some(r => r[0] === SELF) ? [] : [{ node: SELF, lo: 0, hi: 0, roles: ["tokenizer", "embeddings", "lm_head"] }]), ...q.map(([node, lo, hi]) => ({ node, lo, hi, roles: node === SELF ? ["tokenizer", "embeddings", "lm_head"] : [] }))] });
      ev("ready", {});
    } else state.ready = false;
  }

  function joinPeer(p, i) {
    p.online = true;
    ev("node_joined", { node: p.name, address: p.link === "direct" ? "direct" : "", role: "peer", chip: p.chip, mem_total_gb: p.mem });
    ev("memory", { node: p.name, active_gb: memOf(p.mem, p.slices), peak_gb: memOf(p.mem, p.slices) + 0.3, total_gb: p.mem });
    ev("node_status", { node: p.name, status: p.link === "direct" ? "ready" : "lost", rtt_ms: p.link === "direct" ? p.rtt : null, heartbeat_ts: now() });
    if (i != null && p.joinAt) feed("join", `${p.name} joined and serves ${p.slices.map(x => `${shortModel(x.model)} ${fmt.layers(x.lo, x.hi)}`).join(", ")}`, "Simulated", "success");
    publish();
  }

  ev("host_info", { port: 8000, repo: QWEN, n_layers: 48, chip: me.chip, name: SELF, peer_id: "self" });
  ev("node_joined", { node: SELF, address: "udp/51820", role: "host", chip: me.chip, mem_total_gb: me.mem });
  ev("memory", { node: SELF, active_gb: memOf(me.mem, mine), peak_gb: memOf(me.mem, mine) + 0.4, total_gb: me.mem });
  peers.forEach((p, i) => { if (p.online) T(() => joinPeer(p), 120 + i * 140); else T(() => joinPeer(p, i), p.joinAt * 1000); });
  T(publish, 120 + peers.length * 140);

  // heartbeats, memory, stats: same cadence as the engine (2 s)
  I(() => {
    for (const p of peers.filter(x => x.online)) {
      if (p.link === "direct") ev("node_status", { node: p.name, status: "ready", rtt_ms: jitter(p.rtt, 0.25), heartbeat_ts: now() });
      const busy = !!gen && gen.route.some(r => r[0] === p.name);
      ev("node_stats", { node: p.name, busy, active_requests: busy ? 1 : 0, tokens: p.counters.tokens, requests: p.counters.requests });
    }
    ev("memory", { node: SELF, active_gb: memOf(me.mem, mine), peak_gb: memOf(me.mem, mine) + 0.4, total_gb: me.mem });
    ev("node_stats", { node: SELF, busy: !!gen, active_requests: gen ? 1 : 0, tokens: counters.tokens, requests: counters.requests, prompt_tokens: counters.prompt, generated_tokens: counters.gen });
  }, 2000);
  I(publish, 5000);

  /** Simulated download → load → ready for a slice on this Mac or a peer. */
  function serve(model, lo, hi, on = null) {
    const n = N_LAYERS[model];
    if (!n) { ev("error", { message: `Demo Mode only knows ${shortModel(QWEN)} and ${shortModel(BIG)}` }); return; }
    const owner = on ? peers.find(p => p.name === on) : null;
    const list = owner ? owner.slices : mine;
    const free = owner ? freeOf(owner.mem, owner.slices) : freeOf(me.mem, mine);
    const need = (hi - lo) * (GB_PER_LAYER[model] || 0.33);
    const node = owner ? owner.name : SELF;
    if (need + 1 > free) { ev("load_progress", { node, model, lo, hi, phase: "error", done: 0, total: 0, message: `${shortModel(model)} layers [${lo},${hi}) need ~${need.toFixed(1)} GB, but ${node} has ${free.toFixed(1)} GB free for models` }); ev("error", { message: `${node}: not enough memory for ${shortModel(model)} ${fmt.layers(lo, hi)}` }); return; }
    const sl = { model, lo, hi, loaded: false, phase: "downloading" };
    list.push(sl);
    const total = need * 2 ** 30; let done = 0;
    publish();
    const id = I(() => {
      done = Math.min(total, done + jitter(total / 12, 0.3));
      ev("load_progress", { node, model, lo, hi, phase: "downloading", done, total });
      if (done >= total) {
        clearInterval(id);
        ev("load_progress", { node, model, lo, hi, phase: "loading", done: 0, total: 0 });
        T(() => {
          sl.loaded = true; sl.phase = "ready";
          for (const x of [...list]) if (x !== sl && x.model === model && lo <= x.lo && x.hi <= hi) list.splice(list.indexOf(x), 1);
          ev("load_progress", { node, model, lo, hi, phase: "ready", done: 1, total: 1 });
          publish();
        }, 1200);
      }
    }, 260);
  }
  offs.push(on("demo:serve", ({ model, lo, hi, peer }) => running && serve(model, lo, hi, peer)));
  offs.push(on("demo:unserve", ({ model, lo, hi }) => {
    const i = mine.findIndex(x => x.model === model && x.lo === lo && x.hi === hi);
    if (i >= 0) { mine.splice(i, 1); feed("load", `This Mac stopped serving ${shortModel(model)} ${fmt.layers(lo, hi)}`, "", "info"); publish(); }
  }));
  // Load model (Fresh pair): this Mac serves the first half, a connected peer the rest
  offs.push(on("demo:load", () => {
    if (!running || state.ready || state.loadRequested) return;
    const helper = direct()[0];
    if (!helper) return;
    state.loadRequested = true;
    if (!mine.some(x => x.model === QWEN)) serve(QWEN, 0, 24);
    if (!plan(QWEN).route.length) serve(QWEN, 24, 48, helper.name);
  }));

  function generate(text, user, model = QWEN) {
    const { route } = plan(model);
    if (!route.length) { if (user) ev("error", { message: `${shortModel(model)} not covered` }); return; }
    const words = text.match(/\s*\S+|\s+/g) || [];
    const g = gen = { route, user };
    counters.requests++;
    const promptTokens = 24 + Math.floor(Math.random() * 40);
    counters.prompt += promptTokens;
    let i = 0, t0 = 0, ttft = 0;
    const step = () => {
      if (!running || gen !== g) return;
      if (i >= words.length) {
        const total = (performance.now() - t0) / 1000;
        ev("done", { tokens: i, ttft_ms: ttft, tok_s: (i - 1) / Math.max(total - ttft / 1000, 1e-3), total_ms: total * 1000, prompt_tokens: promptTokens, ambient: !user, model });
        gen = null;
        return;
      }
      const prefill = i === 0, scale = prefill ? 9 : 1;
      const head = { node: SELF, pre_ms: jitter(5 * scale), post_ms: jitter(2.2) };
      head.compute_ms = head.pre_ms + head.post_ms;
      const stages = [head];
      let wait = head.compute_ms;
      for (const [node, lo, hi] of route) {
        const cm = jitter((hi - lo) * 0.45 * scale);
        const net = node === SELF ? 0 : jitter(peers.find(p => p.name === node)?.rtt || 15, 0.3);
        stages.push({ node: "network", compute_ms: net }, { node, compute_ms: cm });
        wait += net + cm;
        const p = peers.find(x => x.name === node);
        if (p) { p.counters.tokens += prefill ? promptTokens : 1; p.counters.requests++; }
      }
      counters.tokens += prefill ? promptTokens : 1; counters.gen++;
      if (prefill) { t0 = performance.now(); ttft = wait; }
      T(() => {
        if (!running || gen !== g) return;
        ev("token", { index: i, text: words[i], token: 1000 + i });
        ev("token_timing", { index: i, prefill, bytes: 4096, stages, route, model });
        i++;
        step();
      }, Math.max(16, wait));
    };
    step();
  }
  offs.push(on("demo:chat", ({ prompt, model }) => {
    if (!running) return;
    if (gen && !gen.user) gen = null; // the user's prompt pre-empts ambient traffic
    const pick = /code|python|function|script/i.test(prompt) ? ANSWERS[1] : /memory|ram|unified/i.test(prompt) ? ANSWERS[2] : /latency|fast|slow|network|hop/i.test(prompt) ? ANSWERS[3] : ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    T(() => generate(pick, true, model || QWEN), 250);
  }));
  // ambient traffic so the graph shows pulses (another app on this Mac calling the swarm)
  I(() => {
    if (!settings.demoAutoplay || gen || state.chat.busy || !state.ready || document.hidden) return;
    generate(ANSWERS[Math.floor(Math.random() * ANSWERS.length)].slice(0, 220), false);
  }, 9000);
  T(() => feed("demo", `Demo Mode: ${P.label}`, P.hint, "info"), 50);
  commit();
}

export function stopDemo() {
  running = false; gen = null;
  timers.forEach(id => { clearTimeout(id); clearInterval(id); });
  timers = [];
  offs.forEach(f => f()); offs = [];
}
