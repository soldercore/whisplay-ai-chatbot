# Phase 2D-A: bounded Ollama execution and streaming resources

Scope: the existing Windows repository and Ollama agent loop. No skills,
delegation, frameworks, dependencies, SSH, Pi access, commit, push or deployment.
No timeout/cancellation/concurrency architecture, same-response deduplication,
new tool implementation, persistent-memory limit or speech-sync change.

## Confirmed defects and reproduction

The preceding read-only audit found a default four-round limit and a 1 MiB
NDJSON record limit, but no tool-attempt counters, total transport accounting or
accumulated content/thinking limit. Four rounds did not bound the number of
native calls in a response. Complete small records could accumulate indefinitely.
Native and text-fallback calls joined the dispatch path, while automatic search
ran separately before the first model round. Tool metadata was appended before
the new request-wide admission point would need to reject a batch.

Baseline was **149/149 passed**. Before production edits, 17 deterministic tests
were added: **13 failed / 4 passed**. Failures reproduced five calls being executed,
the ninth attempt being accepted, partial admission of a batch exceeding the
remaining budget, oversized streams/text being accepted, and incorrect history
after the expected resource rejection. Fixed expected effect lists, response
strings and outgoing history objects are written independently of the limits
implementation. Evidence: `.test-artifacts/phase2da-before-fix.log`.

Two additional edge cases were reproduced before their respective corrections:

- A multi-call JSON fallback array executed only its first member and requested
  another model response: `phase2da-fallback-array-before.log`.
- Existing record-size failure produced no host error response and did not use
  the new resource-history cleanup: `phase2da-record-history-before.log`.

Logs and pre-edit source snapshots remain under ignored `.test-artifacts/`.
The full application, build/deployment scripts and real services were not started.

## Exact limits and enforcement

| Resource | Fixed limit | Enforcement |
| --- | --- | --- |
| Model-triggered tool attempts per response | 4 | Incremental native-package check; complete-batch reservation before history/dispatch; fallback attempt accounting |
| Tool attempts per public user request | 8 | Same reservation function for native, fallback and automatic search |
| Tool rounds | Existing default 4 retained | Existing `OLLAMA_MAX_TOOL_ROUNDS` behavior unchanged |
| Raw model response transport | 2,097,152 bytes (2 MiB) | Reader counts every incoming Buffer before decoding |
| Raw model transport per user request | 8,388,608 bytes (8 MiB) | Same budget shared by continuation and final no-tools responses |
| Combined decoded content and thinking per model response | 262,144 UTF-8 bytes (256 KiB) | `Buffer.byteLength(text, "utf8")`, checked before callbacks/appending that record |
| Individual NDJSON record | Existing 1,048,576 UTF-8 bytes (1 MiB) | Existing incremental record check, excluding LF/CRLF |

`src/cloud-api/local/ollama-resource-limits.ts` holds only fixed checks, the
request-owned accounting type/factory, and a typed Error for existing catch paths.
No module-global mutable counters exist. A public request creates its budget;
recursive rounds and the final no-tools helper receive that exact object. Each
response separately resets its transport, text and native-call counters.

The reader still uses the same StringDecoder, pending-line reconstruction,
LF/CRLF handling, JSON parsing, malformed-line behavior and `done=true`/EOF
validation. Resource errors use its existing destruction/rejection cleanup.
Raw counting includes delimiters, empty lines and unused JSON fields. It excludes
HTTP headers/framing; the source is the HTTP response Buffer stream before UTF-8
decoding. A chunk crossing a limit is rejected before decoding that chunk.
The already-received chunk itself cannot be retroactively unallocated.

Text is measured from decoded content/thinking fields, not JavaScript character
length or JSON wire length. Both fields and all records share the per-response
text counter. All existing tool-argument validation limits remain unchanged.

These transport budgets cover the agent's normal and final streaming chat
responses. Metadata `/api/show`, startup warmup, background memory summaries,
and HTTP operations internal to existing tools are not redefined as agent
stream responses or given a new lifecycle by this phase.

## Attempt accounting and rejection semantics

- Admission reserves the entire batch before centralized authorization. Calls
  subsequently rejected for names, permissions or arguments consume attempts.
- Automatic time-sensitive web search reserves one from the same request's
  eight-attempt budget before invoking the existing executor.
- Native/fallback switching does not reset counters. Recognizable denied JSON
  fallback calls also report attempt counts, without receiving execution rights.
- A batch exceeding four calls or the remaining request budget executes nothing.
  It is not truncated or partially admitted. The request budget becomes failed
  and cannot be reopened. Previously admitted attempts remain charged; an
  oversized rejected batch is not partially charged as if some calls ran.
- Duplicate/max-round proposals are also model attempts, even if the existing
  guard later avoids execution. Existing signature normalization is unchanged.
- JSON fallback remains a single-call execution format. Multi-call arrays now
  execute **none**, rather than silently executing their first member. Their
  attempts are counted; over-budget arrays get the deterministic resource error.
  Other unsupported multi-call arrays retain the existing safe fallback reply.
  Native multi-call batches remain supported within the limits.

Phase 1 still terminates a public interaction after authorization rejection.
No new invalid-call continuation/retry path was introduced just to exhaust eight
rejections. Tests separately verify real executor rejections consume reservations,
valid work can use remaining reservations, and the ninth cannot reach dispatch.
Integration tests also observe reservation before mixed valid/rejected dispatch.

