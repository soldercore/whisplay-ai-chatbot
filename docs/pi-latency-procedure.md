# Pi latency measurement procedure

**Reliability revision:** read [diagnostic-reliability.md](diagnostic-reliability.md).
The helper now supervises its children and writes filtered JSONL directly.
Read-only display preflight is available while production remains running.

Do not execute the interruption/test steps until the user agrees to the test
window. **Nothing in these helpers stops services, restores Qwen, edits `.env`,
unloads models, upgrades Ollama or installs models.** Intended baseline is not
proof that it currently runs. All inferencing commands refuse PC/cloud execution.

Use the same Linux account as the existing chatbot. Different-user or older
lockless launchers and other Ollama clients are outside the per-user application
lock: stop this procedure if exclusive access cannot be established. The source
branch is independent of experimental PR #2; do not merge either PR for this test.

## Read-only preparation

From Windows PowerShell, connect with normal existing SSH credentials:

```powershell
ssh YOUR_PI_USER@YOUR_PI_HOST
```

On the Pi, substitute the existing absolute application path once. These commands
create a **new** review worktree, without changing the running checkout/branch.
Do not overwrite an existing review directory.

```bash
ACTIVE=/absolute/path/to/existing/whisplay-ai-chatbot
REVIEW="${ACTIVE}-latency-review"
git -C "$ACTIVE" fetch origin refs/heads/diagnostics/voice-latency:refs/remotes/origin/diagnostics/voice-latency
git -C "$ACTIVE" worktree add --detach "$REVIEW" refs/remotes/origin/diagnostics/voice-latency
cd "$REVIEW"
ln -s "$ACTIVE/node_modules" node_modules
umask 077
mkdir -p .test-artifacts/latency
git rev-parse HEAD
bash scripts/pi-latency.sh plan
ps -C node -o pid=,comm=
```

Identify the actual chatbot Node PID by inspecting its working directory
(`readlink /proc/PID/cwd`); do not select an ASR/TTS or unrelated Node process.
Then run the read-only inspection, substituting that PID:

```bash
bash scripts/pi-latency.sh inspect ACTUAL_CHATBOT_NODE_PID > .test-artifacts/latency/inspection.jsonl
```

The helper reads only allowlisted configuration fields from the process's initial
environment and its on-disk `.env`, hashes the compiled entry, identifies the
on-disk Git commit, samples hardware, and requests loopback `/api/version`,
`/api/tags`, `/api/ps`. No prompt or inference is submitted. It does not print
credentials or a full environment. If the file config is absent it reports empty
declared fields; do not fabricate a replacement config.

Initial process environment and on-disk files **cannot conclusively prove loaded
runtime configuration**: dotenv changes may not appear in `/proc`, files/builds
can change after launch, and services can supply overrides. Record that limit.
Correlated `runtime_config` and `llm_submit` in the instrumented run are the later
runtime evidence. If current model/persona is Gemma/D or unknown, **do not silently
restore it**. Resolve the discrepancy with the user first. Also confirm context
4096, thinking false, runtime 0.34.4, exact installed digest, backend selection,
and absence of competing clients. Multiple resident models block warm tests.

Inspect the difference between the installed source revision and review branch.
If installed code has additional custom work, resolve that compatibility review
before running a stable-based candidate. A source commit or compiled-file hash
alone is not proof of which code a running process previously loaded.

Build only in the separate review worktree, using existing dependencies:

```bash
cd "$REVIEW"
node_modules/.bin/tsc --incremental false
```

Do not run `npm run build`, the daemon registration script, provisioning or an
installer: those are outside this measurement procedure. No dependency upgrade
is needed. Compiler failure stops the procedure.

Run the read-only preflight **before requesting or performing any interruption**.
Production may keep running; the preflight does not acquire its application lock:

```bash
WHISPLAY_DIAGNOSTIC_RUNTIME_DIR="$ACTIVE" \
  bash scripts/pi-latency.sh check --confirm-idle > .test-artifacts/latency/voice-preflight.json
```

It checks selected Python imports, font/emoji resources, UI files, pidfd support,
current compiled diagnostic modules and the existing local model configuration.
No hardware is initialized, no app is registered, and success is not a hardware
startup guarantee. Missing ignored Python assets can be read from the explicitly
supplied production runtime directory; no extra font/emoji symlinks or downloads
are needed. The archive is optional, the runtime SVG directory is checked.
On failure, inspect the structured checks and keep production running unchanged.

## Agreed interruption and three real voice interactions

This phase needs temporary interruption of the chatbot and a foreground run of
the diagnostic build. It preserves the production checkout, config and daemon
registration. It does **not** restart the Pi or Ollama.

For the already installed custom `whisplay` CLI, after the user approves the
window, request exit of the registered chatbot and confirm release of its lock:

```bash
whisplay service status
whisplay service stop
cd "$REVIEW"
source scripts/app-lock.sh
wait_for_app_unlock
```

Use the current installation's normal controlled exit instead if its lifecycle
differs. If exit/lock release is not confirmed, stop. Do not use `killall`, signal
unknown PIDs, stop speech services, or unload a model to make the test proceed.

The candidate keeps the **existing runtime working directory**, so relative
configuration paths stay unchanged. Its code-relative runtime data directories
must point to the original data. Only create these links if the destinations
are absent in the new worktree; `ln` will refuse existing paths. If production has
no directory, leave that optional link absent. Never remove/overwrite receiver data.

