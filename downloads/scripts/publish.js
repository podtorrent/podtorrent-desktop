// Upload one build to R2 and point latest.json at it.
//   node downloads/scripts/publish.js <name> <path-to-build> [--notes "..."] [--no-latest]
// <name> is a download name from src/builds.json (macos-arm64, windows-x64-cuda, linux-x64-cuda,
// linux-x64-rocm, linux-x64-rocm-headless, linux-arm64-jetson-headless, macos-arm64-headless) or its older name (mac, windows, linux, linux-amd, linux-amd-cli).
// The file is stored under the standard name podtorrent-<version>-<name>.<ext>, whatever it was built as.
// The version comes from app/src-tauri/tauri.conf.json. Versioned files are never overwritten;
// to roll back, re-point latest.json with: node downloads/scripts/publish.js promote <version>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BUCKET = "podtorrent-releases";
const { builds: BUILDS } = JSON.parse(fs.readFileSync(path.join(here, "../src/builds.json"), "utf8"));
// Every accepted name (standard or older) -> its standard name.
const NAMES = Object.fromEntries(Object.entries(BUILDS).flatMap(([n, b]) => [[n, n], ...b.legacy.map((l) => [l, n])]));
const PLATFORMS = Object.values(BUILDS).map((b) => b.manifest);   // latest.json / release.json fields

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const notes = flag("--notes");
const noLatest = args.includes("--no-latest") && args.splice(args.indexOf("--no-latest"), 1);
const [cmd, arg] = args;

// Run wrangler's JS entry with node: `npx` is a .cmd shim on Windows that execFileSync can't spawn,
// and going through a shell instead would split arguments with spaces (e.g. --notes).
const wranglerBin = path.join(here, "../node_modules/wrangler/bin/wrangler.js");
const wrangler = (...a) =>
  execFileSync(process.execPath, [wranglerBin, "r2", "object", ...a, "--remote"], {
    cwd: path.join(here, ".."),
    stdio: ["ignore", "pipe", "inherit"],
  });
const getJson = (key) => {
  try {
    return JSON.parse(wrangler("get", `${BUCKET}/${key}`, "--pipe").toString());
  } catch {
    return null;
  }
};
const putJson = (key, obj) => {
  const tmp = path.join(os.tmpdir(), `podtorrent-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  wrangler("put", `${BUCKET}/${key}`, "--file", tmp, "--content-type", "application/json");
  fs.unlinkSync(tmp);
};

if (cmd === "promote") {
  const rel = getJson(`releases/v${arg}/release.json`);
  if (!rel) throw new Error(`v${arg} not found in R2`);
  putJson("latest.json", rel);
  console.log(`latest -> v${arg}`);
  process.exit(0);
}

if (!NAMES[cmd] || !arg) {
  console.error(`usage: publish.js <${Object.keys(BUILDS).join("|")}> <build> [--notes '...'] [--no-latest] | promote <version>`);
  process.exit(1);
}
const name = NAMES[cmd];
const spec = BUILDS[name];

const version = JSON.parse(fs.readFileSync(path.join(root, "app/src-tauri/tauri.conf.json"), "utf8")).version;
const file = `podtorrent-${version}-${name}.${spec.ext}`;   // the naming standard, whatever it was built as
const data = fs.readFileSync(arg);
const prefix = `releases/v${version}`;
const build = { key: `${prefix}/${file}`, file, sha256: createHash("sha256").update(data).digest("hex"), size: data.length };

const rel = getJson(`${prefix}/release.json`) ?? { version, date: new Date().toISOString().slice(0, 10), notes: "" };
const key = spec.manifest;
if (rel[key] && rel[key].sha256 !== build.sha256) {
  throw new Error(`v${version} already has a different ${name} build; bump the version instead of overwriting`);
}
if (notes) rel.notes = notes;
rel[key] = build;

console.log(`uploading ${path.basename(arg)} as ${file} (${(build.size / 1e6).toFixed(0)} MB) -> ${prefix}/`);
wrangler("put", `${BUCKET}/${build.key}`, "--file", path.resolve(arg), "--content-type", "application/octet-stream");
putJson(`${prefix}/release.json`, rel);

if (!noLatest) {
  // Keep the other platform's latest build if this version doesn't have one yet.
  const latest = getJson("latest.json") ?? {};
  const merged = { ...rel };
  for (const p of PLATFORMS) {
    if (!merged[p] && latest[p]) merged[p] = latest[p];
  }
  putJson("latest.json", merged);
  console.log(`latest -> v${version} (${name})`);
}
