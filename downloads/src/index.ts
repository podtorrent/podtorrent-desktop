// <your domain>/download — serves builds from R2. Download names follow one standard (src/builds.json):
//   <os>-<arch>[-<gpu stack>][-headless]: macos-arm64, macos-arm64-headless, windows-x64-cuda, linux-x64-cuda,
//   linux-x64-rocm, linux-x64-rocm-headless, linux-arm64-jetson-headless. Files: podtorrent-<version>-<name>.<ext>.
//   /download                        page with the latest builds and notes
//   /download/<name>                 latest build (also /download/<name>.<ext>, a file name for plain wget)
//   /download/<name>.sha256          its SHA-256, "<hash>  <file>" (for the installers)
//   /download/v/<version>/<name>     a specific build
//   /install.sh                      installer for macOS and Linux (desktop or headless); /download/install.sh too
//   /install.ps1                     installer for Windows; /download/install.ps1 too
//   /download/latest.json            manifest
//   /download/guide                  how to use the app, with screenshots
// Older names (mac, windows, linux, linux-amd, linux-amd-cli) keep working everywhere a name does.

import installSh from "../../install/install.sh";
import installPs1 from "../../install/install.ps1";
import standard from "./builds.json";

interface Env {
  RELEASES: R2Bucket;
}

type Build = { key: string; file: string; sha256: string; size: number };
type Release = { version: string; date: string; notes: string } & Partial<Record<Manifest, Build>>;

const PLATFORMS = ["mac", "windows", "linux", "linux-amd", "linux-amd-cli", "mac-cli"] as const;   // cards on the page
type Platform = (typeof PLATFORMS)[number];
type Manifest = Platform;
type Spec = { manifest: Manifest; ext: string; legacy: string[]; label: string };
const BUILDS = standard.builds as Record<string, Spec>;
// Every name a URL may use (standard or legacy) -> its standard name.
const NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(BUILDS).flatMap(([name, b]) => [[name, name], ...b.legacy.map((l) => [l, name])]),
);
const SLUG = Object.fromEntries(Object.entries(BUILDS).map(([name, b]) => [b.manifest, name])) as Record<Manifest, string>;

// /download/<name>[.<ext>|.sha256], or /download/v/<version>/<name>: the build and how to serve it.
function parse(path: string): { name: string; version?: string; sha: boolean } | null {
  const m = path.match(/^\/download\/(?:v\/([\w.-]+)\/)?([a-z0-9-]+)(\.[\w.]+)?$/);
  if (!m || !NAMES[m[2]]) return null;
  const name = NAMES[m[2]], suffix = m[3];
  if (suffix && suffix !== ".sha256" && suffix !== `.${BUILDS[name].ext}`) return null;
  return { name, version: m[1], sha: suffix === ".sha256" };
}

const text = (body: string | null, type = "text/plain; charset=utf-8") =>
  new Response(body, { headers: { "content-type": type, "cache-control": "no-cache" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "");
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const head = req.method === "HEAD";

    if (path === "/download/latest.json") {
      const obj = await env.RELEASES.get("latest.json");
      if (!obj) return new Response("No release yet", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": "application/json", "cache-control": "no-cache", "access-control-allow-origin": "*" },
      });
    }

    if (path === "/install.sh" || path === "/download/install.sh") return text(head ? null : withBase(installSh, origin));
    if (path === "/install.ps1" || path === "/download/install.ps1") return text(head ? null : withBase(installPs1, origin));

    const want = parse(path);
    if (want) {
      let rel: Release | null;
      if (want.version) {
        const obj = await env.RELEASES.get(`releases/v${want.version}/release.json`);
        if (!obj) return new Response("Unknown version", { status: 404 });
        rel = await obj.json<Release>();
      } else {
        rel = await latestRelease(env);
      }
      const build = rel?.[BUILDS[want.name].manifest];
      if (!build) return new Response(`No ${want.name} build${want.version ? ` for v${want.version}` : " yet"}`, { status: 404 });
      if (want.sha) return text(head ? null : `${build.sha256}  ${build.file}\n`);
      return serveBuild(env, req, build.key, build.file, !!want.version);
    }

    if (path === "/download") return page(await latestRelease(env), origin);
    if (path === "/download/guide") return guide();

    // Guide screenshots live in R2 under guide/.
    const shot = path.match(/^\/download\/guide\/([\w-]+\.jpg)$/);
    if (shot) {
      const obj = await env.RELEASES.get(`guide/${shot[1]}`);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, { headers: { "content-type": "image/jpeg", etag: obj.httpEtag, "cache-control": "public, max-age=3600" } });
    }
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