```bash
cd "$REVIEW"
for item in data knowledge plugins; do
  if [ -d "$ACTIVE/$item" ]; then
    if [ ! -e "$REVIEW/$item" ] && [ ! -L "$REVIEW/$item" ]; then
      ln -s "$ACTIVE/$item" "$REVIEW/$item"
    fi
  fi
done
bash scripts/pi-latency.sh snapshot > .test-artifacts/latency/before-voice.json
```

Services with additional environment overrides require the same reviewed normal
environment, without dumping/copying secrets into logs. The helper refuses an
incorrect candidate baseline rather than fixing it. It requires Qwen already
resident alone at 4096; if not, stop and review how to establish that state safely.

Start the supervised foreground run only after the approved interruption and the
successful read-only preflight below. It repeats preflight and acquires the lock.
Stdout is already privacy-safe JSONL; startup failures remain visible on stderr.
Do not add an external collector pipe:

```bash
cd "$REVIEW"
WHISPLAY_DIAGNOSTIC_RUNTIME_DIR="$ACTIVE" \
  bash scripts/pi-latency.sh voice --confirm-idle > .test-artifacts/latency/voice.jsonl
```

Use the Whisplay microphone, normal button/VAD interaction, Piper voice and
speaker. Ask these in order and allow each answer to finish:

1. "Hello GLaDOS, how are you?"
2. "Explain what DNS does."
3. "I spent twenty minutes looking for my phone. It was in my pocket."

Record test order locally; the diagnostic JSON contains no transcripts. Do not
change personality, generation limits or tools to shorten answers. Optionally
record a phone video with audio, measuring actual end of speech to the first
audible word. Keep that recording private; share only the measured intervals and
interaction IDs. The wall-time anchor helps association but is not acoustic proof.

After the three answers, Ctrl-C the **foreground diagnostic run** and wait for
its owned cleanup. The shared per-user lock prevents the normal app launching
beside it. Ctrl+Z requests shutdown rather than suspension; SSH/pipe loss also
triggers bounded owned-child cleanup. If the daemon refuses focus/input for an unregistered foreground
candidate, stop the test and report the launcher issue; do not replace its normal
registration or autostart target. Empty/incomplete logs are not a successful test.

```bash
cd "$REVIEW"
bash scripts/pi-latency.sh snapshot > .test-artifacts/latency/after-voice.json
bash scripts/pi-latency.sh report .test-artifacts/latency/voice.jsonl > .test-artifacts/latency/voice-report.json
```

Operator SIGINT normally retains exit code 130 even with valid completed turns.
The report separates measurement data from session termination status. Empty or
incomplete data is an explicit failure, never successful JSON `[]`. Inspect the
filtered JSONL for selected Python/Node failure metadata, not raw private logs.

The report separates button-release proxy, capture finalization, ASR, context,
model rounds, first text/segment, full audio, playback submission and SoX spawn.
Acoustic speech end, VAD decision, first Piper byte, actual ALSA start and physical
sound remain unavailable unless measured independently. Existing WAV/SoX timing
must not be relabelled as sound reaching the listener.

## Optional bounded Ollama experiments in the same agreed window

Only after the foreground app has exited and no other Ollama client is using the
server. Each command holds the same application lock. No inference is concurrent
with Whisplay. Run these sequentially:

```bash
cd "$REVIEW"
bash scripts/pi-latency.sh benchmark identical --confirm-idle > .test-artifacts/latency/identical.jsonl
bash scripts/pi-latency.sh benchmark incremental --confirm-idle > .test-artifacts/latency/incremental.jsonl
```

Each makes three bounded Qwen calls, with before/after thermal/memory snapshots
and exact residency observations. A model mismatch, duplicate residency, unknown
digest/context or wrong runtime refuses the test. Do not treat the fixed empty
benchmark tool list as equivalent to real tool-enabled voice prompts.

Cold testing is **optional** and requires a naturally nonresident model or a
separately approved way to arrange that state. The helper never evicts models.
With `/api/ps` already empty and all other conditions agreed:

```bash
bash scripts/pi-latency.sh benchmark cold --confirm-idle > .test-artifacts/latency/cold.jsonl
```

It loads Qwen by performing that single requested generation and leaves it
resident; it does not restore a prior model by eviction. If a model is resident,
it refuses. Do not stop Ollama or use a `keep_alive:0` request to manufacture a
cold run under this procedure. CPU clock and temperatures are snapshots, system
CPU use is a counter delta, and `ps %CPU` is a lifetime average. Historical
throttling flags are separate from active ones; changed conditions invalidate
simple cross-run comparisons. Repeat only when comparable conditions can be
established without changing cooling, power or clocks in this task.

## Exact rollback and return data

After the foreground diagnostic child has exited, release/check the lock and
start the original registered application with its unchanged launcher:

```bash
cd "$REVIEW"
source scripts/app-lock.sh
wait_for_app_unlock
bash scripts/pi-latency.sh verify-cleanup .test-artifacts/latency/voice.jsonl
whisplay service start
whisplay service status
```

The environment flag was child-only, so no `.env` rollback, model deletion,
config rewrite, memory restoration or Git reset is required. Original memories
and histories were shared/preserved; the three ordinary test exchanges may add
normal records just as any conversation does. Do not delete those files or
attempt an active-writer restore. If the original installation uses another
manager, use the recorded normal start command instead; do not switch managers.

Return only `inspection.jsonl`, hardware snapshots, benchmark JSONL and filtered
`voice.jsonl`/report, plus optional manually measured acoustic intervals. Never
upload `.env`, recordings, memory stores or an unfiltered service journal. Keep
the review worktree and data links until results are reviewed; no cleanup command
is needed. Restore the original registered app only after verified cleanup and
lock release. If cleanup cannot be verified, report the failure and investigate
owned resources before attempting a restart. Never terminate unrelated processes.
