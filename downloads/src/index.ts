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

const PLATFORMS = ["mac", "windows", "linux", "linux-amd", "linux-amd-cli", "mac-cli", "linux-jetson-cli"] as const;   // builds on the page
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

    if (path === "/download") return page(await latestRelease(env), origin, req.headers.get("user-agent") ?? "");
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
  "linux-jetson-cli": {
    name: "Jetson headless", arch: "ARM64 CLI · CUDA · over SSH",
    icon: `<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6zm2.3 2.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L8.6 12 6.3 9.7a1 1 0 0 1 0-1.4zM12 15h5a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2z"/>`,
    needs: ["NVIDIA Jetson AGX Orin you reach over SSH, JetPack 6 or 7", "About 10 GB free disk for PyTorch, plus the model layers you serve"],
    steps: [
      `Install over SSH (no root; checks the SHA-256):<code class="cmd">curl -fsSL @ORIGIN@/install.sh | sh -s -- --headless</code>`,
      `Set it up: checks the machine, installs PyTorch for your JetPack, picks layers to serve:<code class="cmd">podtorrent setup</code>`,
      `Watch it live:<code class="cmd">podtorrent top</code>`,
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
.site{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;margin:-32px 0 32px;font-size:14px}
.site a{color:var(--mut);text-decoration:none}.site a:hover{color:var(--acc)}
.site a:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
.site .home{margin-right:auto;color:var(--fg);font-weight:600}
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
.term{border-radius:12px;overflow:hidden;background:#0b0f14;border:1px solid #1e2630;box-shadow:0 8px 24px -8px rgba(0,0,0,.35)}
.tbar{display:flex;align-items:center;gap:14px;padding:8px 12px;background:#121821;border-bottom:1px solid #1e2630}
.dots{display:flex;gap:6px}.dots i{width:10px;height:10px;border-radius:50%;background:#2d3846}
.tabs{display:flex;gap:2px}
.tab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:7px;color:#8b96a3;font-size:12.5px;font-weight:500;cursor:pointer}
.tab input{position:absolute;opacity:0;pointer-events:none}
.tab:hover{color:#e8eef4}
.tab:has(input:checked){background:#1e2630;color:#e8eef4}
.tab:has(input:focus-visible){outline:2px solid #3ee8ff;outline-offset:1px}
.ti{width:13px;height:13px}
.tbody{display:flex;align-items:center;gap:12px;padding:18px 14px 18px 18px}
.prompt{font:600 15px ui-monospace,Menlo,monospace;color:#3ee8ff;user-select:none;flex:none}
.tbody code{flex:1;min-width:0;background:none;padding:0;border-radius:0;font:15px/1.5 ui-monospace,Menlo,monospace;color:#e8eef4;white-space:normal;overflow-wrap:anywhere;user-select:all}
.copy{display:inline-flex;align-items:center;gap:6px;flex:none;padding:7px 12px;border:1px solid #2d3846;border-radius:8px;background:#121821;color:#e8eef4;font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:border-color .15s,background .15s}
.copy:hover{border-color:#3ee8ff;background:#0b2a31}.copy:focus-visible{outline:2px solid #3ee8ff;outline-offset:2px}
.dl main{max-width:1160px;padding:0 24px 64px}
.top{border-bottom:1px solid var(--line)}
.top .in{max-width:1160px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:6px 24px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;margin-right:auto;color:var(--fg);font-weight:650;font-size:17px;letter-spacing:-.01em;text-decoration:none}
.brand .logo{width:28px;height:28px;border-radius:7px}
.top nav{display:flex;flex-wrap:wrap;gap:4px 22px;font-size:14.5px}
.top nav a{color:var(--mut);text-decoration:none}.top nav a:hover{color:var(--fg)}
.top a:focus-visible,.dl a:focus-visible,.dl button:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:6px}
.hx{text-align:center;padding:96px 0 104px;border-bottom:1px solid var(--line);margin:0 -24px;padding-inline:24px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 6px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--mut);text-decoration:none;margin-bottom:28px}
.pill b{padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--acc);font-size:12px;font-weight:600}
.dl h1{font-size:clamp(40px,7.4vw,76px);font-weight:650;letter-spacing:-.04em;line-height:1.02}
.sub{margin:20px auto 0;max-width:620px;color:var(--mut);font-size:clamp(17px,2.2vw,20px);line-height:1.5}
.cta{display:inline-flex;align-items:center;gap:10px;height:52px;padding:0 26px;border-radius:12px;background:var(--fg);color:var(--bg);font-size:17px;font-weight:600;text-decoration:none;transition:opacity .15s,transform .15s}
.cta:hover{opacity:.9}.cta:active{transform:translateY(1px)}
.cta svg{width:20px;height:20px}
.fine{margin:14px 0 0;color:var(--mut);font-size:13.5px}
.fine a{color:var(--mut);text-decoration:underline;text-underline-offset:3px}.fine a:hover{color:var(--fg)}
.start{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,8fr);gap:32px 64px;padding:88px 0}
.intro{position:sticky;top:24px;align-self:start}
.start+.start{border-top:1px solid var(--line)}
.dl h2{font-size:clamp(30px,4vw,42px);font-weight:650;letter-spacing:-.03em;line-height:1.1;margin:0}
.intro>p{margin:14px 0 0;color:var(--mut);font-size:17px;max-width:340px}
.flow{list-style:none;margin:36px 0 0;padding:0;counter-reset:f}
.flow li{position:relative;padding:0 0 26px 44px;counter-increment:f}
.flow li::before{content:counter(f);position:absolute;left:0;top:-2px;width:28px;height:28px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:13px;font-weight:600;color:var(--mut)}
.flow li:not(:last-child)::after{content:"";position:absolute;left:14px;top:30px;bottom:2px;border-left:1px solid var(--line)}
.flow li:first-child::before{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.flow b{display:block;font-size:15.5px}.flow span{display:block;color:var(--mut);font-size:14px;margin-top:2px}
.tk{display:inline-flex;margin-top:10px;padding:7px 14px;border-radius:9px;border:1px solid var(--line);color:var(--fg);font-size:14px;font-weight:600;text-decoration:none}.tk:hover{border-color:var(--acc);color:var(--acc)}
.cards{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
body:has(#m-app:checked) :is(#server,#rq-srv,.path.srv,.sw-app),body:has(#m-srv:checked) :is(#desktop,#rq-app,.path.app,.sw-srv){display:none!important}
.sw{display:flex;align-items:center;justify-content:center;gap:8px;width:max-content;max-width:100%;margin:0 auto 14px;padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--card);font-size:14px;color:var(--mut);cursor:pointer;transition:border-color .15s,color .15s}
.sw b{color:var(--fg);font-weight:600}
.sw:hover{border-color:var(--acc)}.sw:hover b{color:var(--acc)}
.sw:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rq h3{font-size:20px;margin:0 0 14px}
.rq .rpick{margin-bottom:18px}
.rq .hint{margin-top:16px}
#start,#requirements{scroll-margin-top:16px}
.pc{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:30px 30px 22px}
.pc h3{font-size:24px;font-weight:600;letter-spacing:-.02em;margin:0}
.pc>p{margin:8px 0 18px;color:var(--mut);font-size:14.5px;line-height:1.55}
.r{display:flex;align-items:center;gap:12px;padding:14px 0;border-top:1px solid var(--line)}
.r .ai{width:22px;height:22px;flex:none;color:var(--mut)}
.rn{display:grid;margin-right:auto;min-width:0;line-height:1.3}.rn b{font-weight:500;font-size:15.5px;display:flex;align-items:center;gap:8px}.rn small{color:var(--mut);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.you{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--soft);color:var(--acc);white-space:nowrap}
.ob{flex:none;padding:7px 15px;border-radius:9px;border:1px solid color-mix(in srgb,var(--fg) 30%,var(--line));color:var(--fg);font-size:14px;font-weight:500;text-decoration:none;transition:background .15s,border-color .15s}
.ob:hover{border-color:var(--fg)}
.r.me .ai{color:var(--acc)}.r.me .ob{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.ob.off{border-style:dashed;color:var(--mut)}
.pc .more{margin-top:0;border-top:1px solid var(--line)}.pc .more summary{padding-top:14px;font-size:13.5px}
.pc .term{margin-top:4px}
.tbar .copy{margin-left:auto;padding:4px 10px;font-size:12.5px}
.tbody{padding:20px 18px;align-items:flex-start}
.tbody code{font-size:14px}
.hint{margin:14px 2px 0;color:var(--mut);font-size:13.5px}
.reqs{display:grid;gap:16px}.req{display:none}
.rpick{display:flex;flex-wrap:wrap;gap:6px}
.rpick label{position:relative;padding:5px 12px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--mut);cursor:pointer}
.rpick input{position:absolute;opacity:0;pointer-events:none}
.rpick label:hover{color:var(--fg)}
.rpick label:has(input:checked){background:var(--fg);color:var(--bg);border-color:var(--fg)}
.rpick label:has(input:focus-visible){outline:2px solid var(--acc);outline-offset:2px}
.req h4{margin:0 0 6px;font-size:14px}.req h4 span{color:var(--mut);font-weight:400;font-size:12.5px}
.req .needs{margin-bottom:8px}
.notes2 pre{white-space:pre-wrap;font:inherit;font-size:15px;color:var(--mut);margin:0}
.dl footer{margin:0;padding-top:32px;border-top:1px solid var(--line);font-size:13px;line-height:1.8}
.toast{position:fixed;left:50%;bottom:24px;z-index:9;display:flex;align-items:center;gap:14px;width:min(640px,calc(100% - 32px));padding:14px 14px 14px 18px;border-radius:16px;background:var(--card);border:1px solid color-mix(in srgb,var(--acc) 45%,var(--line));box-shadow:0 18px 50px -12px rgba(0,0,0,.45);transform:translateX(-50%);animation:rise .35s ease}
.toast[hidden]{display:none}
.nb{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--acc);color:var(--accfg);font-weight:700;flex:none}
.nt{display:grid;margin-right:auto;line-height:1.35}.nt b{font-size:15px}.nt span{color:var(--mut);font-size:13.5px}
.go-btn{padding:10px 16px;border-radius:10px;background:var(--fg);color:var(--bg);font-weight:600;font-size:14px;text-decoration:none;white-space:nowrap}
.go-btn:hover{opacity:.88}
.tx{border:0;background:none;color:var(--mut);font-size:20px;line-height:1;padding:4px 6px;cursor:pointer}.tx:hover{color:var(--fg)}
@keyframes rise{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translateX(-50%)}}
.paths{max-width:640px;margin:40px auto 0;text-align:left}
.path{display:flex;flex-direction:column;align-items:center;text-align:center;padding:28px;border:1px solid var(--line);border-radius:20px;background:var(--card)}
.path .cta{margin-top:auto}
.pl{display:flex;align-items:center;gap:8px;margin:0;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.pi{width:15px;height:15px}
.pd{margin:8px 0 22px;font-size:17px;font-weight:550;letter-spacing:-.01em}
.path .fine{margin-top:12px}
.path .cta{margin-top:auto;height:50px}
.mini{text-align:left;display:flex;align-items:center;gap:10px;width:100%;margin-top:auto;padding:10px 8px 10px 16px;border-radius:12px;background:#0b0f14;border:1px solid #1e2630}
.mini code,.sx code{white-space:nowrap!important;overflow-x:auto;scrollbar-width:none}.mini code::-webkit-scrollbar,.sx code::-webkit-scrollbar{display:none}
.mini code{flex:1;min-width:0;background:none;padding:0;font:12.5px/1.6 ui-monospace,Menlo,monospace;color:#e8eef4;user-select:all}
.mini .copy{padding:7px 9px}.mini .copy span{display:none}
.mini .prompt{font-size:12.5px;line-height:1.6}
.mini .copy{align-self:center}
.nw{white-space:nowrap}
.copy.ok,.cp.ok{border-color:#3ee8ff;color:#3ee8ff}
.pc h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tt{color:#8b96a3;font:12.5px ui-monospace,Menlo,monospace}
.sb{padding:8px 0 10px}
.sl{padding:8px 14px 8px 18px}
.sc{display:block;color:#6b7785;font:12.5px/1.5 ui-monospace,Menlo,monospace}
.sx{display:flex;align-items:center;gap:10px;margin-top:2px}
.sx code{flex:1;min-width:0;background:none;padding:0;font:12.5px/1.6 ui-monospace,Menlo,monospace;color:#e8eef4;user-select:all}
.sx .prompt{font-size:12.5px;line-height:1.6}
.cp{display:grid;place-items:center;flex:none;width:28px;height:28px;margin:-3px 0;border:1px solid #2d3846;border-radius:7px;background:#121821;color:#8b96a3;cursor:pointer;opacity:.75;transition:opacity .15s,color .15s,border-color .15s}
.cp span{display:none}.cp .ic{width:14px;height:14px}
.sl:hover .cp,.cp:focus-visible{opacity:1;color:#e8eef4}
.cp:hover{border-color:#3ee8ff}
.dterm{margin-top:16px}
.dterm .tbar{flex-wrap:wrap}
@media (max-width:560px){.mini code,.sx code{white-space:normal!important;overflow-wrap:anywhere}.sw span{display:none}.sw b{white-space:nowrap}.mini,.sx{align-items:flex-start}.path{padding:20px}.mini .copy span{display:none}.sl{padding:8px 12px}.dl .tt{display:none}}
@media (max-width:1100px){.start{grid-template-columns:minmax(0,1fr);padding:64px 0}.intro{position:static}.intro>p{max-width:none}}
@media (max-width:560px){.dl main{padding:0 16px 48px}.top .in{padding:12px 16px}.top nav{gap:4px 14px;font-size:13.5px}.hx{padding:64px 16px 72px;margin:0 -16px}.cta{width:100%;justify-content:center}.pc{padding:22px 18px 16px;border-radius:18px}.dl .tab .ti,.dl .dots,.dl .tbar .copy span{display:none}.dl .tbar{gap:6px;padding:8px}.dl .tab{padding:5px 8px;white-space:nowrap}.toast{flex-wrap:wrap;bottom:12px}.go-btn{flex:1;text-align:center}}
.tip{border-left:3px solid var(--acc);background:var(--card);padding:10px 14px;border-radius:0 8px 8px 0;margin:16px 0 0;font-size:14px;color:var(--mut);max-width:720px}
`;
const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#3ee8ff"/><stop offset=".6" stop-color="#3ee8ff" stop-opacity=".35"/><stop offset="1" stop-color="#3ee8ff" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" rx="14" fill="#05070b"/><circle cx="32" cy="32" r="21" fill="none" stroke="#3ee8ff" stroke-opacity=".45" stroke-width="2"/><circle cx="32" cy="32" r="16" fill="url(#g)"/><circle cx="32" cy="32" r="5" fill="#eaffff"/></svg>`;
// Links to the other PodTorrent sites, so /download is never a dead end.
const SITE_NAV = `<nav class="site" aria-label="PodTorrent sites"><a class="home" href="https://podtorrent.com/">PodTorrent</a><a href="https://docs.podtorrent.com/">Docs</a><a href="https://podtorrent.com/register-node">Run a node</a><a href="https://playground.podtorrent.com/">Playground</a><a href="https://dashboard.podtorrent.com/">Dashboard</a></nav>`;

function page(rel: Release | null, origin: string, ua: string): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const mb = (b: Build) => `${(b.size / 1e6).toFixed(0)} MB`;
  // A platform's latest build can be older than the release (Mac builds aren't made in CI).
  const ver = (b: Build) => b.key.match(/^releases\/v([^/]+)\//)?.[1] ?? rel!.version;
  const svg = (d: string, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;
  const chev = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const copyIc = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
  const copyBtn = (text: string, label = "Copy", cls = "copy") =>
    `<button type="button" class="${cls}" data-copy="${esc(text)}" title="Copy" aria-label="Copy ${esc(text)}">${copyIc}<span>${label}</span></button>`;
  // The installers. install.sh picks the build for the machine; --headless makes the server choice explicit.
  const SH = "curl -fsSL @ORIGIN@/install.sh | sh", HL = "curl -fsSL @ORIGIN@/install.sh | sh -s -- --headless", PS = "irm @ORIGIN@/install.ps1 | iex";
  // Shown with the flag kept on one line (hyphens are line-break points); copied as plain text.
  const HLshow = HL.replace(" -s -- --headless", ' <span class="nw">-s -- --headless</span>');
  const APPS = PLATFORMS.filter((p) => !p.endsWith("-cli"));
  const SERVERS: { p: Platform; label: string }[] = [
    { p: "mac-cli", label: "Apple Silicon Mac" }, { p: "linux-amd-cli", label: "AMD Ryzen AI Max" }, { p: "linux-jetson-cli", label: "Jetson Orin" }];
  const OS_NAME: Partial<Record<Platform, string>> = { mac: "macOS", windows: "Windows", linux: "Linux" };
  const SUB: Partial<Record<Platform, string>> = { mac: "Apple Silicon", windows: "x64 · NVIDIA", linux: "x64 · NVIDIA", "linux-amd": "AMD Ryzen AI Max" };
  // This visitor's machine, from the user agent (phones and tablets get the full list).
  const me: Platform | "" = /iPhone|iPad|Android/.test(ua) ? "" : /Windows/.test(ua) ? "windows" : /Mac/.test(ua) ? "mac" : /Linux|X11|CrOS/.test(ua) ? "linux" : "";
  const meta = (p: Platform) => { const b = rel?.[p]; return b ? `${SUB[p]} · .${esc(BUILDS[SLUG[p]].ext)} · v${esc(ver(b))} · ${mb(b)}` : "No build yet"; };
  const termIc = svg(INFO["mac-cli"].icon);

  // Hero: two equal ways in. This computer (the app) or a server over SSH (one line).
  const desk = me && rel?.[me]
    ? `<a class="cta" id="cta" data-dl data-p="${me}" href="/download/${SLUG[me]}">${svg(INFO[me].icon)}Download for ${OS_NAME[me]}</a>
      <p class="fine" id="fine">${meta(me)} · <a href="#start">Other platforms</a></p>`
    : `<a class="cta" href="#start">See desktop downloads</a>
      <p class="fine">For macOS, Windows and Linux.</p>`;
  // One card: the desktop app by default; the switch line above it swaps in the headless install (and the
  // setup and requirements below follow). Hidden radios keep it working without JS.
  const sw = (to: string, icon: string, q: string, go: string) =>
    `<label class="sw sw-${to}" for="m-${to}" tabindex="0" role="button">${icon}<span>${q}</span><b>${go} →</b></label>`;
  const hero = `<input type="radio" name="mode" id="m-app" class="sr" checked tabindex="-1" aria-hidden="true"><input type="radio" name="mode" id="m-srv" class="sr" tabindex="-1" aria-hidden="true">
  <div class="paths">
    ${sw("srv", termIc.replace('class=""', 'class="pi"'), "Installing on a server?", "Use the headless install")}
    ${sw("app", svg(INFO.mac.icon, "pi"), "On this computer?", "Get the desktop app")}
    <div class="path app"><p class="pl">${svg(INFO.mac.icon, "pi")}On this computer</p><p class="pd">The desktop app. Click and run.</p>${desk}</div>
    <div class="path srv"><p class="pl">${termIc.replace('class=""', 'class="pi"')}On a server, over SSH</p><p class="pd">No screen needed. Paste this in your SSH session.</p>
      <div class="mini"><span class="prompt" aria-hidden="true">$</span><code>${HLshow}</code>${copyBtn(HL, "Copy", "copy")}</div>
      <p class="fine">Mac mini, AMD Ryzen AI Max or Jetson · <a href="#start">Step by step</a></p></div>
  </div>`;

  // Requirements, one platform at a time (radio pills; works without JS).
  const reqBlock = (group: string, items: { p: Platform; label: string }[], pick: Platform, steps: boolean) =>
    `<div class="rpick" role="radiogroup" aria-label="Show requirements for">${items.map(({ p, label }) =>
      `<label><input type="radio" name="${group}" value="${p}"${p === pick ? " checked" : ""}>${label}</label>`).join("")}</div>` +
    items.map(({ p }) => `<div class="req" data-p="${p}"><h4>${INFO[p].name} <span>${INFO[p].arch}</span></h4>
      <ul class="needs">${INFO[p].needs.map((n) => `<li>${n}</li>`).join("")}</ul>
      ${steps ? `<ol class="steps">${INFO[p].steps.map((n) => `<li>${n}</li>`).join("")}</ol>` : ""}</div>`).join("");
  const reqCss = PLATFORMS.map((p) => `.reqs:has(input[value="${p}"]:checked) .req[data-p="${p}"]`).join(",") + "{display:block}";
  const appItems = APPS.map((p) => ({ p, label: INFO[p].name }));

  const row = (p: Platform) => {
    const b = rel?.[p];
    return `<div class="r${p === me ? " me" : ""}">${svg(INFO[p].icon, "ai")}<span class="rn"><b>${INFO[p].name}${p === me ? `<span class="you">This machine</span>` : ""}</b><small>${meta(p)}</small></span>${
      b ? `<a class="ob" data-dl data-p="${p}" href="/download/${SLUG[p]}" aria-label="Download for ${INFO[p].name}">Download</a>` : `<span class="ob off">Soon</span>`}</div>`;
  };
  // The server walk-through, as one terminal session.
  const line = (c: string, cmd: string, copy = true, show = cmd) =>
    `<div class="sl"><span class="sc"># ${c}</span><div class="sx"><span class="prompt" aria-hidden="true">$</span><code>${show}</code>${copy ? copyBtn(cmd, "", "cp") : ""}</div></div>`;
  const win = me === "windows";
  const tab = (v: string, label: string, icons: string[], on: boolean) =>
    `<label class="tab"><input type="radio" name="sys" value="${v}"${on ? " checked" : ""}>${icons.map((i) => svg(i, "ti")).join("")}<span>${label}</span></label>`;
  const TOKEN = "https://dashboard.podtorrent.com/operator?run=app";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Download PodTorrent</title>
<meta name="description" content="Download PodTorrent for macOS, Windows and Linux, or install it on a server over SSH.">
<style>
${STYLE}${reqCss}</style></head><body class="dl">
<header class="top"><div class="in"><a class="brand" href="https://podtorrent.com/">${LOGO}PodTorrent</a>
<nav aria-label="PodTorrent sites"><a href="https://docs.podtorrent.com/">Docs</a><a href="https://podtorrent.com/register-node">Run a node</a><a href="https://playground.podtorrent.com/">Playground</a><a href="https://dashboard.podtorrent.com/">Dashboard</a></nav></div></header>
<main>
<section class="hx">
  ${rel ? `<a class="pill" href="#new"><b>v${esc(rel.version)}</b>Released ${esc(rel.date)}</a>` : ""}
  <h1>Download PodTorrent</h1>
  <p class="sub">Run large AI models together.<br>Every machine serves a slice, and peers join over the internet.</p>
  ${hero}
</section>
<section class="start" id="start">
  <div class="intro"><h2>Get started</h2>
    <p>Two steps on each machine you want to add.</p>
    <ol class="flow">
      <li><b>Install PodTorrent</b><span>One line over SSH, or the desktop app.</span></li>
      <li><b>Get your node token</b><span>Sign in with your email. About a minute.</span><a class="tk" href="${TOKEN}">Get your node token →</a></li>
      <li><b>Serve together</b><span>The machine picks its layers and joins your peers.</span></li>
    </ol></div>
  <div class="cards">
    <article class="pc" id="desktop"><h3>Desktop app</h3><p>Click and run. Downloads models for you and pools machines for big models.</p>
      ${APPS.map(row).join("")}
      <div class="term dterm">
        <div class="tbar"><span class="tt">Or in a terminal</span>
          <div class="tabs" role="radiogroup" aria-label="Your system">${tab("sh", "macOS · Linux", [INFO.mac.icon, INFO.linux.icon], !win)}${tab("ps", "Windows", [INFO.windows.icon], win)}</div>
          ${copyBtn(win ? PS : SH, "Copy", "copy dcopy")}</div>
        <div class="tbody"><span class="prompt" id="prompt" aria-hidden="true">${win ? "PS>" : "$"}</span><code id="cmd">${win ? PS : SH}</code></div>
      </div>
    </article>
    <article class="pc" id="server"><h3>Server over SSH <span class="you">No screen needed</span></h3>
      <p>For a Mac mini, an AMD Ryzen AI Max box or a Jetson. Installs the <code>podtorrent</code> command, no app.</p>
      <div class="term sess">
        <div class="tbar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="tt">your-server — ssh</span></div>
        <div class="sb">
          ${line("1. From your computer, connect", "ssh you@your-server", false)}
          ${line("2. Install (no root needed)", HL, true, HLshow)}
          ${line("3. Check the machine, pick layers, start serving", "podtorrent setup")}
          ${line("Watch it live", "podtorrent top")}
        </div>
      </div>
      <p class="hint">Run step 2 again to update. On a Mac, <code>podtorrent install-service --at-boot</code> starts it at boot with nobody logged in.</p>
    </article>
  </div>
</section>
<section class="start" id="requirements">
  <div class="intro"><h2>Requirements</h2>
    <p>Check these before you install. If something doesn't start, the steps here do it by hand.</p></div>
  <div class="pc reqs">
    <div class="rq" id="rq-app">${reqBlock("req", appItems, me || "mac", true)}</div>
    <div class="rq" id="rq-srv">${reqBlock("sreq", SERVERS, "mac-cli", false)}
      <p class="hint">Linux PC with an NVIDIA GPU? There's no headless build for it yet: use the desktop app.</p></div>
  </div>
</section>
${rel?.notes ? `<section class="start" id="new"><div class="intro"><h2>What's new</h2><p>v${esc(rel.version)} · ${esc(rel.date)}</p></div><div class="pc notes2"><pre>${esc(rel.notes)}</pre></div></section>` : ""}
<footer>New to PodTorrent? <a href="/download/guide">How to use PodTorrent</a>, a short tour with screenshots.<br>SHA-256 checksums: <code>/download/&lt;name&gt;.sha256</code>. Older builds: <code>/download/v/&lt;version&gt;/&lt;platform&gt;</code>.<br>Setting up a node for the PodTorrent network? Read the <a href="https://docs.podtorrent.com/getting-started/node-quickstart">node quickstart</a>.</footer>
</main>
<div class="toast" id="toast" role="status" hidden>
  <span class="nb" aria-hidden="true">✓</span>
  <div class="nt"><b id="tt">Your download has started</b><span>Next: get your node token so this machine can join.</span></div>
  <a class="go-btn" href="${TOKEN}">Get your node token →</a>
  <button type="button" class="tx" id="tx" aria-label="Close">×</button>
</div>
<script>
const CMDS = { sh: ${JSON.stringify(SH)}, ps: ${JSON.stringify(PS)} };
const $ = (id) => document.getElementById(id);
document.querySelector(".tabs").addEventListener("change", (e) => {
  const v = e.target.value;
  $("cmd").textContent = CMDS[v]; document.querySelector(".dcopy").dataset.copy = CMDS[v];
  $("prompt").textContent = v === "ps" ? "PS>" : "$";
});
// Desktop app or headless: /download#server opens on headless, and switching updates the link.
const fromHash = () => { if (location.hash === "#server") $("m-srv").checked = true; else if (location.hash === "#desktop") { $("m-app").checked = true; $("start").scrollIntoView(); } };
fromHash(); addEventListener("hashchange", fromHash);
document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () =>
  history.replaceState(null, "", $("m-srv").checked ? "#server" : location.pathname + location.search)));
document.querySelectorAll(".sw").forEach((l) => l.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); l.click(); }
}));
// iPads say "Macintosh": send them to the full list instead.
if ($("cta") && /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) {
  $("cta").removeAttribute("data-dl"); $("cta").href = "#desktop"; $("cta").textContent = "See desktop downloads"; $("fine").textContent = "For macOS, Windows and Linux.";
}
// After a download or an install command is copied, point them at their node token.
const next = (t) => { $("tt").textContent = t; $("toast").hidden = false; };
document.querySelectorAll("a[data-dl]").forEach((a) => a.addEventListener("click", () => {
  next("Your download has started");
  const r = document.querySelector('input[name=req][value="' + a.dataset.p + '"]'); if (r) r.checked = true;
}));
$("tx").addEventListener("click", () => { $("toast").hidden = true; });
const says = (t) => (/headless|^podtorrent|^ssh/.test(t) ? "Copied. Paste it in your SSH session" : "Copied. Paste it in a terminal");
document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const t = b.dataset.copy, s = b.querySelector("span"), was = s.textContent;
  try { await navigator.clipboard.writeText(t); b.classList.add("ok"); if (was) s.textContent = "Copied"; } catch { if (was) s.textContent = "Select it"; }
  setTimeout(() => { b.classList.remove("ok"); s.textContent = was; }, 1500);
  if (t.includes("install.")) next(says(t));
}));
document.addEventListener("copy", () => { const t = getSelection()?.toString() ?? ""; if (t.includes("install.")) next(says(t)); });
</script></body></html>`;
  return new Response(html.replaceAll("@ORIGIN@", origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", vary: "user-agent" } });
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
        <li>Enter your approved <b>node id</b> and <b>node token</b>. No node yet? <a href="https://podtorrent.com/register-node">Register one</a>; the token is in the <a href="https://dashboard.podtorrent.com/operator">operator console</a> once it's approved.</li>
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
${SITE_NAV}
<a class="back" href="/download">← Download PodTorrent</a>
<div class="hero">${LOGO}<h1>Using PodTorrent</h1></div>
<p class="lead">PodTorrent lets machines on different networks run one large language model together. Each machine serves a slice of the model's layers, and every token hops between them. Here's how to get set up and start chatting.</p>
<ul class="toc">${steps.map(([id, t]) => `<li><a href="#${id}">${t.replace(/^\d+\. /, "")}</a></li>`).join("")}</ul>
${steps.map(([id, t, body]) => `<section class="step" id="${id}"><h2>${t}</h2>${body}</section>`).join("\n")}

</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
