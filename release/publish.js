// Upload one build to R2 and point latest.json at it. Safe to run for several builds at once.
//   node release/publish.js <name> <path-to-build> [--notes "..."] [--no-latest]
// <name> is a download name from builds.json (macos-arm64, windows-x64-cuda, linux-x64-cuda,
// linux-x64-rocm, linux-x64-rocm-headless, linux-arm64-jetson-headless, macos-arm64-headless) or its older name (mac, windows, linux, linux-amd, linux-amd-cli).
// The file is stored under the standard name podtorrent-<version>-<name>.<ext>, whatever it was built as.
// The version comes from app/src-tauri/tauri.conf.json. Versioned files are never overwritten;
// to roll back, re-point latest.json with: node release/publish.js promote <version>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BUCKET = "podtorrent-releases";
const { builds: BUILDS } = JSON.parse(fs.readFileSync(path.join(here, "builds.json"), "utf8"));
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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Run wrangler's JS entry with node: `npx` is a .cmd shim on Windows that execFileSync can't spawn,
// and going through a shell instead would split arguments with spaces (e.g. --notes).
const wranglerBin = path.join(here, "node_modules/wrangler/bin/wrangler.js");
// PODTORRENT_R2_LOCAL=<dir>: use a local bucket kept in <dir> instead of the real one (for tests).
const local = process.env.PODTORRENT_R2_LOCAL;
const r2Where = local ? ["--local", "--persist-to", local] : ["--remote"];
// R2 calls fail now and then (network, rate limits); retry them, so a failed read is never taken for a
// missing manifest entry, which would drop a build from release.json or latest.json.
const MISSING = "The specified key does not exist";
const wrangler = (...a) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(process.execPath, [wranglerBin, "r2", "object", ...a, ...r2Where], {
        cwd: here,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = String(e.stderr ?? "");
      if (a[0] === "get" && err.includes(MISSING)) return null;
      if (attempt >= 5) {
        process.stderr.write(err);
        throw e;
      }
      sleep(attempt * 2000 + Math.random() * 1000);
    }
  }
};
const getJson = (key) => {
  const out = wrangler("get", `${BUCKET}/${key}`, "--pipe");
  return out === null ? null : JSON.parse(out.toString());
};
const putJson = (key, obj) => {
  const tmp = path.join(os.tmpdir(), `podtorrent-${process.pid}-${Date.now()}.json`);
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

// Several builds of one version publish at the same time (one CI workflow each), and R2 has no
// compare-and-swap from wrangler, so release.json and latest.json can't be safely read, changed and
// written back: the last writer would drop the builds the others added. Instead each build writes its
// own entry to releases/v<version>/parts/<field>.json, which nobody else touches, and both manifests
// are rebuilt from all the parts. Each publisher then checks the stored manifests until they match a
// fresh rebuild twice in a row, and rewrites them if a slower publisher overwrote them with an older view.
const key = spec.manifest;
const partKey = (p) => `${prefix}/parts/${p}.json`;
const relKey = `${prefix}/release.json`;
const old = getJson(partKey(key)) ?? getJson(relKey)?.[key];
if (old && old.sha256 !== build.sha256) {
  throw new Error(`v${version} already has a different ${name} build; bump the version instead of overwriting`);
}

console.log(`uploading ${path.basename(arg)} as ${file} (${(build.size / 1e6).toFixed(0)} MB) -> ${prefix}/`);
wrangler("put", `${BUCKET}/${build.key}`, "--file", path.resolve(arg), "--content-type", "application/octet-stream");
putJson(partKey(key), build);

// Same content whatever the key order (manifests written before the parts existed have another order).
const canon = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
    : JSON.stringify(v);
const settleMs = Number(process.env.PODTORRENT_PUBLISH_SETTLE_MS ?? 10000);

// release.json: every part of this version; a field with no part yet (published before parts existed)
// keeps its entry from the stored release.json.
const rebuildRelease = (stored) => {
  const rel = { version, date: stored?.date ?? new Date().toISOString().slice(0, 10), notes: notes ?? stored?.notes ?? "" };
  for (const p of PLATFORMS) {
    const part = getJson(partKey(p)) ?? stored?.[p];
    if (part) rel[p] = part;
  }
  return rel;
};
// latest.json: this version's builds, plus the latest build of any platform this version doesn't have yet.
const rebuildLatest = (rel, stored) => {
  const merged = { ...rel };
  for (const p of PLATFORMS) {
    if (!merged[p] && stored?.[p]) merged[p] = stored[p];
  }
  return merged;
};

let stable = 0;
for (let round = 1; stable < 2; round++) {
  if (round > 12) throw new Error(`v${version}: release.json/latest.json never settled; check them in R2`);
  let wrote = false;
  const storedRel = getJson(relKey);
  const rel = rebuildRelease(storedRel);
  if (canon(rel) !== canon(storedRel)) {
    putJson(relKey, rel);
    wrote = true;
  }
  if (!noLatest) {
    const storedLatest = getJson("latest.json");
    const latest = rebuildLatest(rel, storedLatest);
    if (canon(latest) !== canon(storedLatest)) {
      putJson("latest.json", latest);
      wrote = true;
    }
  }
  stable = wrote ? 0 : stable + 1;
  if (stable < 2) sleep(settleMs + Math.random() * settleMs);
}
if (!noLatest) console.log(`latest -> v${version} (${name})`);
