import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const script = path.resolve(__dirname, "../../scripts/ollama-ownership.sh");
function shell(code: string, env: Record<string, string> = {}) {
  return execFileSync("bash", ["-c", 'source "$1"\n' + code, "ownership-test", script], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
}

for (const serve of ["true", "false"]) test(`healthy external Ollama is reused and never killed (SERVE_OLLAMA=${serve})`, () => {
  const result = shell(`
    kill() { echo UNEXPECTED_SIGNAL; return 1; }
    ollama_endpoint_healthy() { return 0; }
    ollama() { echo UNEXPECTED_START; return 1; }
    prepare_ollama http://127.0.0.1:11434 ${serve} || exit 9
    [ -z "$ollama_owned_pid" ] || exit 10
    cleanup_owned_ollama
    echo EXTERNAL_UNTOUCHED
  `);
  assert.match(result, /external server detected.*startup skipped/);
  assert.match(result, /EXTERNAL_UNTOUCHED/); assert.doesNotMatch(result, /UNEXPECTED_START|UNEXPECTED_SIGNAL|stopping chatbot-owned/);
});

test("unavailable endpoint with auto-start owns and cleans only the exact child PID", () => {
  const result = shell(`
    sleep 30 & external=$!
    trap 'cleanup_owned_ollama; kill "$external" 2>/dev/null; wait "$external" 2>/dev/null' EXIT
    probes=0
    ollama_endpoint_healthy() { probes=$((probes+1)); [ "$probes" -gt 1 ]; }
    ollama() { [ "$1" = serve ] || exit 12; echo "START_HOST=$OLLAMA_HOST KEEP_ALIVE=$OLLAMA_KEEP_ALIVE"; exec sleep 30; }
    prepare_ollama http://localhost:11434 true || exit 13
    owned="$ollama_owned_pid"
    [ -n "$owned" ] && [ "$owned" != "$external" ] || exit 14
    kill -0 "$owned" || exit 15
    cleanup_owned_ollama
    if kill -0 "$owned" 2>/dev/null; then exit 16; fi
    kill -0 "$external" || exit 17
    [ -z "$ollama_owned_pid" ] || exit 18
    cleanup_owned_ollama
    echo EXACT_PID_CLEANED
  `);
  assert.match(result, /START_HOST=0.0.0.0:11434 KEEP_ALIVE=-1/);
  assert.match(result, /stopping chatbot-owned PID \d+/);
  assert.match(result, /EXACT_PID_CLEANED/);
});

test("unavailable endpoint with auto-start disabled reports failure without spawning", () => {
  const result = shell(`
    ollama_endpoint_healthy() { return 1; }
    ollama() { echo UNEXPECTED_START; return 1; }
    if prepare_ollama http://localhost:11434 false 2>&1; then exit 19; fi
    cleanup_owned_ollama
    [ -z "$ollama_owned_pid" ] || exit 20
  `);
  assert.match(result, /endpoint unavailable.*SERVE_OLLAMA=false/); assert.doesNotMatch(result, /UNEXPECTED_START/);
});

test("failed child start clears ownership and cannot kill another process", () => {
  const result = shell(`
    sleep 30 & external=$!
    trap 'cleanup_owned_ollama; kill "$external" 2>/dev/null; wait "$external" 2>/dev/null' EXIT
    ollama_endpoint_healthy() { return 1; }
    ollama() { return 1; }
    if prepare_ollama http://localhost:11434 true 2>&1; then exit 21; fi
    [ -z "$ollama_owned_pid" ] || exit 22
    cleanup_owned_ollama
    kill -0 "$external" || exit 23
    echo FAILED_START_SAFE
  `);
  assert.match(result, /exited before becoming healthy/); assert.match(result, /FAILED_START_SAFE/);
});

test("a bind race reuses the winning external server without retaining the dead child's PID", () => {
  const result = shell(`
    probes=0
    ollama_endpoint_healthy() { probes=$((probes+1)); [ "$probes" -gt 2 ]; }
    ollama() { return 1; }
    prepare_ollama http://localhost:11434 true || exit 24
    [ -z "$ollama_owned_pid" ] || exit 25
    cleanup_owned_ollama
  `);
  assert.match(result, /external server detected after startup race/);
  assert.doesNotMatch(result, /stopping chatbot-owned/);
});

test("an unhealthy owned server is stopped after bounded startup attempts", () => {
  const result = shell(`
    trap cleanup_owned_ollama EXIT
    ollama_endpoint_healthy() { return 1; }
    ollama() { exec sleep 30; }
    sleep() { command sleep 0.001; }
    if prepare_ollama http://localhost:11434 true 2>&1; then exit 26; fi
    [ -z "$ollama_owned_pid" ] || exit 27
  `);
  assert.match(result, /did not become healthy/); assert.match(result, /stopping chatbot-owned PID/);
});

for (const [label, payload, status, healthy] of [
  ["version API", '{"version":"0.fixture"}', "0", true],
  ["open port with HTML", "<html>not Ollama</html>", "0", false],
  ["wrong JSON", '{"status":"ok"}', "0", false],
  ["empty version", '{"version":""}', "0", false],
  ["HTTP/transport failure despite JSON", '{"version":"0.fixture"}', "22", false],
] as [string, string, string, boolean][]) test(`endpoint health verifies expected HTTP API: ${label}`, () => {
  const result = shell(`
    curl() { printf '%s' "$PROBE_PAYLOAD"; return "$PROBE_STATUS"; }
    if ollama_endpoint_healthy http://localhost:11434; then echo HEALTHY; else echo UNHEALTHY; fi
  `, { PROBE_PAYLOAD: payload, PROBE_STATUS: status });
  assert.equal(result.trim(), healthy ? "HEALTHY" : "UNHEALTHY");
});

test("unavailable remote endpoint is not falsely repaired by starting a default local server", () => {
  const result = shell(`
    ollama_endpoint_healthy() { return 1; }
    ollama() { echo UNEXPECTED_START; }
    if prepare_ollama http://remote.invalid:11434 true 2>&1; then exit 28; fi
  `);
  assert.match(result, /configure.*externally/); assert.doesNotMatch(result, /UNEXPECTED_START/);
});

test("launcher wires environment, owned cleanup and signal traps without pattern-based termination", () => {
  const launcher = fs.readFileSync(path.resolve(__dirname, "../../run_chatbot.sh"), "utf8");
  const ownership = fs.readFileSync(script, "utf8");
  assert.match(launcher, /source "\$working_dir\/scripts\/ollama-ownership.sh"/);
  assert.match(launcher, /trap cleanup_owned_ollama EXIT/);
  assert.match(launcher, /trap 'exit 143' TERM/);
  assert.match(launcher, /prepare_ollama .*\|\| exit 1/);
  assert.doesNotMatch(launcher + ownership, /\b(pkill|pidof)\b/);
});

test("TERM exits through idempotent exact-child cleanup", () => {
  assert.throws(() => shell(`
    trap 'cleanup_owned_ollama; echo CLEANUP_DONE' EXIT
    trap 'exit 143' TERM
    probes=0
    ollama_endpoint_healthy() { probes=$((probes+1)); [ "$probes" -gt 1 ]; }
    ollama() { exec sleep 30; }
    prepare_ollama http://localhost:11434 true || exit 29
    kill -TERM "$$"
  `), (error: any) => {
    assert.equal(error.status, 143);
    assert.match(error.stdout, /stopping chatbot-owned PID \d+/);
    assert.match(error.stdout, /CLEANUP_DONE/);
    return true;
  });
});

test("endpoint diagnostics do not expose URL credentials or query secrets", () => {
  const result = shell(`
    ollama_endpoint_healthy() { return 0; }
    prepare_ollama 'http://user:PRIVATE_PASSWORD@localhost:11434/private?token=PRIVATE_TOKEN' true
  `);
  assert.match(result, /http:\/\/localhost:11434/);
  assert.doesNotMatch(result, /PRIVATE_|user:|\/private/);
});
