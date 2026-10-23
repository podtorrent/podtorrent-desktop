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

function page(rel: Release | null): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const mb = (b: Build) => `${(b.size / 1e6).toFixed(0)} MB`;
  const link = (p: Platform, label: string) =>
    rel?.[p] ? `<a class="btn" href="/download/${p}">${label}<small>${mb(rel[p]!)}</small></a>` : "";
  const body = rel
    ? `<h1>Download PodTorrent</h1><p class="v">v${esc(rel.version)} · ${esc(rel.date)}</p>
       <div class="row">${link("mac", "macOS (Apple Silicon)")}${link("windows", "Windows (x64)")}${link("linux", "Linux (x64, AppImage)")}</div>
       ${rel.notes ? `<h2>What's new</h2><pre>${esc(rel.notes)}</pre>` : ""}`
    : `<h1>Download PodTorrent</h1><p>No build published yet.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Download PodTorrent</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--btn:#111;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--fg:#eee;--mut:#999;--btn:#eee;--btnfg:#111}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:64px 16px}
.v{color:var(--mut)}.row{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}
.btn{display:flex;flex-direction:column;padding:14px 20px;border-radius:10px;background:var(--btn);color:var(--btnfg);text-decoration:none;font-weight:600}
.btn small{font-weight:400;opacity:.7}pre{white-space:pre-wrap;font:inherit;color:var(--mut)}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
