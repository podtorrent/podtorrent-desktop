#!/usr/bin/env node
// Stage the Python backend + uv into src-tauri/resources/backend so the app is self-contained.
// Node, not sh, so it runs on macOS, Windows and Linux alike.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const app = path.resolve(__dirname, "..");
const root = path.resolve(app, "..");
const out = path.join(app, "src-tauri/resources/backend");
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
for (const f of ["pyproject.toml", "uv.lock", "README.md"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, "podtorrent"), path.join(out, "podtorrent"), {
  recursive: true,
  filter: src => path.basename(src) !== "__pycache__",
});
console.log(`staged backend in ${path.relative(app, out)}`);
