// Bump the patch version in tauri.conf.json (the version the .app reports) before each build.
const fs = require("fs");
const path = require("path");

const conf = path.join(__dirname, "../src-tauri/tauri.conf.json");
const c = JSON.parse(fs.readFileSync(conf, "utf8"));
const [major, minor, patch] = c.version.split(".").map(Number);
c.version = `${major}.${minor}.${patch + 1}`;
fs.writeFileSync(conf, JSON.stringify(c, null, 2) + "\n");
console.log(`version -> ${c.version}`);