Small-model usability trade-off: wrong arguments, unoffered calls and repeated
proposals spend the same finite budget as useful proposals. This can stop a
confused 1.7B model earlier. The requested numerical limits were not adjusted.
Independent new user requests receive fresh budgets, including after failure.

## Error response and history contract

Resource failure logs through the existing error path and emits this host text:

> Resource limit exceeded: REASON. Tool execution stopped for this request. Completion was not verified.

There is no extra model retry/finalization request after resource failure.
Completion callback runs once. No successful tool result is manufactured.

Batch admission precedes appending its assistant tool-call metadata. Failed
streams do not commit their partially accumulated assistant message. The original
user request and earlier committed call/result rounds remain, followed only by
the host failure message. Subsequent turns receive this valid earlier history.

The pre-existing final no-tools path temporarily records the unexecuted proposal
that led to duplicate/max-round finalization. For resource failure only, cleanup
removes that exact proposal by object identity. Previous completed proposals and
results are retained. Successful finalization retains the Phase 2B behavior;
no general orphan-history recovery was added.

The existing 1 MiB record failure is now classified as the same resource error,
preserving its threshold, error reason and parser cleanup while adding the host
failure response and consistent pending-proposal cleanup. Other truncation and
transport-error contracts are unchanged. Previously emitted text/thinking may
already have reached consumers before a later record fails; it is not retracted.
Already completed external effects are not reversed.

## Changed files

- `src/cloud-api/local/ollama-resource-limits.ts`: small shared accounting module.
- `src/cloud-api/local/ollama-ndjson.ts`: incoming byte checks and record-error
  classification; reconstruction itself retained.
- `src/cloud-api/local/ollama-llm.ts`: request-owned budget wiring, incremental
  text/call checks, batch admission, automatic search and final/history handling.
- `src/config/spoken-text-guard.ts`: denied-fallback accounting metadata; reject
  multi-call fallback arrays rather than silently running the first entry.
- `src/test/ollama-resources.spec.ts`: 26 deterministic regression tests using
  real provider/registry/executor with mocked byte sources and fixture effects.
- `src/test/ollama-stream.spec.ts`: four successful large-record checks now run
  directly against the parser, retaining exact content/Unicode assertions. Those
  >256 KiB payloads cannot remain successful provider-text cases under the new
  requirement. Three record-error assertions now expect the exact host failure
  reply. No streaming cases or record limits were removed or relaxed.
- `package.json`: add the new suite to the existing isolated test command.
- This report.

## Regression coverage and validation

The 26 resource tests cover below/exact/above response and request call limits,
6+4 atomic rejection, mixed native/fallback rounds, automatic search, actual
authorization rejections, sticky exhaustion, unknown fallback attempts, denied
multi-call arrays, independent sequential/interleaved requests, exact 2/8 MiB
transport boundaries, many valid padding records, exact/over combined Unicode
text, pending calls on failure, destruction before EOF, final-path budgets,
normal/final record-size errors, and independently specified subsequent history.

The admission test distinguishes charging from dispatch effects: a three-call
batch with one valid and two rejected attempts charges three; only one handler
runs. Another test charges seven actual schema-rejected operations, admits a
valid eighth, and rejects a ninth reservation. This isolates accounting without
changing the production Phase 1 terminal-rejection policy.

- Targeted resource/stream/history/Ollama-security suites: **71/71 passed**.
- Complete suite: **175/175 passed**, **0 failed**, **0 skipped/cancelled**.
- Production TypeScript: `tsc --noEmit --incremental false` passed.
- Strict TypeScript for all 11 spec files passed.
- `git diff --check` passed; existing LF/CRLF conversion warnings are not errors.
- Existing authorization, startup preservation, UTF-8/exhaustive boundary tests,
  1 MiB record tests, tool-history tests and Phase 2C URL/duplicate tests pass.
- No intermittent speech-sync failure occurred in these runs. Speech-sync source
  and assertions were not edited; prior timing flakiness remains a separate task.

Final logs: `phase2da-regressions.log` and `phase2da-full.log`. Initial failure
logs are retained. No assertions were weakened to obtain passing results.

## Preservation and remaining limits

Compare against `phase2da-before.json`, not only Git HEAD, because prior phases
remain uncommitted. Only the five listed existing files changed; three files
were added. All other 261 pre-existing project files and all 442 actual data
files retain identical hashes; data size/mtime also remain unchanged.

Central authorization, reserved shell names, offered-tool membership, argument
validation and disabled-tools behavior remain intact. No alternative execution
path was added. Startup protection, tool implementations, memory format, persona,
voice/Piper, Faster-Whisper, display, audio synchronization, model configuration
and hardware code remain unchanged. Phase 2C signature code is unchanged.

Missing total/per-tool timeouts, incomplete cancellation propagation, synchronous
blocking operations, overlapping abandoned operations and same-response duplicate
execution remain. `Promise.all` is unchanged: the new four-call batch limit
bounds its per-response fan-out but is not a global concurrency limit. Tool
results, outgoing history, persistent facts/queues, image files and disk retention
have no new limits here. A silent stream can still wait indefinitely.

Live Ollama generation, resource usage, kernel/SDK cancellation behavior and
physical Pi speech/display behavior are **NOT VERIFIED**. Mocked tests establish
host logic, not production readiness. No Phase 2D-B/C or later work was started.
