# Agent Core: deterministic speech tests, lifecycle safety and system health

Scope: local Windows repository. No skills/agents/orchestration, dependency
installation, model change, Pi connection, commit, push or deployment.
Baseline before this work: 212/212 tests. Existing data is never a test fixture.

## 1. Speech-test root cause and completed correction

`SpokenTextReveal.followPlan` uses elapsed time and deliberately catches up when
the event loop resumes late. The old test slept 30 + 60 ms and expected the
60 ms word, assuming the 120 ms word was not due. Under load that sleep can
resume after 120 ms, correctly revealing 30 instead of 22. Earlier failed logs
and the new delayed-scheduling test establish that mechanism.

Only `speech-sync.spec.ts` changes: native Node mock timers control Date,
timeouts and intervals; the original reveal/cap/reset assertions remain. A new
test explicitly advances elapsed time past multiple steps and checks catch-up,
then linear reveal and reset. Production speech timing/reveal/audio is unchanged.
40 separate deterministic suite runs passed, 12 tests each (480 test executions).
The full suite then passed 213/213.

## 2. Phase 2D-B: finite execution and propagated cancellation

| Setting | Default | Scope |
| --- | --- | --- |
| `OLLAMA_REQUEST_TIMEOUT_MS` | 7,200,000 (2 h) | Entire public agent request, all rounds/final answer |
| `OLLAMA_STREAM_IDLE_TIMEOUT_MS` | 2,700,000 (45 min) | No new NDJSON transport data |
| `OLLAMA_METADATA_TIMEOUT_MS` | 300,000 (5 min) | Context metadata and load-only warmup |
| `OLLAMA_SUMMARY_TIMEOUT_MS` | 300,000 (5 min) | Background memory summary, cancelled by a new question/summary |
| `TOOL_EXECUTION_TIMEOUT_MS` | 120,000 (2 min) | One admitted tool operation |
| `SYSTEM_HEALTH_TIMEOUT_MS` | 10,000 (10 s) | Health sampling/status collection |
| Existing `WEB_TOOL_TIMEOUT_MS` | 30,000 | One HTTP fetch including its body |

Invalid, non-positive, fractional or >2 h settings fall back to finite defaults.
These are host settings, not model arguments. Defaults were revised during
review: the repository records roughly 15 prompt tokens/s on Pi; an uncached
32k context can take over 35 minutes before generation. 30 min total / 10 min
idle would be unnecessarily aggressive. The final 2 h / 45 min defaults are
conservative ceilings, not a new Pi benchmark. Tune only from physical tests.

`operationDeadline` links an AbortController to its parent and owns its timer.
`waitForOperation` settles waiting and removes its listener; it explicitly does
not pretend to kill arbitrary work. Actual I/O receives the same cancellation:
Axios gets the signal, NDJSON abort/timeout destroys its stream, web fetch and
body readers are aborted/cancelled, and fixed child processes are killed.
Late Axios responses are destroyed without parsing. A queued abort error is
consumed until stream close, then its temporary error listener is removed.

The public Ollama boundary ends each response once after cleanup. Timeout emits
host text: `The request timed out. Completion was not verified.` It removes only
the unexecuted pending proposal, preserving earlier completed call/result rounds.
Previously emitted speech is not retracted and completed side effects are not
undone. User cancellation/new questions retain the pre-existing rule of dropping
the abandoned turn, suppressing its late text/tool events. Leaving ChatFlow's
answer state invokes the provider's optional cancellation hook.

Request-local AsyncLocalStorage also replaces the shared LLM recursion counter.
A new explicit memory command must be treated as a new request even while an
older model answer is pending; the regression initially failed 26/27, then
passed 27/27 after the correction. Memory format/commands remain unchanged.
Context compaction checks cancellation after metadata resolution before mutating
history, preventing abandoned compaction from changing a newer conversation.

Native/fallback/automatic-search calls still use the central executor, exact
offered list, enabled flag, reserved-name block and original schema validation.
No retry or alternative tool-execution path is added.

### Trusted handler contract and compatibility boundary

Every registered handler must now explicitly declare `execution: "bounded"`
(short synchronous/local work) or `execution: "abortable"` (obeys the current
tool signal through its entire operation). This is host-owned metadata, hidden
from JSON serialization, not a model-supplied capability. The central executor
rejects missing contracts; Ollama does not offer those tools. A declaration is
**not proof, isolation or a sandbox**. Trusted plugin code must actually honor it.
Arbitrary in-process JavaScript cannot be forcibly stopped without isolation.

Migrated: volume, local-memory tools, web search/page fetch (including legacy
providers), MemPalace tools, conversation termination, showing existing images,
and system health. Other code/registration remains present but fails closed:
`generateImage`, `describeImage`, `playMusic`, `playMusicRandom`, `listSkills`,
`readSkill`, and external tools without a tested contract. Do not restore these
by merely adding a flag: first bound their work and propagate cancellation.
Adapting those optional backends safely is a remaining compatibility task.

