import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const project = path.resolve(__dirname, "../..");
const helper = path.join(project, "scripts/deploy-sync.sh");
const deploy = path.join(project, "scripts/deploy-aihat2.sh");

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function sync(source: string, destination: string, dryRun = false) {
  const probe = spawnSync("rsync", ["--version"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "data-preservation tests require a real rsync binary");
  const result = spawnSync("bash", ["-c",
    'source "$1"; sync_aihat_code "$2" "$3" "${@:4}"',
    "test", helper, source, destination, ...(dryRun ? ["--dry-run"] : [])],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
}

test("real rsync updates code and template while preserving receiver data, models and unknown files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preserve-"));
  try {
    const source = path.join(root, "source with spaces"), target = path.join(root, "target");
    const protectedFiles = [".env", ".env.backups/backup", ".env.bak-local",
      "data/memory/memory.json", "data/recordings/speech.wav", "knowledge/document.txt",
      "plugins/custom/index.js", "assets/voices/glados/model.onnx", "docker/volume/db/state",
      "dist/index.js", "node_modules/local/state", ".git", "chatbot.log", "use_npm", "use_ollama"];
    for (const file of protectedFiles) {
      write(target, file, `receiver-owned:${file}`);
      write(source, file, `must-not-replace:${file}`);
    }
    write(target, "unknown-user-file", "keep me");
    write(target, "app.js", "old code");
    write(source, "app.js", "updated custom code");
    write(source, ".env.template", "updated template");
    sync(source, target);
    for (const file of protectedFiles)
      assert.equal(fs.readFileSync(path.join(target, file), "utf8"), `receiver-owned:${file}`);
    assert.equal(fs.readFileSync(path.join(target, "unknown-user-file"), "utf8"), "keep me");
    assert.equal(fs.readFileSync(path.join(target, "app.js"), "utf8"), "updated custom code");
    assert.equal(fs.readFileSync(path.join(target, ".env.template"), "utf8"), "updated template");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real rsync protects runtime paths even when they are symlinks, and dry-run writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-links-"));
  try {
    const source = path.join(root, "source"), target = path.join(root, "target");
    const external = path.join(root, "outside-code");
    fs.mkdirSync(source); fs.mkdirSync(target); fs.mkdirSync(external);
    write(external, "memory.json", "persistent memory");
    fs.symlinkSync(external, path.join(target, "data"));
    fs.symlinkSync(external, path.join(source, "data"));
    write(source, "app.js", "new code");
    sync(source, target, true);
    assert.equal(fs.existsSync(path.join(target, "app.js")), false);
    sync(source, target);
    assert.equal(fs.readlinkSync(path.join(target, "data")), external);
    assert.equal(fs.readFileSync(path.join(external, "memory.json"), "utf8"), "persistent memory");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function cli(args: string[], host = "fixture@localhost", executeBuild = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-cli-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  for (const command of ["rsync", "ssh"])
    fs.writeFileSync(path.join(bin, command), `#!/bin/bash\nprintf '%s\\n' "$@" >> "$DEPLOY_TEST_LOG/${command}"\n` +
      (command === "ssh" ? 'if [ "$DEPLOY_TEST_EXEC_SSH" = 1 ]; then bash -c "${!#}"; fi\n' : ""), { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "yarn"), '#!/bin/bash\nif [ "$1" = --version ]; then echo 1.22.22; else printf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG/yarn"; fi\n', { mode: 0o700 });
  const target = path.join(root, "target"); fs.mkdirSync(target);
  write(target, ".env", "receiver config");
  const result = spawnSync("bash", [deploy, ...args], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_HOST: host,
      REMOTE_DIR: target, DEPLOY_TEST_LOG: root, DEPLOY_TEST_EXEC_SSH: executeBuild ? "1" : "0" } });
  return { root, result };
}

test("default/sync-only/dry-run transfer never invokes remote builds, config or provisioning", () => {
  for (const args of [[], ["--sync-only"], ["--dry-run", "--provision"]]) {
    const { root, result } = cli(args);
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(root, "ssh")), false);
      const argv = fs.readFileSync(path.join(root, "rsync"), "utf8");
      assert.doesNotMatch(argv, /--delete/);
      if (args.includes("--dry-run")) assert.match(argv, /--dry-run/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("deploy requires an explicit target and rejects invalid options before network commands", () => {
  for (const [args, host] of [[[], ""], [["--unknown"], "fixture@localhost"]] as [string[], string][]) {
    const { root, result } = cli(args, host);
    try {
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(root, "rsync")), false);
      assert.equal(fs.existsSync(path.join(root, "ssh")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("explicit build preserves the remote bash argument and uses only locked Yarn build", () => {
  const { root, result } = cli(["--build"], "fixture@localhost", true);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(root, "yarn"), "utf8").trim().split("\n"),
      ["install --frozen-lockfile --non-interactive", "build"]);
    assert.equal(fs.readFileSync(path.join(root, "target/.env"), "utf8"), "receiver config");
    assert.match(result.stdout, /No configuration, model, driver or service provisioning/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
