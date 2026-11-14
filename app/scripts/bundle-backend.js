#!/usr/bin/env node
// Stage the Python backend + uv into src-tauri/resources/backend so the app is self-contained.
// Node, not sh, so it runs on macOS, Windows and Linux alike.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const app = path.resolve(__dirname, "..");
const root = path.resolve(app, "..");
// PODTORRENT_BACKEND_OUT stages it elsewhere (the headless Linux tarball, headless/package.sh).
const out = process.env.PODTORRENT_BACKEND_OUT ? path.resolve(process.env.PODTORRENT_BACKEND_OUT)
  : path.join(app, "src-tauri/resources/backend");
const uvName = process.platform === "win32" ? "uv.exe" : "uv";

/** uv on PATH (like `command -v uv`), else uv's default install location. */
function findUv() {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const hit = execFileSync(cmd, ["uv"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean);
    if (hit) return hit.trim();
  } catch {}
  const fallback = path.join(require("os").homedir(), ".local/bin", uvName);
  if (fs.existsSync(fallback)) return fallback;
  throw new Error("uv not found: install it from https://docs.astral.sh/uv/");
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(findUv(), path.join(out, uvName));
fs.chmodSync(path.join(out, uvName), 0o755);
// .python-version pins the interpreter uv installs; without it uv takes the newest, which PyTorch may not support yet.
for (const f of ["pyproject.toml", "uv.lock", "README.md", ".python-version"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
// PODTORRENT_TORCH_INDEX swaps the PyTorch wheel index the bundle installs from (the default is CUDA 12.8,
// see pyproject.toml). The AMD Linux build sets it to a ROCm index for Strix Halo (gfx1151), then relocks
// so first launch installs ROCm PyTorch instead of CUDA.
const torchIndex = process.env.PODTORRENT_TORCH_INDEX;
if (torchIndex) {
  const pp = path.join(out, "pyproject.toml");
  const src = fs.readFileSync(pp, "utf8");
  // ROCm PyTorch depends on rocm[libraries] packages that AMD's index serves too, so the index can't be
  // `explicit` (torch-only) and uv has to search all indexes, not stop at the first that has a name.
  const next = src.replace(/(name = "pytorch-cu128"\nurl = )"[^"]*"\nexplicit = true/, `$1"${torchIndex}"\nexplicit = false`);
  if (next === src) throw new Error("pyproject.toml has no pytorch-cu128 index to replace");
  fs.writeFileSync(pp, `${next}\n[tool.uv]\nindex-strategy = "unsafe-best-match"\n`);
  execFileSync(path.join(out, uvName), ["lock", "--project", out], { stdio: "inherit" });
  console.log(`torch index: ${torchIndex}`);
}
fs.cpSync(path.join(root, "podtorrent"), path.join(out, "podtorrent"), {
  recursive: true,
  filter: src => path.basename(src) !== "__pycache__",
});
// podtorrent/endpoints.json (the servers this build talks to) came along with the package. It's
// gitignored: CI writes it for official builds from the PODTORRENT_ENDPOINTS secret.
if (!fs.existsSync(path.join(root, "podtorrent/endpoints.json"))) {
  if (process.env.PODTORRENT_REQUIRE_ENDPOINTS) throw new Error("podtorrent/endpoints.json is missing (PODTORRENT_REQUIRE_ENDPOINTS is set)");
  console.warn("no podtorrent/endpoints.json: this build has no rendezvous or network (see endpoints.example.json)");
}
// The network agent (podtorrent-agent): PODTORRENT_AGENT_BIN, else built from a podtorrent-agent
// checkout next to this repo (Go 1.24+ as `go`, or PODTORRENT_GO). Without it the app runs
// swarm-only and can't join the PodTorrent network.
const agentName = process.platform === "win32" ? "podtorrent-agent.exe" : "podtorrent-agent";
const agentSrc = path.resolve(root, "../podtorrent-agent");
try {
  if (process.env.PODTORRENT_AGENT_BIN) {
    fs.copyFileSync(process.env.PODTORRENT_AGENT_BIN, path.join(out, agentName));
  } else {
    execFileSync(process.env.PODTORRENT_GO || "go",
      ["build", "-trimpath", "-o", path.join(out, agentName), "./cmd/podtorrent-agent"],
      { cwd: agentSrc, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" } });
  }
  fs.chmodSync(path.join(out, agentName), 0o755);
  console.log("staged network agent");
} catch (e) {
  // CI passes PODTORRENT_AGENT_BIN for every desktop build: failing to stage it is an error, not swarm-only.
  if (process.env.PODTORRENT_AGENT_BIN) throw new Error(`network agent not staged: ${e.message}`);
  console.warn(`network agent not staged (${e.message}); the app will run swarm-only`);
}
console.log(`staged backend in ${path.relative(app, out)}`);
