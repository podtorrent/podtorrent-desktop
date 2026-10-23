// podtorrent.com/download — serves builds from R2.
//   /download                    page with the latest Mac, Windows and Linux links and notes
//   /download/mac|windows|linux latest installer for that platform
//   /download/latest.json        manifest (also for in-app update checks)
//   /download/v/<ver>/<platform> a specific older build

interface Env {
  RELEASES: R2Bucket;
}

type Build = { key: string; file: string; sha256: string; size: number };
type Release = { version: string; date: string; notes: string; mac?: Build; windows?: Build; linux?: Build };

const PLATFORMS = ["mac", "windows", "linux"] as const;
type Platform = (typeof PLATFORMS)[number];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    if (path === "/download/latest.json") {
      const obj = await env.RELEASES.get("latest.json");
      if (!obj) return new Response("No release yet", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": "application/json", "cache-control": "no-cache", "access-control-allow-origin": "*" },
      });
    }

    const latest = path.match(/^\/download\/(mac|windows|linux)$/);
    if (latest) {
      const rel = await latestRelease(env);
      const build = rel?.[latest[1] as Platform];
      if (!rel || !build) return new Response(`No ${latest[1]} build yet`, { status: 404 });
      return serveBuild(env, req, build.key, build.file, false);
    }

    const pinned = path.match(/^\/download\/v\/([\w.-]+)\/(mac|windows|linux)$/);
    if (pinned) {
      const obj = await env.RELEASES.get(`releases/v${pinned[1]}/release.json`);
      if (!obj) return new Response("Unknown version", { status: 404 });
      const build = (await obj.json<Release>())[pinned[2] as Platform];
      if (!build) return new Response(`No ${pinned[2]} build for v${pinned[1]}`, { status: 404 });
      return serveBuild(env, req, build.key, build.file, true);
    }

    if (path === "/download") return page(await latestRelease(env));
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function latestRelease(env: Env): Promise<Release | null> {
  const obj = await env.RELEASES.get("latest.json");
  return obj ? obj.json<Release>() : null;
}

async function serveBuild(env: Env, req: Request, key: string, file: string, immutable: boolean): Promise<Response> {
  const obj = req.method === "HEAD" ? await env.RELEASES.head(key) : await env.RELEASES.get(key);
  if (!obj) return new Response("Build missing", { status: 404 });
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${file}"`,
    "content-length": String(obj.size),
    etag: obj.httpEtag,
    // /download/mac must move when latest.json changes; pinned versions never change.
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  return new Response("body" in obj ? (obj as R2ObjectBody).body : null, { headers });
}

// Per-platform card content. Requirements and first-run steps match docs/WINDOWS_PLAN.md and LINUX_PLAN.md.
const INFO: Record<Platform, { name: string; arch: string; icon: string; needs: string[]; first: string }> = {
  mac: {
    name: "macOS", arch: "Apple Silicon (M1 or later)",
    icon: `<path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.5-1-2.5-3.9zM14 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"/>`,
    needs: ["Apple Silicon Mac", "16 GB memory or more recommended"],
    first: "Open the .dmg and drag PodTorrent to Applications. The first time, right-click the app and choose Open.",
  },
  windows: {
    name: "Windows", arch: "x64",
    icon: `<path d="M3 5.1 10.4 4v7.1H3zm0 13.8 7.4 1.1v-7H3zm8.2 1.2L21 21.5V13h-9.8zm0-16.2V11H21V2.5z"/>`,
    needs: ["Windows 10 or 11", "NVIDIA RTX GPU, driver 570 or newer"],
    first: "If SmartScreen appears, choose More info, then Run anyway. Allow PodTorrent through the firewall so peers can reach this machine.",
  },
  linux: {
    name: "Linux", arch: "x64 AppImage",
    icon: `<path d="M12 2c-2 0-3.2 1.7-3.2 4.2 0 1.4.3 2.3-.4 3.5C7.3 11.6 5 14 5 17c0 .8.3 1.3.7 1.6-.5.6-.9 1.4-.3 2.1.9 1 3.3.6 4.4 0 .7.2 1.5.3 2.2.3s1.5-.1 2.2-.3c1.1.6 3.5 1 4.4 0 .6-.7.2-1.5-.3-2.1.4-.3.7-.8.7-1.6 0-3-2.3-5.4-3.4-7.3-.7-1.2-.4-2.1-.4-3.5C15.2 3.7 14 2 12 2zm-1.6 4.3c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm3.2 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 9.3c.9 0 2 .6 2 1s-1.1 1.2-2 1.2-2-.8-2-1.2 1.1-1 2-1z"/>`,
    needs: ["Ubuntu 22.04 or newer (or similar)", "NVIDIA RTX GPU, driver 570 or newer"],
    first: "Make it executable with <code>chmod +x PodTorrent*.AppImage</code>, then run it.",
  },
};