## 3. Phase 2D-C: process and resource ownership

- At most four outer tool operations are admitted per Node process; nested
  validation wrappers inherit the same signal/budget. Busy work rejects rather
  than queuing/retrying. Tool output is limited to 65,536 UTF-8 bytes; excessive
  output becomes unverified without retaining it in model history.
- Web bodies are limited to 2 MiB before HTML/JSON parsing. The deadline covers
  headers and full body, not just receipt of headers. Cancellation prevents
  the existing news-search fallback from starting another HTTP operation.
- Existing Phase 2D-A limits remain: 4 calls/response, 8 attempts/request,
  1 MiB/NDJSON record, 2 MiB/response, 8 MiB/request transport, 256 KiB decoded
  content+thinking/response, plus the existing configured tool-round limit.
- Agent input is limited to 256 KiB UTF-8 serialized bytes. Conversation history
  has safety ceilings of 200 messages and 4 MiB, in addition to normal token
  compaction. Old turns are discarded as whole units, keeping tool proposals and
  results together. A single oversized turn is explicitly omitted/unverified.
  No existing archive files, facts or memory stores are deleted or migrated.
- Volume uses fixed `execFileSync("amixer", args)` invocations, never a shell,
  with 5 s timeout, SIGKILL and 64 KiB output cap. Mixer selection, values and
  hardware configuration are unchanged. It can block the event loop up to its
  finite timeout; conversion to a different playback/mixer architecture is not
  part of this change.
- MemPalace has at most two owned processes, 30 s timeout and 512 KiB combined
  stdout/stderr. Linux children have a dedicated process group; cancellation
  kills the group with SIGKILL. Windows kills the direct child. Promises settle
  after close/error; timers/listeners/process slots are cleaned once. UTF-8
  decoding spans output chunks. Existing fixed CLI/scripts and stdin JSON remain.
  The generic shell runner is not restored.

Tests simulate Linux process-group kill and verify native Windows child exit
using a disposable Node child, never a real service or memory CLI. No process
retry is introduced. Existing same-response duplicate calls and independent
user requests are not an exactly-once transaction protocol; semantic duplicate
policy remains separate from lifecycle cleanup.

## 4. Phase 3: read-only system health

`getSystemHealth` has an empty argument schema and routes through the same
registry/authorization/execution lifecycle. The router offers it for explicit
system/CPU/memory-usage/disk/temperature/uptime/service-status requests, including
`GLaDOS, how is your system doing?`, not ordinary conversation.

Measurements: two `os.cpus()` counter samples over an actual ~100 ms interval;
Linux load averages; `/proc/meminfo` total/free/available/swap; `statfs` for the
assistant data filesystem; uptime; CPU temperature only when the fixed thermal
zone reports a recognized CPU sensor type. Read buffers are capped at 16 KiB
and file descriptors are closed. Missing/inconsistent metrics are null.
Portable Windows metrics are retained; Linux-only fields remain unavailable.

The only diagnostic command is `systemctl show --no-pager` with properties
Id/LoadState/ActiveState/SubState and these fixed units: chatbot.service,
whisplay-daemon.service, ollama.service, whisplay-whisper.service,
whisplay-piper.service. It uses an argument array, 5 s timeout, SIGKILL and
16 KiB output limit. No status logs, environment, credentials, arbitrary files,
commands, service names or paths are accepted from the model. Partial results
survive another unit being absent. Unit status does not establish backend health.

Deterministic tests independently specify expected values, missing metrics,
Windows behavior, authorization denials, cancellation, timeout, allowed commands
and secret-field exclusion. A real provider/registry/executor conversation with
mocked OS counters verifies the actual measurement JSON reaches the model's next
request and the normal response callback. It does not prove model tool selection
or physical measurements on Pi.

## 5. Validation and remaining boundaries

Checkpoints: speech 213/213; Phase 2D-B 233/233; Phase 2D-C 242/242; initial
Phase 3 254/254. Subsequent review added the memory-request isolation regression
and partial-service/cancelled-fallback tests. Final results are reported below.
Logs remain under ignored `.test-artifacts/upgrade-*`, including reproduced
failures. No assertion was weakened. Existing source/data preservation is checked
against the pre-work SHA-256/size/mtime manifest, not just Git status.

This is **not application-wide hard real-time cancellation**: RAG prompt
preparation before the public Ollama entry, non-Ollama provider streams, ASR/TTS
and optional backend startup/indexing retain their previous lifecycles. The
covered agent path is Ollama plus migrated tools. RAG/provider cancellation and
the blocked optional tools require separate tested adapters. Native synchronous
OS calls cannot be interrupted by JS timers; kernel stalls or dishonest trusted
plugins cannot be ruled out by a Promise race. Process-group descendants that
deliberately escape their group would need stronger OS isolation.

