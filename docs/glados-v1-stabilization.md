# GLaDOS v1 stabilization and physical acceptance

Date: 2026-10-17. Starting revision: `fa4c2e1`, branch `tts-pipeline-fix`.
This work is local Windows implementation/validation. Nothing was published,
deployed, or tested against Raspberry Pi. The existing Pi selection of
`ASSISTANT_PERSONA=glados` is already confirmed by the user; it is not a source bug.

## Implemented corrections and evidence

| Confirmed source behavior | Correction | Location |
| --- | --- | --- |
| GLaDOS had an absolute three-sentence restriction, including explanations. The prompt did not expressly discourage irrelevant personal observations/follow-up questions. | Contextual brevity, explicit detail requests allowed, no invented surroundings or irrelevant personal embellishment. Character, serious-topic rule and persona selection preserved. | `src/config/persona.ts:19` |
| `buildMemoryPrompt` injected the newest five not-yet-recalled facts regardless of the current subject. A fresh greeting could receive a color fact. | Require meaningful word overlap before automatic fact injection. Preserve explicit recall and relevant personalization. A deterministic favorite query cannot match an unrelated mere mention through the loose fallback. | `src/config/local-memory.ts:400`, `:425`, `:623` |
| The recency rule matched `today` and `tonight` before distinguishing feelings/stories. Explicit search for static facts did not outrank the concise-answer heuristic. | Whole personal/creative requests bypass automatic search and cannot be offered `web_search`. Explicit web-search intent outranks answer formatting. Mixed/current/ambiguous requests retain eligibility. | `src/config/web-search-router.ts:30`, `:48`, `:64` |
| The launcher had no exclusive lock; imports spawned local speech servers without checking existing compatible services. `npm start` could bypass the launcher. | One per-user Linux `flock` before audio/service side effects; inherited lock required by the Linux entry point; npm uses the same launcher. Preflight the display port, reuse compatible speech servers, spawn only when the port is free. | `scripts/app-lock.sh`, `run_chatbot.sh:14`, `src/utils/app-launch-lock.ts`, `src/utils/local-services.ts`, `src/index.ts` |
| Display used `exec` with a shell child, then killed that shell rather than reliably owning Python. Separate signal handlers called `process.exit` without waiting for other cleanup. | Spawn the actual Python process, wait for its own bind announcement, centrally stop owned children before exiting. Track SoX/curl/wakeword children without altering their processing arguments. | `src/device/display.ts:170`, `src/utils/app-lifecycle.ts` |
| Daemon restart waited a fixed two seconds then requested launch regardless of whether the previous app had exited. | Wait for lock release and daemon `app.list` confirmation; fail without relaunch if either check fails. Propagate failed exit/launch requests. | `cli/service.sh:163`, `:175` |

The user's exact blue reference cannot be uniquely attributed to saved memory
versus existing conversation history without the corresponding Pi request
payload. The indiscriminate injection path is confirmed and corrected. Recent
history and explicitly configured `MEMORY_PROFILE_TEXT` remain intact. No facts
are erased, migrated or bulk-reclassified. Summaries remain model-generated;
neither summaries nor model prose have a deterministic semantic truth validator.
The relevance filter is lexical, not an embedding retriever. Synonyms can miss
automatic personalization; explicit memory tools/commands remain available.

Search path: `needsCurrentInformation` controls prefetch;
`toolsRelevantTo` uses `isCasualConversation` to exclude the search schema;
the unchanged centralized dispatcher rejects unoffered native calls, and the
existing JSON fallback cannot execute them. Tests assert actual search-handler
invocations and request schemas, not just UI placeholders. The deterministic
guard is intentionally English and narrow; it is not a universal intent parser.

## Lifecycle contract and limits

* Supported Linux starts are `bash run_chatbot.sh`, `npm start`/`yarn start`,
  existing systemd launcher and registered daemon launcher. All converge on
  `run_chatbot.sh`. Direct `node dist/index.js` is rejected on Linux before
  application imports unless it has the expected inherited lock FD/inode.