// Per-platform card content. Requirements and install steps match docs/WINDOWS_PLAN.md and LINUX_PLAN.md.
const INFO: Record<Platform, { name: string; arch: string; icon: string; needs: string[]; steps: string[] }> = {
  mac: {
    name: "macOS", arch: "Apple Silicon · .dmg",
    icon: `<path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.5-1-2.5-3.9zM14 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"/>`,
    needs: ["Apple Silicon Mac", "16 GB memory or more recommended"],
    // The app isn't notarized, so Gatekeeper reports a downloaded copy as "damaged" until the quarantine flag is cleared.
    steps: [
      "Open the <code>.dmg</code> and drag PodTorrent to Applications.",
      `Open Terminal and run this once, or macOS will say the app is damaged:<code class="cmd">xattr -dr com.apple.quarantine /Applications/PodTorrent.app</code>`,
      "Open PodTorrent from Applications.",
    ],
  },
  windows: {
    name: "Windows", arch: "x64 · NVIDIA",
    icon: `<path d="M3 5.1 10.4 4v7.1H3zm0 13.8 7.4 1.1v-7H3zm8.2 1.2L21 21.5V13h-9.8zm0-16.2V11H21V2.5z"/>`,
    needs: ["Windows 10 or 11", "NVIDIA RTX GPU, driver 570 or newer"],
    steps: [
      "Run the downloaded installer.",
      "If SmartScreen appears, choose <b>More info</b>, then <b>Run anyway</b>.",
      "Allow PodTorrent through the firewall so peers can reach this machine.",
    ],
  },
  linux: {
    name: "Linux", arch: "x64 AppImage · NVIDIA",
    icon: `<path d="M12 2c-2 0-3.2 1.7-3.2 4.2 0 1.4.3 2.3-.4 3.5C7.3 11.6 5 14 5 17c0 .8.3 1.3.7 1.6-.5.6-.9 1.4-.3 2.1.9 1 3.3.6 4.4 0 .7.2 1.5.3 2.2.3s1.5-.1 2.2-.3c1.1.6 3.5 1 4.4 0 .6-.7.2-1.5-.3-2.1.4-.3.7-.8.7-1.6 0-3-2.3-5.4-3.4-7.3-.7-1.2-.4-2.1-.4-3.5C15.2 3.7 14 2 12 2zm-1.6 4.3c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm3.2 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 9.3c.9 0 2 .6 2 1s-1.1 1.2-2 1.2-2-.8-2-1.2 1.1-1 2-1z"/>`,
    needs: ["Ubuntu 22.04 or newer (or similar)", "NVIDIA RTX GPU, driver 570 or newer"],
    steps: [
      `Make the file executable:<code class="cmd">chmod +x PodTorrent*.AppImage</code>`,
      `Run it:<code class="cmd">./PodTorrent*.AppImage</code>`,
    ],
  },
  "linux-amd": {
    name: "Linux for AMD", arch: "x64 AppImage · ROCm",
    icon: `<path d="M12 2c-2 0-3.2 1.7-3.2 4.2 0 1.4.3 2.3-.4 3.5C7.3 11.6 5 14 5 17c0 .8.3 1.3.7 1.6-.5.6-.9 1.4-.3 2.1.9 1 3.3.6 4.4 0 .7.2 1.5.3 2.2.3s1.5-.1 2.2-.3c1.1.6 3.5 1 4.4 0 .6-.7.2-1.5-.3-2.1.4-.3.7-.8.7-1.6 0-3-2.3-5.4-3.4-7.3-.7-1.2-.4-2.1-.4-3.5C15.2 3.7 14 2 12 2z"/>`,
    needs: ["Ubuntu 22.04 or newer", "AMD Ryzen AI Max / Max+ / Max PRO (Strix Halo, Radeon 8050S to 8065S)", "Linux kernel 6.14 or newer; your user in the <code>video</code> and <code>render</code> groups"],
    steps: [
      `On Ubuntu 24.04 only, install FUSE:<code class="cmd">sudo apt install libfuse2t64</code>`,
      `Make the file executable:<code class="cmd">chmod +x PodTorrent*.AppImage</code>`,
      `Run it:<code class="cmd">./PodTorrent*.AppImage</code>`,
      "Preview: the first launch measures how much of the shared memory the GPU can use.",
    ],
  },
  // The headless tarballs (headless/README.md): for a machine reached over SSH, no display.
  "linux-amd-cli": {
    name: "Linux headless", arch: "x64 CLI · ROCm · over SSH",
    icon: `<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6zm2.3 2.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L8.6 12 6.3 9.7a1 1 0 0 1 0-1.4zM12 15h5a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2z"/>`,
    needs: ["AMD Ryzen AI Max / Max+ / Max PRO (Strix Halo), no display needed", "Linux kernel 6.14 or newer; your user in the <code>video</code> and <code>render</code> groups", "About 25 GB free disk, plus the model layers you serve"],
    steps: [
      `Install (no root; checks the SHA-256):<code class="cmd">curl -fsSL @ORIGIN@/install.sh | sh -s -- --headless</code>`,
      `Set it up: checks the machine, installs PyTorch, picks layers to serve:<code class="cmd">podtorrent setup</code>`,
      `Watch it live:<code class="cmd">podtorrent top</code>`,
    ],
  },
  "mac-cli": {
    name: "macOS headless", arch: "Apple Silicon CLI · MLX · over SSH",
    icon: `<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6zm2.3 2.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L8.6 12 6.3 9.7a1 1 0 0 1 0-1.4zM12 15h5a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2z"/>`,
    needs: ["Apple Silicon machine you reach over SSH, macOS 14 or newer", "16 GB memory or more recommended", "About 2 GB free disk, plus the model layers you serve"],
    steps: [
      `Install over SSH (no root; checks the SHA-256):<code class="cmd">curl -fsSL @ORIGIN@/install.sh | sh -s -- --headless</code>`,
      `Set it up: checks the machine, installs MLX, picks layers to serve:<code class="cmd">podtorrent setup</code>`,
      `Start it at boot with nobody logged in (asks for your password once):<code class="cmd">podtorrent install-service --at-boot</code>`,
    ],
  },
};

