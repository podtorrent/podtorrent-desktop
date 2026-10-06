// Minimal, safe Markdown for model replies: fenced code (highlighted), inline code, bold,
// italics, headings, lists, paragraphs. Input is escaped first; no raw HTML passes through.
import { escapeHtml } from "./dom.js";

const KW = /\b(def|class|return|import|from|as|if|elif|else|for|while|in|not|and|or|try|except|finally|with|yield|lambda|async|await|function|const|let|var|new|this|fn|pub|struct|impl|use|mut|match|enum|type|interface|export|default|true|false|True|False|None|null|undefined|self)\b/g;

function highlight(code) {
  // tokens are found on escaped text; strings/comments first so keywords inside them stay plain
  const out = [];
  const re = /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)/g;
  let last = 0, m;
  const src = code;
  while ((m = re.exec(src))) {
    out.push(kw(src.slice(last, m.index)));
    out.push(m[1] ? `<span class="hl-c">${m[0]}</span>` : m[2] ? `<span class="hl-s">${m[0]}</span>` : `<span class="hl-n">${m[0]}</span>`);
    last = re.lastIndex;
  }
  out.push(kw(src.slice(last)));
  return out.join("");
}
const kw = s => s.replace(KW, '<span class="hl-k">$1</span>');

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

export function renderMarkdown(src, streaming = false) {
  const parts = escapeHtml(src).split(/```/);
  let html = "";
  parts.forEach((p, i) => {
    if (i % 2) {
      const nl = p.indexOf("\n");
      const lang = nl > 0 ? p.slice(0, nl).trim() : "";
      const code = nl >= 0 ? p.slice(nl + 1).replace(/\n$/, "") : p;
      html += `<div class="code"><div class="code-h"><span>${lang || "code"}</span><button class="icon-btn sm copy-code" aria-label="Copy code" data-tip="Copy code">⧉</button></div><pre><code>${highlight(code)}</code></pre></div>`;
      return;
    }
    const blocks = p.split(/\n{2,}/);
    for (const b of blocks) {
      const t = b.trim();
      if (!t) continue;
      const lines = t.split("\n");
      if (lines.every(l => /^\s*[-*] /.test(l))) html += "<ul>" + lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("") + "</ul>";
      else if (lines.every(l => /^\s*\d+\. /.test(l))) html += "<ol>" + lines.map(l => `<li>${inline(l.replace(/^\s*\d+\. /, ""))}</li>`).join("") + "</ol>";
      else if (/^#{1,4} /.test(t)) html += `<h4>${inline(t.replace(/^#+ /, ""))}</h4>`;
      else html += `<p>${inline(lines.join("<br>"))}</p>`;
    }
  });
  if (streaming) html = /<\/(p|li)>(<\/[uo]l>)?$/.test(html) ? html.replace(/<\/(p|li)>((?:<\/[uo]l>)?)$/, '<span class="caret"></span></$1>$2') : html + '<span class="caret"></span>';
  return html;
}