* Lock: `/tmp/whisplay-chatbot-<uid>/application.lock`, private owner directory,
  descriptor 9. Duplicate exit status 73. Never delete the lock file as a
  recovery action: kernel ownership, not file existence, defines a running app.
  An unlocked leftover file is reused. This is a per-user Linux guarantee,
  not a cross-user hardware lock or a Windows single-instance implementation.
* The display port is checked before hardware import. Python is started without
  a shell, and Node connects only after that child emits its existing
  `[Socket] Listening on` message. Display readiness is bounded to 60 seconds;
  connection attempts have a five-second timeout and at most 15 attempts, with
  five-second gaps. Errors reject the startup path rather than silently hanging.
* The display/daemon connection starts before cold speech-service preparation,
  so exit/focus handling need not wait for model loading. Conversation providers
  are imported after readiness. No display layout, socket protocol or speech
  synchronization algorithm changed.
* Piper compatibility: a nonempty string list from `/voices`, or the configured
  synthesis endpoint rejecting empty input specifically for missing text.
  Faster-Whisper compatibility: the repository's `/recognize` response to `{}`
  is HTTP 400 with `error: "Invalid JSON"`. These probes do not submit audio or
  synthesize speech. Per-probe timeout: 1.5 seconds, response cap: 64 KiB.
* An occupied incompatible or not-yet-ready port causes a clear startup failure.
  No port owner is killed or adopted. Remote hosts remain externally managed.
  New local speech children have a 120-second readiness window each; one probe
  and polling interval can extend the observed deadline slightly. These limits
  are conservative engineering choices, not Pi cold-start measurements.
* Shutdown aborts startup and active conversation work, runs cleanup hooks,
  sends TERM to owned ChildProcess objects/groups, escalates after three seconds,
  and rejects cleanup after five seconds if exit was not observed (application
  shutdown exits nonzero). A failed signal is not evidence of child exit.
  Duplicate cleanup calls share one promise. Naturally exited children
  lose ownership so stale PIDs cannot be reused for termination.
* The launcher forwards TERM/INT only to its own live Node job, waits up to ten
  seconds before escalation, and retains the existing exact-child Ollama cleanup.
  Externally managed Ollama, Whisper and Piper never acquire chatbot ownership.
* Daemon restart waits up to 15 seconds for lock release, then up to 20 seconds
  for `app.list` to report `running=false` (plus a bounded in-flight daemon call).
  A successful launch request is not proof of readiness. The daemon itself is
  in a separate repository and its pending-launch behavior must be tested on Pi.
* This is coordinated ownership/cleanup, not a new supervisor: no respawn loops,
  retries that duplicate processes, broad process-name kills or port-owner kills.
  SIGKILL of Node, a blocked kernel task, power loss, and arbitrary external
  plugins cannot be guaranteed graceful cleanup. Do not force a second launch
  past a failed lock/port check; inspect the specific leftover owner first.

## Responsiveness assessment

The implemented improvements remove confirmed unnecessary web-prefetch work and
unrelated automatically injected facts, allow brief greetings, and avoid duplicate
local-service starts. There is **no measured Pi latency improvement claim**.

The reported 656-token/13.1-second prompt evaluation and 37-token/4.2-token-per-second
generation sample demonstrates CPU inference cost; it does not establish cache
hit rates or a controlled model comparison. Effective 4096-token budgeting,
keep-alive, load-only warmup, history trimming, summary scheduling, model
configuration, output limits, Piper sentence scheduling and audio format remain
unchanged. No RAM-pressure optimization is justified by the reported 10 GiB
available and zero swap use.

Measure separately on the same model/configuration:

1. End of user speech to ASR completion (`[ASR time]`).
2. Ollama request to first emitted token (`[Ollama timing]`); a token can be
   thinking/tool output, not speakable text. Metadata/prefetch occur outside
   parts of this timing, so it is not end-to-end latency.
3. First speakable text, sentence queueing, Piper synthesis and SoX start using
   existing `[AudioTiming]` logs. Their origin is first answer text, not the
   microphone's end-of-speech timestamp.