// Shared by the download page and the guide.
const STYLE = `:root{color-scheme:light dark;--bg:#f6f8fa;--card:#fff;--fg:#0b0f14;--mut:#5b6573;--line:#dde3ea;--acc:#0097b2;--accfg:#fff;--soft:#e6f7fa}
@media (prefers-color-scheme:dark){:root{--bg:#05070b;--card:#0d1117;--fg:#e8eef4;--mut:#8b96a3;--line:#1e2630;--acc:#3ee8ff;--accfg:#05070b;--soft:#0b2a31}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:56px 16px 72px}
.hero{display:flex;align-items:center;gap:16px;margin-bottom:8px}
.logo{width:56px;height:56px;flex:none}
h1{margin:0;font-size:clamp(28px,5vw,40px);line-height:1.1;letter-spacing:-.02em}
.lead{color:var(--mut);max-width:640px;margin:12px 0 0}
.rel{display:inline-block;margin-top:16px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start;margin:32px 0 16px}
@media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:color-mix(in srgb,var(--acc) 40%,var(--line))}
.card.me{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 14%,transparent)}
.head{display:flex;align-items:center;gap:10px}
.os{width:30px;height:30px;flex:none;padding:6px;border-radius:8px;background:var(--soft);color:var(--acc)}
.ttl{min-width:0}
h2{margin:0;font-size:15px;line-height:1.25;font-weight:600;letter-spacing:-.005em}
.arch{margin:1px 0 0;color:var(--mut);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{display:none;margin-left:auto;white-space:nowrap;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--soft);color:var(--acc)}
.card.me .tag{display:inline-block}
.row{display:flex;align-items:center;gap:10px;margin-top:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;background:var(--fg);color:var(--bg);text-decoration:none;font-size:13.5px;font-weight:600;white-space:nowrap;transition:opacity .15s}
.card.me .btn{background:var(--acc);color:var(--accfg)}
.btn:hover{opacity:.88}.btn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.btn.off{background:transparent;border:1px dashed var(--line);color:var(--mut);font-weight:500}
.ic{width:15px;height:15px}
.meta{margin:0;color:var(--mut);font-size:12px;line-height:1.35;min-width:0}
.more{margin-top:12px;border-top:1px solid var(--line)}
.more summary{display:flex;align-items:center;justify-content:space-between;padding-top:10px;list-style:none;cursor:pointer;font-size:12.5px;font-weight:500;color:var(--mut);user-select:none}
.more summary::-webkit-details-marker{display:none}
.more summary:hover{color:var(--fg)}.more summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
.chev{width:14px;height:14px;transition:transform .2s}
.more[open] .chev{transform:rotate(180deg)}
.more[open] summary{color:var(--fg)}
.body{padding-top:12px}
.more::details-content{block-size:0;overflow-y:clip;transition:block-size .22s ease,content-visibility .22s allow-discrete}
.more[open]::details-content{block-size:auto}
:root{interpolate-size:allow-keywords}
.label{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.label+*{margin-bottom:14px}
ul{margin:0;padding-left:18px;color:var(--mut);font-size:14px}
.needs{font-size:13px;padding-left:16px}.needs li+li{margin-top:3px}
.steps{list-style:none;margin:0;padding:0;counter-reset:s;font-size:13px;color:var(--mut)}
.steps li{position:relative;padding-left:26px;counter-increment:s;min-height:18px}
.steps li+li{margin-top:10px}
.steps li::before{content:counter(s);position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;background:var(--soft);color:var(--acc);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.steps b{color:var(--fg)}
code{font:12.5px ui-monospace,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:5px;white-space:nowrap}
code.cmd{display:block;white-space:normal;margin-top:6px;padding:7px 9px;color:var(--fg);word-break:normal;overflow-wrap:anywhere;user-select:all}
.links{margin-top:12px;font-size:13px}
h3{font-size:18px;margin:0 0 8px}
pre{white-space:pre-wrap;font:inherit;color:var(--mut);margin:0}
.notes,.how{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin-top:16px}
.how p{margin:0;color:var(--mut)}
footer{margin-top:40px;color:var(--mut);font-size:13px}
a{color:var(--acc)}
.guide-link{display:flex;align-items:center;gap:16px;color:inherit;text-decoration:none}
.guide-link:hover{border-color:var(--acc)}.guide-link:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
.go{margin-left:auto;font-size:24px;color:var(--acc)}
.back{display:inline-block;margin-bottom:24px;font-size:14px;text-decoration:none}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 8px;padding:0;list-style:none}
.toc a{display:block;padding:4px 12px;border:1px solid var(--line);border-radius:999px;font-size:14px;text-decoration:none;color:var(--mut)}
.toc a:hover{color:var(--acc);border-color:var(--acc)}
.step{margin-top:48px;scroll-margin-top:16px}
.step h2{font-size:24px;letter-spacing:-.01em;margin-bottom:8px}
.step p,.step li{color:var(--mut);max-width:720px}.step b{color:var(--fg)}
.step ul,.step ol{font-size:16px;padding-left:22px;margin:8px 0}
figure{margin:20px 0 0}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:12px}
figcaption{margin-top:8px;color:var(--mut);font-size:13px}
.tip{border-left:3px solid var(--acc);background:var(--card);padding:10px 14px;border-radius:0 8px 8px 0;margin:16px 0 0;font-size:14px;color:var(--mut);max-width:720px}
`;
const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#3ee8ff"/><stop offset=".6" stop-color="#3ee8ff" stop-opacity=".35"/><stop offset="1" stop-color="#3ee8ff" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" rx="14" fill="#05070b"/><circle cx="32" cy="32" r="21" fill="none" stroke="#3ee8ff" stroke-opacity=".45" stroke-width="2"/><circle cx="32" cy="32" r="16" fill="url(#g)"/><circle cx="32" cy="32" r="5" fill="#eaffff"/></svg>`;

