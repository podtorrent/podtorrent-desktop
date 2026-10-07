// Turn a token_timing event into an ordered route of segments (used by the graph pulses and
// the Token Trace). The real engine reports host compute, one network round trip, and one
// worker's compute. One-way latency isn't measured, so a round trip is split in half and the
// halves are flagged `approx`.

/**
 * @returns {{segments: Array<{kind:"compute"|"net", node?:string, from?:string, to?:string, ms:number, label:string, approx?:boolean}>, total:number}}
 */
export function routeOf(t, layersOf = () => null) {
  const st = t.stages || [];
  const host = st[0];
  const nets = st.filter((s, i) => i > 0 && s.node === "network");
  const workers = st.filter((s, i) => i > 0 && s.node !== "network");
  const segs = [];
  const L = n => { const r = layersOf(n); return r ? ` · layers ${r}` : ""; };
  if (!host) return { segments: [], total: 0 };
  const pre = host.pre_ms ?? null, post = host.post_ms ?? null;
  if (pre != null) segs.push({ kind: "compute", node: host.node, ms: pre, label: `${host.node} · embed${L(host.node)}` });
  else segs.push({ kind: "compute", node: host.node, ms: host.compute_ms, label: `${host.node} · layers + head (combined)` });
  if (nets.length === workers.length + 1) {
    // explicit one-way hops (Demo Mode multi-stage swarms)
    let from = host.node;
    workers.forEach((w, i) => {
      segs.push({ kind: "net", from, to: w.node, ms: nets[i].compute_ms, label: `${from} → ${w.node}` });
      segs.push({ kind: "compute", node: w.node, ms: w.compute_ms, label: `${w.node}${L(w.node)}` });
      from = w.node;
    });
    segs.push({ kind: "net", from, to: host.node, ms: nets[nets.length - 1].compute_ms, label: `${from} → ${host.node}` });
  } else {
    // real engine: each network stage is a round trip around the worker after it
    workers.forEach((w, i) => {
      const rt = nets[i]?.compute_ms ?? 0;
      segs.push({ kind: "net", from: host.node, to: w.node, ms: rt / 2, approx: true, label: `${host.node} → ${w.node}` });
      segs.push({ kind: "compute", node: w.node, ms: w.compute_ms, label: `${w.node}${L(w.node)}` });
      segs.push({ kind: "net", from: w.node, to: host.node, ms: rt / 2, approx: true, label: `${w.node} → ${host.node}` });
    });
  }
  if (post != null) segs.push({ kind: "compute", node: host.node, ms: post, label: `${host.node} · lm_head + sample` });
  return { segments: segs, total: segs.reduce((a, s) => a + s.ms, 0) };
}