4. Actual first audible sound and response end, measured by a recording or
   stopwatch. Do not equate a software playback-start timestamp with sound.

Compare three matched samples for cold model, loaded model with uncached prompt,
and repeated warm prefix. Record model/runtime context and question order;
do not restart a shared Ollama merely to obtain a cold sample. Prompt/tool list
changes invalidate cache prefixes. A prior context-window capacity label is not
evidence of a 40960-token active slot.

## Changed files

Production and startup:

* `src/config/persona.ts`: contextual answer length and personal-detail guidance.
* `src/config/local-memory.ts`: relevant automatic retrieval and favorite fallback.
* `src/config/web-search-router.ts`: local conversation/creative intent and explicit-search priority.
* `scripts/app-lock.sh` (new): acquire/wait for the per-user kernel lock.
* `run_chatbot.sh`: lock first, direct owned Node job, forwarded/bounded stop.
* `src/utils/app-launch-lock.ts` (new): inherited Linux lock guard.
* `src/utils/app-lifecycle.ts` (new): owned-child cleanup and app shutdown boundary.
* `src/utils/local-services.ts` (new): non-destructive compatibility/readiness checks.
* `src/index.ts`: exclusive bootstrap, early daemon/display connection, speech readiness.
* `src/cloud-api/local/faster-whisper-asr.ts`: remove import-time server spawn/exit handlers; recognition payload unchanged.
* `src/cloud-api/local/piper-http-tts.ts`: move server ownership to bootstrap; track request children; synthesis settings unchanged.
* `src/device/audio.ts`: track owned audio children; remove immediate-exit signal handler.
* `src/device/wakeword.ts`: track its owned child.
* `src/device/display.ts`: own Python directly, confirm readiness, coordinated exit.
* `cli/service.sh`: confirmed/bounded restart ordering and error propagation.
* `package.json`: launcher entry for `start` and two new test suites; no dependencies changed.

Tests:

* `src/test/persona.spec.ts`: prompt contract, safety and size checks.
* `src/test/memory.spec.ts`: irrelevant facts absent, relevant facts/direct recall/persistence retained, no favorite invention through deterministic fallback.
* `src/test/web-search.spec.ts`: intent priority, explicit/mixed requests, native/JSON denials, actual prefetch effects.
* `src/test/ollama-ownership.spec.ts`: revised TERM trap wiring assertion; existing ownership regressions retained.
* `src/test/app-lifecycle.spec.ts` (new): virtual-clock cleanup/readiness/cancellation, real native child termination, loopback API/port tests, bootstrap ordering, display readiness, inherited-lock guard.
* `src/test/app-launcher.spec.ts` (new): mocked flock branches, stale-file reuse, failed restart gating, actual owned shell-job stop, supported launch paths.

Documentation: `AGENTS.md` and this file.

## Local validation

