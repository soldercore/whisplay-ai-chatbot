#!/usr/bin/env node
// Pre-deploy gate. Run from the project root before any compiled file is copied to the Pi:
//   node scripts/predeploy/check.cjs                       build from src and check it
//   node scripts/predeploy/check.cjs --expect a.js,b.js    the only compiled files allowed to differ from production
//   node scripts/predeploy/check.cjs --dist <dir>          check an existing compiled tree instead of building
//   node scripts/predeploy/check.cjs --write-manifest      record the current build as the production baseline
// It never touches the Pi. Exit code 0 means every step passed.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const here = __dirname;
const manifestFile = path.join(here, "production-dist.sha256");
const baselineFile = path.join(here, "imports-baseline.txt");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const expected = new Set((option("--expect") || "").split(",").map(s => s.trim()).filter(Boolean));
const failures = [];
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures.push(name);
};
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
// Two hashes per file: exact bytes, and bytes with all whitespace removed (same code, different formatting).
const hashes = dir => Object.fromEntries(walk(dir).map(file => {
  const data = fs.readFileSync(file);
  const rel = path.relative(dir, file).split(path.sep).join("/");
  return [rel, [sha(data), sha(data.toString("latin1").replace(/\s+/g, ""))]];
}).sort(([a], [b]) => a.localeCompare(b)));
const tsc = extra => spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), ...extra],
  { cwd: root, encoding: "utf8" });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "predeploy-"));
let dist = option("--dist") ? path.resolve(option("--dist")) : path.join(work, "dist");
try {
  if (!option("--dist")) {
    // 1. The exact source must type-check. A missing export fails here (TS2305).
    const check = tsc(["--noEmit"]);
    step("type check of src", check.status === 0, check.status === 0 ? "" : "\n" + (check.stdout || "").trim().split("\n").slice(0, 8).join("\n"));
    // 2. Build into a private folder, never into the project's own dist.
    const build = tsc(["--outDir", dist]);
    step("build", fs.existsSync(dist) && build.status === 0);
  }
  const built = hashes(dist);

  if (args.includes("--write-manifest")) {
    fs.writeFileSync(manifestFile, Object.entries(built).map(([f, [raw, code]]) => `${raw}  ${code}  ${f}`).join("\n") + "\n");
    console.log(`wrote ${path.relative(root, manifestFile)} (${Object.keys(built).length} files)`);
  }

  // 3. Compare with what runs in production. Only the files named with --expect may differ in code.
  const production = Object.fromEntries(fs.readFileSync(manifestFile, "utf8").trim().split("\n")
    .map(line => line.split(/\s+/)).map(([raw, code, f]) => [f, [raw, code]]));
  const changed = [], formatting = [];
  for (const f of new Set([...Object.keys(production), ...Object.keys(built)])) {
    if (!production[f] || !built[f]) changed.push(f + (production[f] ? " (missing)" : " (new)"));
    else if (production[f][1] !== built[f][1]) changed.push(f);
    else if (production[f][0] !== built[f][0]) formatting.push(f);
  }
  const unexpected = changed.filter(f => !expected.has(f.split(" ")[0]));
  const missingExpected = [...expected].filter(f => !changed.includes(f));
  step("compiled files match production except the expected ones", unexpected.length === 0 && missingExpected.length === 0,
    `${Object.keys(built).length} files, code differs in ${changed.length}` +
    (unexpected.length ? `\n  unexpected: ${unexpected.join(", ")}` : "") +
    (missingExpected.length ? `\n  expected to change but did not: ${missingExpected.join(", ")}` : ""));
  if (formatting.length) console.log(`note  same code, different formatting than production: ${formatting.join(", ")}`);

  // 4. Every member a compiled file reads from another local module must be exported there.
  const unresolved = [];
  for (const f of Object.keys(built).filter(f => f.endsWith(".js"))) {
    const r = spawnSync(process.execPath, [path.join(here, "imports-check.cjs"), path.join(dist, f)], { encoding: "utf8" });
    for (const line of (r.stdout || "").split("\n")) if (/^(UNRESOLVED|MISSING MODULE)/.test(line)) unresolved.push(`${f}: ${line}`);
  }
  const baseline = new Set(fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, "utf8").trim().split("\n") : []);
  if (args.includes("--write-manifest")) fs.writeFileSync(baselineFile, unresolved.join("\n") + "\n");
  const fresh = unresolved.filter(line => !baseline.has(line) && !args.includes("--write-manifest"));
  step("compiled imports resolve", fresh.length === 0, fresh.length ? "\n  " + fresh.join("\n  ") : `${unresolved.length} known non-issues in baseline`);

  // 5. Seven end-to-end cases on the compiled files with voice control on and fixtures for Ollama and the daemon.
  const stage = path.join(work, "stage");
  fs.mkdirSync(stage);
  fs.cpSync(dist, path.join(stage, "dist"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(stage, "node_modules"), "junction");
  fs.copyFileSync(path.join(here, "dist-smoke.spec.cjs"), path.join(stage, "dist-smoke.spec.cjs"));
  const smoke = spawnSync(process.execPath, ["--test", "dist-smoke.spec.cjs"], { cwd: stage, encoding: "utf8", timeout: 120000 });
  const out = (smoke.stdout || "") + (smoke.stderr || "");
  const pass = /^(?:# |ℹ )pass (\d+)/m.exec(out)?.[1], fail = /^(?:# |ℹ )fail (\d+)/m.exec(out)?.[1];
  step("smoke test on compiled files", smoke.status === 0, `pass ${pass} fail ${fail}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(failures.length ? `\nBLOCKED: ${failures.length} check(s) failed. Do not deploy.` : "\nOK: all checks passed.");
process.exit(failures.length ? 1 : 0);
