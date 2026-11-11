// Activity: human-readable event feed, or raw engine logs (virtualized, filter, search, copy).
import { h, text, fmt } from "../dom.js";
import { state } from "../store.js";
import { segmented, empty, button } from "../ui.js";
import { icon } from "../icons.js";
import { logTail } from "../engine.js";
import { isTauri } from "../native.js";
import { copyText } from "../actions.js";

const KIND_IC = { join: "peers", lost: "wifioff", back: "wifi", load: "download", rebalance: "layers", covered: "check", generate: "sparkle", error: "alert", engine: "power", download: "download" };
const LH = 19;
let mode = "feed";
export const unseen = { n: 0, at: 0 };

function levelOf(line) {
  if (/\b(error|exception|traceback|failed|fatal)\b/i.test(line)) return "error";
  if (/\b(warn|warning|waiting|retry)\b/i.test(line)) return "warn";
  return "info";
}

export default {
  title: "Activity",
  subtitle: s => `${s.feed.length} event${s.feed.length === 1 ? "" : "s"} this session`,
  mount(root) {
    const modeSeg = segmented([{ value: "feed", label: "Events", icon: "activity" }, { value: "raw", label: "Raw logs", icon: "logs" }], mode, v => { mode = v; layout(); }, "Activity mode");
    // feed
    const feedBox = h("div.feed");
    const feedCard = h("section.card.feed-card", feedBox);
    // raw
    let lines = [], logName = "engine.log", lvl = "all", q = "";
    const fileSeg = segmented([{ value: "engine.log", label: "engine.log" }, { value: "download.log", label: "download.log" }], logName, v => { logName = v; pull(); }, "Log file");
    const lvlSeg = segmented([{ value: "all", label: "All" }, { value: "warn", label: "Warn+" }, { value: "error", label: "Errors" }], lvl, v => { lvl = v; paintRaw(); }, "Level");
    const search = h("input.input", { placeholder: "Search logs", "aria-label": "Search logs", style: { maxWidth: "220px" } });
    search.addEventListener("input", () => { q = search.value.toLowerCase(); paintRaw(); });
    const inner = h("div", { style: { position: "relative" } });
    const rawScroll = h("div.raw-scroll", inner);
    const rawCount = h("span.small.faint");
    const rawCard = h("section.card.raw-card",
      h("div.card-h", fileSeg, lvlSeg, search, h("span.spacer"), rawCount, button("Copy", { icon: "copy", size: "sm", onclick: () => copyText(filtered().join("\n"), "Logs copied") })),
      rawScroll);
    const page = h("div.page.activity", h("div.row", modeSeg, h("span.spacer"), h("span.small.faint", "~/.podtorrent/engine.log")), feedCard, rawCard);
    root.append(page);

    const filtered = () => lines.filter(l => (lvl === "all" || (lvl === "warn" ? levelOf(l) !== "info" : levelOf(l) === "error")) && (!q || l.toLowerCase().includes(q)));
    let stickRaw = true;
    rawScroll.addEventListener("scroll", () => { stickRaw = rawScroll.scrollTop + rawScroll.clientHeight > rawScroll.scrollHeight - 30; paintRaw(); });
    function paintRaw() {
      const f = filtered();
      text(rawCount, `${f.length.toLocaleString()} lines`);
      inner.style.height = f.length * LH + "px";
      if (stickRaw) rawScroll.scrollTop = rawScroll.scrollHeight;
      const top = rawScroll.scrollTop, vh = rawScroll.clientHeight || 500;
      const a = Math.max(0, Math.floor(top / LH) - 20), b = Math.min(f.length, Math.ceil((top + vh) / LH) + 20);
      const frag = [];
      for (let i = a; i < b; i++) frag.push(h(`div.ll.${levelOf(f[i])}`, { style: { top: i * LH + "px" } }, h("span.ln", i + 1), f[i]));
      inner.replaceChildren(...frag);
      if (!f.length) inner.replaceChildren(h("div.empty", { style: { padding: "40px" } }, h("p", isTauri ? (lines.length ? "No lines match." : "The log is empty. It fills when the engine starts.") : "Raw logs are available in the PodTorrent app.")));
    }
    let timer = 0;
    async function pull() {
      if (mode !== "raw" || document.hidden) return;
      const t = await logTail(logName, 3000).catch(() => null);
      if (t == null) { lines = []; paintRaw(); return; }
      const next = t ? t.split("\n") : [];
      if (next.length !== lines.length || next[next.length - 1] !== lines[lines.length - 1]) { lines = next; paintRaw(); }
    }
    function layout() {
      modeSeg.set(mode);
      feedCard.hidden = mode !== "feed"; rawCard.hidden = mode !== "raw";
      clearInterval(timer);
      if (mode === "raw") { pull(); timer = setInterval(pull, 2000); requestAnimationFrame(paintRaw); }
    }
    layout();

    let feedKey = "";
    return {
      update(s) {
        unseen.n = 0; unseen.at = s.feed.length;
        if (mode !== "feed") return;
        const k = s.feed.length + ":" + (s.feed[s.feed.length - 1]?.id || "");
        if (k === feedKey) return;
        feedKey = k;
        const items = s.feed.slice(-300).reverse();
        if (!items.length) { feedBox.replaceChildren(empty({ icon: "activity", title: "Nothing yet", body: "Peers joining and leaving, layer assignments, the model becoming fully covered, and every reply show up here." })); return; }
        feedBox.replaceChildren(...items.map(e => h(`div.ev.${e.level}`,
          h("div.ev-ic", icon(KIND_IC[e.kind] || "info")),
          h("div.grow", h("div.ev-t", e.title), e.detail ? h("div.ev-d.selectable", e.detail) : null),
          h("time.small.faint.num", { datetime: new Date(e.ts * 1000).toISOString(), title: new Date(e.ts * 1000).toLocaleString() }, fmt.time(e.ts)))));
      },
      unmount() { clearInterval(timer); },
    };
  },
};