function page(rel: Release | null): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const mb = (b: Build) => `${(b.size / 1e6).toFixed(0)} MB`;
  // A platform's latest build can be older than the release (Mac builds aren't made in CI).
  const ver = (b: Build) => b.key.match(/^releases\/v([^/]+)\//)?.[1] ?? rel!.version;
  const svg = (d: string, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;
  const dl = `<path d="M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4l3.3 3.3V4a1 1 0 0 1 1-1zM5 19h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2z"/>`;
  const card = (p: Platform) => {
    const i = INFO[p], b = rel?.[p];
    const action = b
      ? `<a class="btn" href="/download/${p}">${svg(dl, "ic")}<span>Download for ${i.name}</span></a>
         <p class="meta">v${esc(ver(b))} · ${mb(b)} · <span title="SHA-256: ${b.sha256}">SHA-256 ${b.sha256.slice(0, 12)}…</span></p>`
      : `<span class="btn off">Coming soon</span><p class="meta">No ${i.name} build yet</p>`;
    return `<section class="card" data-os="${p}">
      <div class="head">${svg(i.icon, "os")}<div><h2>${i.name}</h2><p class="arch">${i.arch}</p></div><span class="tag">Your system</span></div>
      ${action}
      <ul>${i.needs.map((n) => `<li>${n}</li>`).join("")}</ul>
      <p class="first"><b>First run:</b> ${i.first}</p>
    </section>`;
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Download PodTorrent</title>
<meta name="description" content="Download PodTorrent for macOS, Windows and Linux.">
<style>
:root{color-scheme:light dark;--bg:#f6f8fa;--card:#fff;--fg:#0b0f14;--mut:#5b6573;--line:#dde3ea;--acc:#0097b2;--accfg:#fff;--soft:#e6f7fa}
@media (prefers-color-scheme:dark){:root{--bg:#05070b;--card:#0d1117;--fg:#e8eef4;--mut:#8b96a3;--line:#1e2630;--acc:#3ee8ff;--accfg:#05070b;--soft:#0b2a31}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:56px 16px 72px}
.hero{display:flex;align-items:center;gap:16px;margin-bottom:8px}
.logo{width:56px;height:56px;flex:none}
h1{margin:0;font-size:clamp(28px,5vw,40px);line-height:1.1;letter-spacing:-.02em}
.lead{color:var(--mut);max-width:640px;margin:12px 0 0}
.rel{display:inline-block;margin-top:16px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:16px;margin:40px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:14px}
.card.me{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.head{display:flex;align-items:center;gap:12px}
.os{width:32px;height:32px;flex:none}
h2{margin:0;font-size:20px}.arch{margin:0;color:var(--mut);font-size:14px}
.tag{display:none;margin-left:auto;font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--soft);color:var(--acc)}
.card.me .tag{display:inline-block}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px;border-radius:10px;background:var(--acc);color:var(--accfg);text-decoration:none;font-weight:600}
.btn:hover{filter:brightness(1.08)}.btn:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
.btn.off{background:transparent;border:1px dashed var(--line);color:var(--mut);font-weight:500}
.ic{width:18px;height:18px}
.meta{margin:-6px 0 0;text-align:center;color:var(--mut);font-size:13px}
ul{margin:0;padding-left:18px;color:var(--mut);font-size:14px}
.first{margin:auto 0 0;padding-top:12px;border-top:1px solid var(--line);font-size:14px;color:var(--mut)}
.first b{color:var(--fg)}
code{font:13px ui-monospace,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:5px;word-break:break-all}
h3{font-size:18px;margin:0 0 8px}
pre{white-space:pre-wrap;font:inherit;color:var(--mut);margin:0}
.notes,.how{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin-top:16px}
.how p{margin:0;color:var(--mut)}
footer{margin-top:40px;color:var(--mut);font-size:13px}
</style></head><body><main>
<div class="hero"><svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#3ee8ff"/><stop offset=".6" stop-color="#3ee8ff" stop-opacity=".35"/><stop offset="1" stop-color="#3ee8ff" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" rx="14" fill="#05070b"/><circle cx="32" cy="32" r="21" fill="none" stroke="#3ee8ff" stroke-opacity=".45" stroke-width="2"/><circle cx="32" cy="32" r="16" fill="url(#g)"/><circle cx="32" cy="32" r="5" fill="#eaffff"/></svg>
<h1>Download PodTorrent</h1></div>
<p class="lead">Run large language models together. Each machine holds a slice of the model's layers, and peers on macOS, Windows and Linux join the same chains over the internet.</p>
${rel ? `<span class="rel">Latest release v${esc(rel.version)} · ${esc(rel.date)}</span>` : ""}
<div class="grid">${PLATFORMS.map(card).join("")}</div>
${rel?.notes ? `<div class="notes"><h3>What's new</h3><pre>${esc(rel.notes)}</pre></div>` : ""}
<div class="how"><h3>Setting up</h3><p>The first launch downloads the inference engine and its dependencies (a few GB on Windows and Linux) into your home folder. After that, pick which layers to serve and your machine joins the swarm.</p></div>
<footer>Hover a checksum to see the full SHA-256. Older builds: <code>/download/v/&lt;version&gt;/&lt;platform&gt;</code>.</footer>
</main>
<script>
const ua = navigator.userAgent, os = /Windows/.test(ua) ? "windows" : /Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? "mac" : /Linux/.test(ua) && !/Android/.test(ua) ? "linux" : "";
const el = os && document.querySelector('.card[data-os="' + os + '"]');
if (el) { el.classList.add("me"); el.parentNode.prepend(el); }
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
