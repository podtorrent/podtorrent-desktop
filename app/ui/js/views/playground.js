// Playground: streaming chat with model picker, inspector (⌘I), live tok/s and Token Trace.
import { h, text, fmt, reconcile, cls } from "../dom.js";
import { state, settings, setSetting, models, commit, on } from "../store.js";
import { button, iconButton, slider, empty, kbd, popover } from "../ui.js";
import { icon } from "../icons.js";
import { modelStrip } from "../viz/strip.js";
import { tokenTrace } from "../viz/trace.js";
import { renderMarkdown } from "../markdown.js";
import { sendPrompt } from "../engine.js";
import { go, copyText, actions } from "../actions.js";
import { openServe } from "../serve.js";
import { routeText } from "./models.js";

const SUGGEST = [
  "Explain pipeline parallelism in three sentences.",
  "Write a Python function that measures tokens per second.",
  "Why does unified memory matter for running big models on a Mac?",
  "What does the network hop cost per token?",
];

let pickedModel = null;
on("pick-model", id => { pickedModel = id; commit(); });

export default {
  title: "Playground",
  subtitle: s => { const m = current(s); return m ? m.name : ""; },
  toolbar() {
    return [iconButton("sliders", "Toggle inspector", () => { setSetting("inspector", !settings.inspector); }, { kbd: "⌘I" })];
  },
  mount(root) {
    // ---- model picker ----
    const pickStrip = modelStrip({ compact: true });
    const pickName = h("b"), pickBadge = h("span.badge.dot");
    const picker = h("button.model-picker", { type: "button", "aria-haspopup": "listbox" }, h("div.row", pickName, pickBadge, h("span.spacer"), icon("chevdown")), pickStrip);
    const pop = popover();
    pop.el.classList.add("picker-pop");
    picker.onclick = e => {
      e.stopPropagation();
      if (pop.el.classList.contains("show")) return pop.hide();
      const r = picker.getBoundingClientRect();
      const avail = models(state).filter(m => m.runnable);
      pop.show(h("div.col", { role: "listbox", style: { gap: "4px" } }, avail.length ? avail.map(m => {
        const st = modelStrip({ compact: true });
        const item = h("button.pick-item", { type: "button", role: "option", "aria-selected": String(current(state)?.id === m.id), onclick: () => { pickedModel = m.id; pop.hide(); commit(); } },
          h("div.row", h("b", m.name), h("span.spacer"), h(`span.badge.${m.runnable ? "serving" : m.verdict.level === "gap" ? "gap" : "neutral"}`, m.runnable ? "Ready" : m.verdict.title)), st,
          !m.runnable ? h("div.small.faint", m.verdict.reason) : null);
        requestAnimationFrame(() => st.set(m));
        return item;
      }) : h("div.small.muted", { style: { padding: "8px" } }, "No model is available right now. See Models.")), r.left - 14, r.bottom - 10);
    };
    const closePick = e => { if (!pop.el.contains(e.target)) pop.hide(); };
    document.addEventListener("pointerdown", closePick);

    // ---- chat ----
    const log = h("div.chat-log", { role: "log", "aria-live": "polite" });
    const scroller = h("div.chat-scroll", log);
    const intro = h("div.chat-intro",
      h("div.art", icon("sparkle")), h("h2", "Ask the swarm"),
      h("p.muted", "Your prompt is tokenized on this Mac, hops through each peer that serves a slice of the model, and streams back token by token. Each reply shows the route it took."),
      h("div.suggest", SUGGEST.map(t => h("button.suggest-btn", { type: "button", onclick: () => send(t) }, t))));
    const blocked = h("div.chat-blocked");
    const ta = h("textarea.composer-input", { rows: 1, placeholder: "Message the swarm…", "aria-label": "Prompt" });
    const sendBtn = h("button.send-btn", { type: "button", "aria-label": "Send", "data-tip": "Send  ↵" }, icon("send"));
    const stopBtn = h("button.send-btn.stop", { type: "button", "aria-label": "Stop", "data-tip": "The engine can't cancel a running generation yet", disabled: true }, icon("stop"));
    const meter = h("div.meter", h("span.statedot.active"), h("b.num.mv", "0.0"), h("span", "tok/s"), h("span.faint.num.mt"));
    const composer = h("div.composer", h("div.composer-box", ta, stopBtn, sendBtn), h("div.composer-f.small.faint", meter, h("span.spacer"), h("span.hint", "Single-turn · greedy decoding · ", kbd("↵"), " send, ", kbd("⇧ ↵"), " newline")));
    const inUse = h("div.chat-inuse.small", { role: "status" }, h("span.statedot.active"), h("span", "Another Mac is using the model too. Replies share it, so they may stream slower."));
    const chat = h("div.chat", h("div.chat-top", picker), scroller, intro, blocked, inUse, composer);

    // ---- inspector ----
    const maxL = h("b.num");
    const sl = slider({ min: 16, max: 1024, step: 16, value: settings.maxTokens, label: "Max tokens", oninput: v => { text(maxL, v); setSetting("maxTokens", v); } });
    text(maxL, settings.maxTokens);
    const insStrip = modelStrip();
    const insVerdict = h("div.small.muted");
    const inspector = h("aside.inspector",
      h("div.ins-sec", h("div.caps", "Model"), h("b.ins-name"), insStrip, insVerdict),
      h("div.ins-sec", h("div.row", h("span.caps", "Max tokens"), h("span.spacer"), maxL), sl, h("div.small.faint", "Generation stops at this length or at end-of-sequence.")),
      h("div.ins-sec", h("div.caps", "Sampling"), h("div.row.small", h("span", "Decoding"), h("span.spacer"), h("span.badge.neutral", "Greedy")),
        h("div.small.faint", "The engine always picks the most likely token, so the same prompt gives the same answer. Temperature and top-p aren't supported yet.")),
      h("div.ins-sec", h("div.caps", "Session"), h("div.kv-list.small", h("span.faint", "Replies"), h("b.num.ns"), h("span.faint", "Median first token"), h("b.num.nt"), h("span.faint", "Last reply"), h("b.num.nl"))));
    const wrap = h("div.play", chat, inspector);
    root.append(wrap);
    let stick = true;
    scroller.addEventListener("scroll", () => { stick = scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 40; });

    function send(t) {
      const m = current(state);
      if (!m?.runnable || state.chat.busy) return;
      stick = true;
      sendPrompt(t ?? ta.value, m.model);
      ta.value = ""; grow();
    }
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    sendBtn.onclick = () => send();
    log.addEventListener("click", e => {
      const b = e.target.closest(".copy-code");
      if (b) copyText(b.closest(".code").querySelector("code").textContent, "Code copied");
    });

    function makeMsg(m) {
      if (m.role === "user") return h("div.msg.user", h("div.msg-body.selectable"));
      const body = h("div.msg-body.md.selectable");
      const meta = h("div.msg-meta",
        h("span.num.mm"), h("span.spacer"),
        iconButton("copy", "Copy as Markdown", () => copyText(m.text, "Copied as Markdown"), { size: "sm" }),
        iconButton("refresh", "Regenerate", () => { if (!state.chat.busy) send(m.prompt); }, { size: "sm" }));
      const det = h("details.trace-wrap", h("summary", icon("trace"), "Token trace", h("span.faint.ts")));
      det.addEventListener("toggle", () => { if (det.open) { if (!det._t) { det._t = tokenTrace(m); det.append(det._t); } else det._t.update(); } });
      return h("div.msg.assistant", h("div.avatar", icon("swarm")), h("div.grow", body, meta, h("div.small.faint.mroute", { style: { margin: "2px 0 6px" } }), det));
    }
    function fillMsg(el, m) {
      const body = el.querySelector(".msg-body");
      if (m.role === "user") { text(body, m.text); return; }
      const key = m.text.length + m.status;
      if (body.dataset.k !== key) {
        body.dataset.k = key;
        if (m.status === "pending") body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
        else if (m.status === "error" && !m.text) body.innerHTML = "";
        else body.innerHTML = renderMarkdown(m.text, m.status === "streaming");
        if (m.status === "error") body.append(h("div.msg-err", icon("alert"), m.error || "Generation failed"));
      }
      const d = m.done;
      text(el.querySelector(".mm"), d ? `${d.tokens} tokens · ${fmt.fixed(d.tok_s)} tok/s · first token ${fmt.ms(d.ttft_ms)}` : m.status === "streaming" ? `${m.tokens} tokens…` : "");
      const routes = [...new Set(m.timings.map(t => JSON.stringify(t.route || [])))].map(r => JSON.parse(r)).filter(r => r.length);
      const rt = routes.map(r => routeText(r, state.self)).join("  ⟶ re-routed: ");
      text(el.querySelector(".mroute"), rt ? `Route: ${rt}` : "");
      el.querySelector(".mroute").dataset.tip = routes.length > 1 ? "A peer failed mid-answer; the reply re-routed and kept the tokens so far" : "";
      el.querySelector(".msg-meta").hidden = m.status === "pending";
      const det = el.querySelector(".trace-wrap");
      det.hidden = !m.timings.length;
      text(det.querySelector(".ts"), m.timings.length ? ` · ${(m.timings[0].route || []).length || new Set(m.timings[0].stages.filter(x => x.node !== "network").map(x => x.node)).size} hops` : "");
      const tk = m.timings.length + m.status;
      if (det.open && det._t && det._k !== tk && (m.status !== "streaming" || m.timings.length % 8 === 0)) { det._k = tk; det._t.update(); }
    }

    let blockKey = "";
    return {
      update(s) {
        const ms = models(s), m = current(s);
        cls(wrap, "no-inspector", !settings.inspector);
        // picker
        picker.hidden = !m;
        if (m) {
          text(pickName, m.name);
          pickBadge.className = `badge dot ${m.runnable ? "serving" : m.verdict.level === "gap" ? "gap" : "neutral"}`;
          text(pickBadge, m.runnable ? "Ready" : m.verdict.title);
          pickStrip.set(m, s.self);
          text(inspector.querySelector(".ins-name"), m.name);
          insStrip.set(m, s.self); text(insVerdict, m.verdict.reason);
        }
        picker.disabled = ms.filter(x => x.runnable).length < 2;
        // blocked / empty states
        const ok = !!m?.runnable;
        const k = `${ok}|${m?.id}|${m?.verdict.title}|${s.engine.phase}|${s.source}`;
        if (k !== blockKey) {
          blockKey = k;
          const gap = m?.gaps?.[0];
          if (ok) blocked.replaceChildren();
          else if (s.source === "live" && s.engine.phase !== "running") blocked.replaceChildren(empty({ icon: "playground", title: "Start your node to chat", body: "This Mac joins the swarm and can then talk to any model the swarm covers, even if it serves nothing itself.", actions: [button("Start My Node", { variant: "primary", icon: "play", onclick: actions.startHost })] }));
          else if (!m) blocked.replaceChildren(empty({ icon: "playground", title: "No model to talk to yet", body: "Nobody online serves a model yet. Serve some layers to start one.", actions: [button("Open Models", { variant: "primary", icon: "models", onclick: () => go("models") })] }));
          else blocked.replaceChildren(empty({
            icon: m.verdict.level === "gap" ? "alert" : "layers", tone: m.verdict.level === "gap" ? "gap" : "degraded",
            title: m.verdict.level === "degraded" ? `${m.name} is loading…` : `${m.name} can't run from this Mac yet`,
            body: m.verdict.reason,
            actions: [button("Open Models", { variant: gap ? "" : "primary", icon: "models", onclick: () => go("models") }),
              gap ? button("Serve missing layers", { variant: "primary", icon: "download", onclick: () => openServe({ model: m.model, lo: gap[0], hi: gap[1] }) }) : null].filter(Boolean),
          }));
        }
        blocked.hidden = !!ok;
        const msgs = s.chat.messages;
        intro.hidden = !ok || msgs.length > 0;
        scroller.hidden = !ok || !msgs.length;
        cls(composer, "disabled", !ok);
        // flag (never block) when another Mac's prompt is running: replies may stream slower
        const other = othersTurn(s);
        inUse.hidden = !ok || !other;
        ta.disabled = !ok; sendBtn.disabled = !ok || s.chat.busy;
        stopBtn.hidden = !s.chat.busy; sendBtn.hidden = s.chat.busy;
        reconcile(log, msgs, x => x.id, makeMsg, fillMsg);
        // live meter
        const last = msgs[msgs.length - 1];
        const streaming = last?.role === "assistant" && last.status === "streaming";
        cls(meter, "on", streaming);
        if (streaming && last.firstAt) {
          const sec = (performance.now() - last.firstAt) / 1000;
          text(meter.querySelector(".mv"), fmt.fixed(sec > 0.2 ? (last.tokens - 1) / sec : 0));
          text(meter.querySelector(".mt"), `· ${last.tokens} tokens`);
        }
        if (stick && msgs.length) scroller.scrollTop = scroller.scrollHeight;
        // session stats
        text(inspector.querySelector(".ns"), s.ttfts.length);
        const sorted = [...s.ttfts].sort((a, b) => a - b);
        text(inspector.querySelector(".nt"), sorted.length ? fmt.ms(sorted[sorted.length >> 1]) : "–");
        const lastDone = [...msgs].reverse().find(x => x.done)?.done;
        text(inspector.querySelector(".nl"), lastDone ? `${fmt.fixed(lastDone.tok_s)} tok/s` : "–");
      },
      focus() { ta.focus(); },
      unmount() { document.removeEventListener("pointerdown", closePick); pop.el.remove(); },
    };
  },
};

/** True while this peer is generating for another window or app (it never says who, or what). Info only. */
function othersTurn(s) {
  return !!s.chat.session && !s.chat.busy;
}

/** The picked model while it's available, else the first available one, else the default (to explain why not). */
function current(s) {
  const ms = models(s), avail = ms.filter(m => m.runnable);
  return avail.find(m => m.id === pickedModel) || avail[0] || ms.find(m => m.id === pickedModel) || ms[0] || null;
}