The existing spoken reminder guard, ASR name hint, voice/persona, model selection,
Piper/Faster-Whisper, display/speech rendering and persistent memory formats stay
unchanged. Only local-memory tool metadata and LLM-request isolation change around
the memory path. No disk-retention cleanup deletes archived conversations,
recordings, voices, models or unknown user files.

## 6. Later deployment and physical validation (not performed)

These changes are uncommitted and unpushed. A git pull alone does not deploy
them. After separate authorization and transfer of reviewed source to the actual
checkout, check installed plugins against the lifecycle contract and confirm
LLM_SERVER=ollama. If RAG is enabled, its pre-generation lifecycle is not covered
by these guarantees. Do not enable blocked tools without migration/testing.

Tests here use Node 22.23.2. Native mock-timer Date/setTime support requires at
least Node 20.11 per the official Node 20 test API documentation; existing
dependencies may require a newer 20.x. No Node upgrade was installed here.

```bash
cd ~/whisplay-ai-chatbot
node --version
npm test
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/typescript/bin/tsc --incremental false
whisplay service restart
whisplay service status
```

The compile command avoids build.sh/npm build cleanup and daemon registration.
Restart only the chatbot process/app, via the repo CLI (systemd chatbot.service
or its whisplay-daemon-managed app). Ollama, Whisper and Piper do not need restart;
no model, ASR/TTS or service unit changed. No daemon-reload is required.

On Pi verify cold/long-context prefill, long streaming answers, interrupt/new
question during generation and active web/health/MemPalace work, late error
cleanup, no leftover child processes, real mixer behavior, memory/reminder
continuity and unchanged voice/display/audio timing. Compare diagnostic values
with the OS, actual mounts/thermal sensor, service unit names/permissions and
whether the chatbot is daemon-managed. Measure latency/memory over repeated
requests. Physical Pi behavior and installed configuration are **NOT VERIFIED**.

## 7. Final verified local result

- Complete suite: **257/257 passed**, **0 failed**, **0 skipped**, **0 cancelled**
  (`.test-artifacts/upgrade-final-full.log`). This is 212 baseline + 45 new tests;
  the existing Python ASR contract suite remains included, not double-counted.
- Production TypeScript: `tsc --noEmit --incremental false` passed.
- Strict TypeScript for all **19** spec files passed.
- `git diff --check` passed; full tracked diff and all new source files reviewed.
- Speech suite: **40/40** separate deterministic runs, **480** test executions.
- Actual owned Node child cancellation/exit tested locally; Linux process-group
  semantics, metrics and systemctl behavior use deterministic test doubles.
- The concurrent memory-command defect was reproduced before its fix; no old
  speech assertions, security assertions or resource-boundary tests were weakened.
- **442 existing data files unchanged** by SHA-256, size and mtime. **247** other
  pre-existing project files retain their hashes, including ASR, Piper, persona,
  reminder matcher, rendering and startup-data protection. No test targets voice
  assets/models or production data. No dependency changes or generated dist.

Complete changed-file manifest (28 existing files, 10 additions):

```text
.env.template
AGENTS.md
package.json
src/cloud-api/context-window.ts
src/cloud-api/llm.ts
src/cloud-api/local/ollama-llm.ts
src/cloud-api/local/ollama-ndjson.ts
src/config/image-generation.ts
src/config/llm-tools.ts
src/config/local-memory.ts
src/config/mempalace.ts
src/config/tool-execution.ts
src/config/tool-router.ts
src/config/vision.ts
src/config/web-search.ts
src/core/ChatFlow.ts
src/plugin/builtin/llm-tools.ts
src/plugin/builtin/llm.ts
src/plugin/types.ts
src/test/ollama-history.spec.ts
src/test/ollama-resources.spec.ts
src/test/ollama-stream.spec.ts
src/test/ollama-tool-security.spec.ts
src/test/speech-sync.spec.ts
src/test/tool-execution.spec.ts
src/test/unsupported-reminder.spec.ts
src/type/index.ts
src/utils/volume.ts
docs/agent-core-upgrade-phase2db-3.md (new)
src/cloud-api/local/ollama-history-limits.ts (new)
src/config/system-health.ts (new)
src/test/ollama-history-limits.spec.ts (new)
src/test/ollama-lifecycle.spec.ts (new)
src/test/operation-lifecycle.spec.ts (new)
src/test/process-lifecycle.spec.ts (new)
src/test/system-health.spec.ts (new)
src/test/web-lifecycle.spec.ts (new)
src/utils/operation-lifecycle.ts (new)
```
