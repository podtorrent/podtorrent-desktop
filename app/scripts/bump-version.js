// Bump the patch version in tauri.conf.json (the version the .app reports) before each build,
// then copy it into package.json, Cargo.toml and pyproject.toml so every manifest agrees.
// `node scripts/bump-version.js --sync` copies the current version without bumping.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const conf = path.join(root, "src-tauri/tauri.conf.json");
const c = JSON.parse(fs.readFileSync(conf, "utf8"));
if (!process.argv.includes("--sync")) {
  const [major, minor, patch] = c.version.split(".").map(Number);
  c.version = `${major}.${minor}.${patch + 1}`;
  fs.writeFileSync(conf, JSON.stringify(c, null, 2) + "\n");
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = c.version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// The first `version = "..."` line in a TOML file is the [package]/[project] one.
for (const toml of ["src-tauri/Cargo.toml", "../pyproject.toml"]) {
  const p = path.join(root, toml);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/^version = ".*"$/m, `version = "${c.version}"`));
}
console.log(`version -> ${c.version}`);
