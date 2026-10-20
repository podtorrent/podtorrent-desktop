// Video route as a chain: encoder hops → the machine that renders → back to you.
// With a running job, the stage it's in lights up. Used by the Video and Swarm views.
import { h, fmt } from "../dom.js";

/** The node a running swarm job is at: "enc:<i>", "video", "back", or null. Details look like "<machine>: …". */
export function activeStage(job, route) {
  if (!job || !route) return null;
  if (job.state === "encoding") {
    const who = (job.detail || "").split(":")[0];
    const i = route.encoder.findIndex(([n]) => n === who);
    return `enc:${Math.max(0, i)}`;
  }
  if (job.state === "decoding" && /^Fetching/.test(job.detail || "")) return "back";
  if (["generating", "decoding", "loading", "starting", "saving"].includes(job.state)) return "video";
  return null;
}

/** Element for `route` ({encoder: [[name, lo, hi]], video}), highlighting `active` (see activeStage). */
export function videoFlow(route, active = null) {
  const step = (key, title, sub) => h(`div.vflow-node${active === key ? ".on" : ""}`, h("b.ellipsis", title), h("span.small.faint", sub));
  const arrow = () => h("span.vflow-arrow", { "aria-hidden": "true" }, "→");
  const parts = [];
  route.encoder.forEach(([n, lo, hi], i) => parts.push(step(`enc:${i}`, n, `Encoder ${fmt.layers(lo, hi)}`), arrow()));
  parts.push(step("video", route.video, "Renders"), arrow(), step("back", "You", "Video comes back"));
  return h("div.vflow", { role: "img", "aria-label": "Video route: " + [...route.encoder.map(([n, lo, hi]) => `${n} encoder layers ${lo} to ${hi - 1}`), `${route.video} renders`].join(", then ") }, ...parts);
}