function page(rel: Release | null, origin: string): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const mb = (b: Build) => `${(b.size / 1e6).toFixed(0)} MB`;
  // A platform's latest build can be older than the release (Mac builds aren't made in CI).
  const ver = (b: Build) => b.key.match(/^releases\/v([^/]+)\//)?.[1] ?? rel!.version;
  const svg = (d: string, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;
  const dl = `<path d="M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4l3.3 3.3V4a1 1 0 0 1 1-1zM5 19h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2z"/>`;
  const chev = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const card = (p: Platform) => {
    const i = INFO[p], b = rel?.[p];
    const action = b
      ? `<a class="btn" href="/download/${SLUG[p]}">${svg(dl, "ic")}Download</a>
         <p class="meta">v${esc(ver(b))} · ${mb(b)}</p>`
      : `<span class="btn off">Coming soon</span><p class="meta">No build yet</p>`;
    return `<section class="card" data-os="${p}">
      <div class="head">${svg(i.icon, "os")}<div class="ttl"><h2>${i.name}</h2><p class="arch">${i.arch}</p></div><span class="tag">Your system</span></div>
      <div class="row">${action}</div>
      <details class="more"><summary>Requirements &amp; setup${chev}</summary><div class="body">
        <p class="label">Requirements</p><ul class="needs">${i.needs.map((n) => `<li>${n}</li>`).join("")}</ul>
        <p class="label">Install</p><ol class="steps">${i.steps.map((n) => `<li>${n}</li>`).join("")}</ol>
      </div></details>
    </section>`;
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Download PodTorrent</title>
<meta name="description" content="Download PodTorrent for macOS, Windows and Linux (desktop or headless).">
<style>
${STYLE}</style></head><body><main>
<div class="hero">${LOGO}
<h1>Download PodTorrent</h1></div>
<p class="lead">Run large language models together. Each machine holds a slice of the model's layers, and peers on macOS, Windows and Linux join the same chains over the internet.</p>
${rel ? `<span class="rel">Latest release v${esc(rel.version)} · ${esc(rel.date)}</span>` : ""}
<div class="grid">${PLATFORMS.map(card).join("")}</div>
<section class="how"><h3>Install from a terminal</h3>
<p>macOS and Linux: picks the right build for this machine (desktop app, or over SSH the headless build for Apple Silicon or AMD Ryzen AI Max), checks it and installs it. Run it again to update.</p>
<code class="cmd">curl -fsSL @ORIGIN@/install.sh | sh</code>
<p style="margin-top:12px">Windows (PowerShell):</p>
<code class="cmd">irm @ORIGIN@/install.ps1 | iex</code>
<p class="links">Direct links: ${Object.keys(BUILDS).map((n) => `<a href="/download/${n}">${n}</a>`).join(" · ")}</p>
</section>
${rel?.notes ? `<div class="notes"><h3>What's new</h3><pre>${esc(rel.notes)}</pre></div>` : ""}
<div class="how"><h3>Setting up</h3><p>The first launch downloads the inference engine and its dependencies (a few GB on Windows and Linux) into your home folder. After that, pick which layers to serve and your machine joins the swarm.</p></div>
<a class="how guide-link" href="/download/guide"><div><h3>How to use PodTorrent</h3><p>A short tour with screenshots: name your machine, choose which layers it serves, see your peers, check which models can run, and chat with a model the whole swarm serves together. It also covers serving the PodTorrent network and fixing common problems.</p></div><span class="go" aria-hidden="true">→</span></a>
<footer>SHA-256 checksums: <code>/download/&lt;name&gt;.sha256</code>. Older builds: <code>/download/v/&lt;version&gt;/&lt;platform&gt;</code>.</footer>
</main>
<script>
const ua = navigator.userAgent, os = /Windows/.test(ua) ? "windows" : /Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? "mac" : /Linux/.test(ua) && !/Android/.test(ua) ? "linux" : "";
const el = os && document.querySelector('.card[data-os="' + os + '"]');
if (el) { el.classList.add("me"); el.parentNode.prepend(el); }
</script></body></html>`;
  return new Response(html.replaceAll("@ORIGIN@", origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

/** The installers download from the origin that served them: no download server is baked into the repo. */
const withBase = (script: string, origin: string) => script.replaceAll("@PODTORRENT_BASE_URL@", `${origin}/download`);

// The usage guide. Screenshots are uploaded to R2 under guide/.
function guide(): Response {
  const fig = (file: string, alt: string, cap: string) =>
    `<figure><img src="/download/guide/${file}" alt="${alt}" width="1600" height="1000" loading="lazy"><figcaption>${cap}</figcaption></figure>`;
  const steps: [string, string, string][] = [
    ["install", "1. Install", `
      <p>Get the installer for your system from the <a href="/download">download page</a>.</p>
      <ul>
        <li><b>macOS (Apple Silicon):</b> open the .dmg and drag PodTorrent to Applications. The app isn't notarized yet, so open Terminal and run this once, or macOS will say the app is damaged:
          <code class="cmd">xattr -dr com.apple.quarantine /Applications/PodTorrent.app</code></li>
        <li><b>Windows:</b> run the installer. If SmartScreen appears, choose <b>More info</b>, then <b>Run anyway</b>. When Windows asks, allow PodTorrent through the firewall so peers can reach this machine.</li>
        <li><b>Linux:</b> run <code>chmod +x PodTorrent*.AppImage</code>, then start the AppImage.</li>
      </ul>
      <p>The first launch downloads the inference engine into your home folder (a few GB on Windows and Linux), so give it a few minutes.</p>`],
    ["name", "2. Name this machine", `
      <p>On first launch, PodTorrent asks for a name. Other machines in the swarm see this name, so pick something you'll recognise, like <code>studio</code> or <code>logesh-air</code>. Leave it empty to use the hostname.</p>
      ${fig("01-name.jpg", "Welcome screen asking for a name for this machine", "The first screen: a name for this machine.")}`],
    ["serve", "3. Choose what to serve", `
      <p>A large model is split into layers, and each machine serves a slice. Pick a slice that fits this machine's memory. PodTorrent downloads only those layers, and warns you if a choice may not fit.</p>
      <ul>
        <li><b>Layers 0–23</b> or <b>24–47</b>: half of Qwen3-30B-A3B, about 8 GB. Two machines with one half each can run the whole model.</li>
        <li><b>Layers 0–11</b>: a quarter, for a smaller machine.</li>
        <li><b>Nothing for now</b>: join the swarm and chat with models other machines serve. You can serve layers later from Models.</li>
      </ul>
      <p>You can also choose where models are stored. On the last screen, click <b>Start My Node</b>.</p>
      ${fig("02-serve.jpg", "Choosing which layers this machine serves", "Pick a slice. You can change it any time.")}`],
    ["swarm", "4. See the swarm", `
      <p>The <b>Swarm</b> view shows every machine or peer online, across any network. They find each other and connect directly: there's no address to type and no VPN. Each circle shows the layers that machine serves, and arrows show tokens moving between them.</p>
      <p>A red circle is a peer that's online but can't be reached from here, for example one behind a strict NAT. Its layers don't count until it's reachable.</p>
      ${fig("03-swarm.jpg", "Swarm view with a graph of connected peers", "Peers online, pooled memory and throughput, and the network graph.")}`],
    ["models", "5. Check which models can run", `
      <p><b>Models</b> lists each model in the swarm with a bar of its layers. A model is <b>Ready to use</b> once every layer has a reachable machine serving it. A gap shows which layers still need a peer.</p>
      <p>To fill a gap, serve those layers on this machine, or ask another machine to. <b>Find models</b> at the bottom lets you add other supported models.</p>
      ${fig("04-models.jpg", "Models view showing layer coverage for two models", "Each layer range and who serves it. Green means served.")}`],
    ["chat", "6. Chat with the swarm", `
      <p>Open <b>Playground</b>, pick a ready model, and type a message. Your prompt passes through each machine's layers in turn, and the answer streams back to you.</p>
      <p>Under each reply you'll see its speed, time to first token, and the <b>route</b> it took. <b>Token trace</b> shows how long each hop took. Replies use greedy decoding, so the same prompt gives the same answer.</p>
      ${fig("05-playground.jpg", "Playground with a chat reply and its route", "A reply with its route through the swarm. The sidebar shows which peers serve each layer.")}`],
    ["node", "7. Manage your machine", `
      <p><b>My Node</b> shows what this machine contributes: memory in use, layers served, tokens processed and requests helped. Use <b>Serve text layers…</b> to add a slice, <b>Stop serving</b> to drop one, or <b>Stop node</b> to leave the swarm.</p>
      ${fig("06-node.jpg", "My Node view showing this machine's contribution", "This machine's slices and stats.")}`],
    ["network", "8. Serve the PodTorrent network (optional)", `
      <p>Once your swarm covers a whole model, it can answer requests from the PodTorrent network, and this machine's operator is paid for each one. In <b>Network</b>:</p>
      <ol>
        <li>Choose <b>Production</b> or <b>Staging</b>.</li>
        <li>Enter your approved <b>node id</b> and <b>node token</b>.</li>
        <li>Set your price per million input and output tokens.</li>
        <li>Click <b>Join Network</b>. PodTorrent stays joined across restarts, and <b>Dashboard</b> opens your node's page.</li>
      </ol>
      <p>Every machine on a request's route sees that request's intermediate model state.</p>`],
    ["help", "Troubleshooting", `
      <ul>
        <li><b>macOS says PodTorrent is damaged:</b> run the <code>xattr</code> command from step 1.</li>
        <li><b>A peer shows as not reachable:</b> its network blocks direct connections (often a strict NAT or firewall). On Windows, make sure PodTorrent is allowed through the firewall. Try another network if it persists.</li>
        <li><b>A model never becomes ready:</b> open Models and look for the gap. Some machine has to serve those layers.</li>
        <li><b>A slice won't download:</b> it was too big for this machine's memory. Choose a smaller range.</li>
        <li><b>Keep machines awake</b> while serving, or their layers drop out of the swarm.</li>
      </ul>`],
  ];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Using PodTorrent</title>
<meta name="description" content="How to install PodTorrent, serve layers of a model, and chat with the swarm.">
<style>
${STYLE}</style></head><body><main>
<a class="back" href="/download">← Download PodTorrent</a>
<div class="hero">${LOGO}<h1>Using PodTorrent</h1></div>
<p class="lead">PodTorrent lets machines on different networks run one large language model together. Each machine serves a slice of the model's layers, and every token hops between them. Here's how to get set up and start chatting.</p>
<ul class="toc">${steps.map(([id, t]) => `<li><a href="#${id}">${t.replace(/^\d+\. /, "")}</a></li>`).join("")}</ul>
${steps.map(([id, t, body]) => `<section class="step" id="${id}"><h2>${t}</h2>${body}</section>`).join("\n")}

</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
