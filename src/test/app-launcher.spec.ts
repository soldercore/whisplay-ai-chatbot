import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
function shell(code: string, env: Record<string, string> = {}) {
  return execFileSync("bash", ["-c", code], { encoding: "utf8", timeout: 15000,
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}
function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "launcher-" )).replace(/\\/g, "/");
}

test("lock branches: normal start, duplicate refusal, stale-file restart (mock flock on Windows)", () => {
  const dir = fixture();
  // Only runtime directory is redirected. Windows has no flock: test its
  // return contract explicitly, without claiming Linux kernel-lock coverage.
  const source = read("scripts/app-lock.sh").split("/tmp/whisplay-chatbot-").join(`${dir}/lock-`);
  const result = shell(source + `
    busy=false
    flock() { [ "$busy" = false ] || return 1; busy=true; }
    acquire_app_lock || exit 10
    [ -f "$WHISPLAY_APPLICATION_LOCK" ] || exit 11
    ${process.platform === "linux" ? "node -e 'require(\"fs\").fstatSync(9)'" : "bash -c ': >&9'"} || exit 12
    acquire_app_lock; status=$?
    [ "$status" = 73 ] || exit 13
    exec 9>&-
    busy=false
    acquire_app_lock || exit 14
    [ -f "$WHISPLAY_APPLICATION_LOCK" ] || exit 15
    echo NORMAL_DUPLICATE_RESTART
  `);
  assert.match(result, /NORMAL_DUPLICATE_RESTART/);
});

test("lock refuses unsafe file type and missing flock rather than continuing unlocked", () => {
  const dir = fixture(); const source = read("scripts/app-lock.sh").split("/tmp/whisplay-chatbot-").join(`${dir}/lock-`);
  const result = shell(source + `
    flock() { return 0; }
    directory="${dir}/lock-$(id -u)"
    mkdir -p "$directory/application.lock"
    if acquire_app_lock 2>/dev/null; then exit 16; fi
    command() { [ "$2" = flock ] && return 1; builtin command "$@"; }
    if acquire_app_lock 2>/dev/null; then exit 17; fi
    echo UNSAFE_REFUSED
  `);
  assert.match(result, /UNSAFE_REFUSED/);
});

for (const fail of ["none", "exit", "wait", "pending", "launch"]) test(`daemon restart waits for actual exit and refuses failures: ${fail}`, () => {
  const dir = fixture(); fs.mkdirSync(`${dir}/cli`); fs.mkdirSync(`${dir}/scripts`);
  fs.writeFileSync(`${dir}/cli/service.sh`, read("cli/service.sh"));
  fs.writeFileSync(`${dir}/scripts/app-lock.sh`, 'wait_for_app_unlock() { echo lock >> "$EVENTS"; [ "$FAIL" != wait ]; }\n');
  const result = shell(`
    source "$FIXTURE/cli/service.sh"
    _bold() { :; }; _green() { echo SUCCESS; }; _red() { :; }; _yellow() { :; }
    sleep() { SECONDS=$((SECONDS+21)); }
    _daemon_request() {
      echo "$1" >> "$EVENTS"
      case "$1" in
        app.exit.request) [ "$FAIL" != exit ] ;;
        app.list)
          if [ "$FAIL" = pending ]; then echo '{"apps":[{"app_id":"whisplay-ai-chatbot","running":true}]}'
          else echo '{"apps":[{"app_id":"whisplay-ai-chatbot","running":false}]}' ; fi ;;
        app.launch) [ "$FAIL" != launch ] ;;
      esac
    }
    if _service_ctl_daemon_app restart; then echo RESULT_OK; else echo RESULT_FAILED; fi
  `, { FIXTURE: dir, EVENTS: `${dir}/events`, FAIL: fail });
  const events = fs.readFileSync(`${dir}/events`, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(events, fail === "exit" ? ["app.exit.request"] : fail === "wait"
    ? ["app.exit.request", "lock"] : fail === "pending" ? ["app.exit.request", "lock", "app.list"]
    : ["app.exit.request", "lock", "app.list", "app.launch"]);
  if (fail === "none") assert.match(result, /SUCCESS\s+RESULT_OK/);
  else { assert.match(result, /RESULT_FAILED/); assert.doesNotMatch(result, /SUCCESS/); }
});

test("launcher forwards TERM and waits only for its own Node job, preserving other jobs", () => {
  const source = read("run_chatbot.sh");
  const functions = source.slice(source.indexOf('chatbot_pid=""'), source.indexOf("trap 'stop_chatbot; exit 130'"));
  const output = shell(functions + `
    sleep 30 & external=$!
    trap 'kill "$external" 2>/dev/null; wait "$external" 2>/dev/null' EXIT
    sleep 30 & chatbot_pid=$!
    stopped="$chatbot_pid"
    stop_chatbot
    if kill -0 "$stopped" 2>/dev/null; then exit 21; fi
    kill -0 "$external" || exit 22
    stop_chatbot
    echo EXACT_CHILD_EXITED
  `);
  assert.match(output, /EXACT_CHILD_EXITED/);
});

test("all supported production launch paths converge on the lock before services", () => {
  const launcher = read("run_chatbot.sh"), registration = read("scripts/register-whisplay-daemon-app.js");
  assert.equal(JSON.parse(read("package.json")).scripts.start, "bash run_chatbot.sh");
  assert.ok(launcher.indexOf("acquire_app_lock") < launcher.indexOf("prepare_ollama"));
  assert.ok(launcher.indexOf("acquire_app_lock") < launcher.indexOf("amixer -c"));
  assert.match(registration, /launch_command: `bash \$\{launchScript\}/);
  assert.match(launcher, /node dist\/index\.js &/);
  assert.doesNotMatch(launcher, /npm start|yarn start|while true/);
});