* Baseline: **374/374 passed** (`.test-artifacts/polish-baseline.log`).
* Final focused suites: **98/98 passed** (`polish-targeted-final.log`).
* Final full suite: **414/414 passed, 0 failed, 0 skipped** (`polish-final-full.log`).
* Production TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false` passed.
* Strict test TypeScript: all `src/test/*.spec.ts` plus `src/cloud-api/type.d.ts`,
  `--noEmit --strict --esModuleInterop --skipLibCheck --target ES2020 --module commonjs` passed.
* `bash -n` passed for `run_chatbot.sh`, `scripts/app-lock.sh`, `cli/service.sh`.
* Final `git diff --check` passed; full tracked diff and all new source/test files reviewed.
* All **442 data files** match the existing preserved manifest in SHA-256, size
  and modification time; no missing/added files. No local `.env` exists or was
  created. No configuration template, voice/model asset, dependency or production
  data file changed. Test artifacts stay under ignored `.test-artifacts/`.
* The first interim suite had one obsolete trap-source assertion (384/385);
  it was updated to assert TERM forwarding and backed by an executable shutdown
  test. New test development also found a VM object-prototype assertion and
  Windows FD-inheritance assumption; tests now distinguish native Windows,
  Git Bash and Linux behavior. No tests or assertions were removed to pass.

Windows Git Bash has no native `flock`; kernel exclusion and Node FD inheritance
on Linux are **NOT VERIFIED** here. Lock branch tests use a deliberate `flock`
double and disposable paths. Unix process-group signaling and daemon responses
are mocked; a real Windows Node child and real loopback HTTP sockets are tested.
No actual Whisper/Piper/Ollama instance, ALSA hardware or GPIO was started.

## Future Pi deployment (not executed)

Only after explicit authorization to commit/push, and after that publication
has completed. On the Pi, **`soldercore` is the fork; `origin` is upstream**.
Keep the terminal open so the rollback revision remains available.

```bash
cd ~/whisplay-ai-chatbot
git branch --show-current       # must be tts-pipeline-fix
git status --short              # stop if there are unreviewed local changes
git remote get-url soldercore   # verify this is your fork
GLADOS_PREVIOUS_COMMIT=$(git rev-parse HEAD)
git fetch soldercore tts-pipeline-fix
```

Stop only the chatbot using its currently supported management path:

```bash
whisplay service stop
whisplay service status
pgrep -af 'node .*dist/index[.]js|python3 .*chatbot-ui[.]py'
```

Wait for the old app to report stopped and its Node/display child to disappear.
The old release can still have the known shutdown defect. If it remains, stop
this procedure and diagnose that exact owner; do not manually launch another
instance, delete a lock, kill by a name pattern or restart unrelated services.
Then, with a clean working tree:

```bash
git merge --ff-only soldercore/tts-pipeline-fix
node node_modules/typescript/bin/tsc
# Continue only if compilation succeeds. No npm install or model downloads.
whisplay service start
whisplay service status
pgrep -af 'node .*dist/index[.]js|python3 .*chatbot-ui[.]py'
ss -ltnp | grep -E ':(12345|8803|8805|11434)\b'
tail -n 150 chatbot.log
```

Confirm exactly one primary Node app, one display child, expected port owners,
`[Persona] glados`, and `[Lifecycle] Reusing compatible external ...` for services
already managed externally. Existing app registration still points at
`run_chatbot.sh`; no registration or daemon restart is required. If a service is
chatbot-owned, its readiness line should occur once. Do not publish complete
logs or `.env` values containing private conversation/configuration.

After the first successful new startup, exercise `whisplay service restart`.
It now confirms exit before requesting a new launch. Never use `startup.sh` to
install a competing legacy service on a daemon-managed Pi. Only the chatbot
must restart for this delivery; no daemon/Ollama/Piper/Whisper system-service
restart is requested.

Rollback, if needed: stop via `whisplay service stop`, confirm exit as above,
and ensure the working tree is clean before switching revision:

```bash
git switch --detach "$GLADOS_PREVIOUS_COMMIT"
node node_modules/typescript/bin/tsc
# Only after successful compilation:
whisplay service start
```

This preserves `.env`, ignored user data and models; do not use `git clean` or
`reset --hard`. Detached HEAD is intentional for testing the saved revision.
Returning to the candidate uses the same stop/compile/start procedure with
`git switch tts-pipeline-fix`.

## Exact physical acceptance protocol

Start with the current stored history/memory intact. Speak these in order and
record the answer, actual tool execution and end-of-speech-to-audio time:

| # | Spoken question | Required observation |
| --- | --- | --- |
| 1 | How are you doing today? | Short GLaDOS greeting, no search or unrelated color. |
| 2 | What do you think of humans? | Recognizable dry character; no invented surroundings. |
| 3 | I feel tired today. | Respectful conversation, no automatic/native/JSON web execution. |
| 4 | What is two plus two? | Four, concise and complete. |
| 5 | Explain DNS in one sentence. | One accurate sentence. |
| 6 | Explain in detail why the sky looks blue. | Useful detail allowed beyond the former rigid three-sentence cap. |
| 7 | And why does it look red at sunset? | Correct contextual follow-up without restarting the explanation. |
| 8 | How much RAM are you using? | Actual measurement with explicit GiB/MB; no fabricated qualitative health. |
| 9 | What's your CPU temperature? | Actual °C or honest unavailable result. |
| 10 | What is your CPU usage? | Actual percentage or honest unavailable result. |
| 11 | Search the web for the capital of Norway. Answer in one sentence. | Search executes; concise sourced-result answer, or honest provider failure. |
| 12 | What is the weather in Oslo today? | Current-information search; no fabricated weather if unavailable. |
| 13 | Remind me in two minutes to call the doctor. | Existing truthful unsupported-reminder refusal; no promise of scheduling. |
| 14 | Tell me a bedtime story tonight. | Local story, no web execution. |
| 15 | What color did I mention earlier? | Recall only available evidence; no invented favorite. |

Then ask **"What do you think of humans?"** again. The remembered color must not
be introduced without relevance. Also ask **"What's my favorite color?"**: a
mere test mention must not become a confident favorite claim. If the stored
fact explicitly says favorite, that is valid evidence and should be retained.
Restart normally and verify a known legitimate memory still recalls correctly.

Measurable acceptance:

* Greeting normally one sentence and under 25 words across three trials; no
  cheerful stock assistant language, emojis, repetitive catchphrases or invented
  observations. A single style miss is recorded and assessed, not concealed.
* All routing/action-truth/unit cases above pass. Tool placeholders alone do not
  establish execution. Check tool-result logs and actual provider effects.
* Five stop/start or restart cycles, including one during streamed speech and
  one while inference is pending. One app after each cycle; normal shutdown
  should finish within ten seconds; no surviving chatbot-owned child.
* While the app runs, invoke `bash run_chatbot.sh` once in another terminal.
  Expected exit 73 and a duplicate-refused message before audio/port changes;
  the original conversation remains usable. After normal exit, launch again
  without removing the leftover lock file.
* External service PIDs remain unchanged across chatbot restart. If no external
  speech server exists, exactly one owned instance starts and exits with the app.
  Record `ps`/`ss` before and after; do not stop unrelated services for a test.
* No persistent memories/recordings lost. Real conversation may legitimately
  append history; compare survival of existing files rather than expecting no
  new writes during physical use.
* For three matched runs in each available cache state, compare median time to
  first audible response to the same-model prior release. Proposed regression
  gate: no increase larger than **max(1 second, 10%)**. This is an acceptance
  tolerance, not a promised improvement. Report cold-start time separately.
  If no comparable baseline exists, latency improvement remains NOT VERIFIED;
  the user must explicitly accept the observed experience.

## Verdict and genuine limitations

**Ready for controlled physical acceptance testing**, not declared production
accepted. Local tests verify control flow and invariants, not persona quality,
inference speed, service versions, Linux lock behavior or daemon timing.

* **Blocking for final v1 acceptance:** physical launch/restart, Linux lock/FD
  inheritance, installed speech API compatibility, cold readiness, audio/display
  behavior and the routing/recall acceptance cases must pass. These are required
  validation steps, not confirmed remaining implementation defects.
* **Non-blocking limitations to accept:** CPU inference latency; model-dependent
  stylistic consistency; lexical memory relevance and narrow English routing;
  potential irrelevant references from retained recent history; no guarantee of
  persisting an in-flight summary at forced shutdown; clean shutdown cannot be
  guaranteed after SIGKILL/power loss. Optional/third-party providers have not
  been migrated into a universal child-process sandbox.
* **Optional future work only if measured:** tune thresholds after actual cold
  startup/latency evidence, improve semantic relevance only for demonstrated
  misses. No new architecture, model, memory format, music, image, vision,
  reminder scheduler or agent phase is warranted by this delivery.

Declare v1 finished after the physical correctness/stability gates pass and the
user accepts persona and measured responsiveness on the existing configuration.
No claim of perfect conversation or zero future bugs is required.
