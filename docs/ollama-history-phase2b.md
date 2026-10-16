# Phase 2B: native Ollama tool history

## Contract inspection before production changes

The existing native `/api/chat` integration has two lossy request projections
in `ollama-llm.ts`: the regular tool loop and `answerFromAvailableToolResults`.
Both reconstruct messages from role/content only. Internal history retains
assistant tool-call packages and tool-result names, but those fields do not
reach the next HTTP request.

The [official tool-calling examples](https://docs.ollama.com/capabilities/tool-calling)
send assistant `tool_calls` and tool messages with `tool_name` and `content`.
The inspected [native Go API types at revision d9b86018cba1d222fd28e28f42e5cdc15a060f39](https://github.com/ollama/ollama/blob/d9b86018cba1d222fd28e28f42e5cdc15a060f39/api/types.go)
define message role/content, optional thinking/images, a **flat** `tool_calls`
array, optional `tool_name` and `tool_call_id`. Each native call has optional
`id` and a function with index/name/object arguments. These are native API
fields confirmed from source, not assumptions about the OpenAI endpoint.

Discrepancies identified before editing production code:

- `OllamaMessage.tool_calls` deliberately stores a nested array of streamed
  packages. Sending that internal shape directly would be incompatible with
  the flat native wire format. Flattening belongs only in request serialization;
  aggregation/storage/dispatch should remain unchanged.
- Ollama-specific types omit optional native ID fields. Shared `Message` has
  `tool_call_id` for other providers and uses their function-call argument shape;
  it is not the native Ollama wire contract. Do not change the shared shape.
- The dispatch loop creates random temporary `call_*` IDs, but neither stores
  them as historical call IDs nor associates results with them. Normal Ollama
  results currently use tool_name and ordering. Do not start generating or
  propagating these temporary IDs into conversation history.

Already-supplied native call IDs and tool-result IDs can be retained as optional
metadata without creating an identifier/correlation system. Tool names and
ordering remain the existing default association mechanism. The installed
Ollama version is not pinned in this repo (Docker uses latest) and the Pi's
version is **NOT VERIFIED**; optional IDs are sent only when already present.

JSON fallback already converts a recognized, offered call into an internal
tool-call package and clears its raw JSON content before storing the assistant
message. Phase 2B preserves that existing normalized assistant record and its
results; it does not restore discarded raw text or invent a new conversion.
Rejected results must remain rejected, and historical calls must never execute.

Context compaction retains its selected tail messages without projecting their
fields; older messages are summarized by existing design. Local-memory storage
does not perform these outgoing request projections. Neither component needs
changes for this narrowly scoped defect.

The above discrepancies were documented before production code was changed.

## Reproduction and minimal implementation

Baseline: **133/133 passed**. The new HTTP integration suite initially gave
**9 failures / 2 passes**. Missing assistant tool_calls, result tool_name and
supplied identifier metadata were visible in the actual JSON bodies received
by a fake native `/api/chat` server. Ordinary conversations and disabled-tool
execution checks already passed. This reproduces the defect at the final wire
boundary rather than only an intermediate serialization object.

Changed files:

- `src/cloud-api/local/ollama-llm.ts`: only the two outgoing message projections
  now conditionally include nonempty `tool_calls.flat()`, `tool_name` and
  `tool_call_id`. The system-note and captured-image rules remain unchanged.
  Internal package arrays are not mutated. No new serializer framework/helper,
  retry, recovery, dispatch or aggregation behavior is introduced.
- `src/type/index.ts`: two optional native metadata fields (`OllamaMessage`
  tool_call_id and `OllamaFunctionCall` id) reflect the inspected API contract.
  Shared provider types and the existing nested internal package type remain.
- `src/test/ollama-history.spec.ts`: 11 deterministic tests use the real Ollama
  provider and central executor, with trusted fixture plugins and a fake HTTP
  endpoint. They capture raw request bytes after Axios JSON serialization and
  compare parsed bodies to independently specified expected values. Only
  fixture handlers have effects; production data is replaced by the existing
  test preload. No live Ollama, memory store or hardware is required.
- `package.json`: registers the new suite without dependency changes.
- `docs/tool-execution-phase1.md` and this report: update the resolved risk and
  document native compatibility, tests and limitations.

## Regression coverage

| Requested check | Evidence |
|---|---|
| A: native calls | Exact function names, nested/Unicode arguments, function index, supplied call ID and assistant content survive the next HTTP request. |
| B: result metadata | Role, tool_name and exact success result content are retained. |
| C: full interaction | A real approved fixture call executes once; the subsequent request has user, assistant call and named result in order. |
| D: multiple calls | Two packages with three calls, including a repeated tool name with different arguments, remain ordered and flat. All three matching results are retained without duplicates or generated IDs. Existing Promise.all scheduling is unchanged. |
| E: normal turns | Exact roles/content/order are unchanged; empty internal packages do not introduce tool metadata on the wire. |
| F: streaming | All 23 existing streaming tests run unchanged, including exhaustive UTF-8 boundaries, aggregation, completion, isolation and the 1 MiB record cap. |
| G: security | Historical calls never execute, rejected results remain rejected, disabled native/fallback calls have no effects. Existing central/name/argument/available-tool/shell-blocking security suites also run unchanged. |
| H: final wire body | Real HTTP bodies include exactly expected supported message fields; an unrelated internal marker is omitted. |
| I: JSON fallback | Authorized fallback retains the existing normalized assistant call and result. Invalid-argument rejection remains a rejected tool result in the next request; disabled fallback remains ordinary fallback text without fabricated native metadata. |
| J: identifiers | Existing native call IDs and supplied result tool_call_id values survive both normal and final no-tools projections. Normal calls without IDs do not acquire any. Temporary dispatch IDs remain outside history. |
| Final no-tools path | The max-round branch retains historical failed results/IDs, a completed authorized call/result and a new pending call. The pending call is not executed or falsely given a success result. |

Targeted suite: **11/11 passed** after the correction.
Final unchanged full-suite repeat: **144/144 passed**, 0 failures, 0 skipped
(133 existing + 11 new). Production `tsc --noEmit --incremental false`, strict
TypeScript validation of **all 10 test files**, and `git diff --check` pass. Existing LF/CRLF
normalization warnings may appear from Git. Full production application/build
scripts are not run, so no daemon registration/deployment is triggered.

Logs/manifests are kept under ignored `.test-artifacts/`:
`phase2b-baseline.log`, `phase2b-before-fix.log`, `phase2b-targeted.log`,
`phase2b-regressions.log`, `phase2b-regressions-repeat.log`,
`phase2b-speech-isolated.log`, `phase2b-before.json`, `phase2b-preservation-result.json`.
Pre-edit copies of the two changed production files allow inspection of the
Phase 2B-only diff separately from earlier uncommitted changes.

One intermediate full run had **143 passes / 1 failure** in the unchanged
`SpokenTextReveal follows a plan, capped at the sentence, and stops on reset`
test (`src/test/speech-sync.spec.ts:177`): observed 30 instead of 22. This
test waits nominally 30 + 60 ms and assumes it has not reached a 120 ms plan
step. `followPlan` uses Date.now and applies all elapsed steps, so delayed
timer scheduling can pass the third step before that assertion. The observed
value corresponds to that later step. The isolated speech suite passed 11/11,
and an ordinary full rerun passed 144/144 without changes. The failure log is
retained; neither the assertion nor speech implementation was modified.

## Preservation and limits

Tool metadata is context only. The unchanged central executor is still the
only authorization boundary for newly returned model calls. This change does
not replay historical requests or turn rejected/failed results into successes.
Internal call packages and order are unchanged; flattening happens only when
constructing the outgoing request. Local memory, context compaction and stored
history format are not migrated or redesigned.

The pre/post manifest confirms **442 existing data files** unchanged by content
hash, size and modification time. Of 263 pre-existing registered files, 259
retain identical hashes; only the four listed existing files changed, plus
the two listed new files. Streaming/parser/size-limit files, startup protection,
central security code, voice/TTS/ASR, memory, display, audio and configuration
files are unchanged. All prior uncommitted changes are preserved.

The installed Ollama version and physical Raspberry Pi behavior are
**NOT VERIFIED**. Official current native types support optional IDs; this
phase preserves IDs already present but does not add result IDs to ordinary
tool executions or establish a new correlation mechanism. Live model/template
interpretation of tool history remains unverified by mocked tests.

Existing limits remain: application-level fragmented tool arguments are not
reassembled by this phase; malformed historical calls are not repaired;
pending calls at the existing round limit can remain without a matching result.
No orphan recovery, duplicate-protection changes, timeouts, cancellation
architecture or later-phase functionality is introduced. Cache/performance
behavior is not established by these tests.

No skills, routing systems, subagents, external agents, new frameworks,
dependencies, SSH, Pi access, hardware tests, commits, pushes or deployment were
used. Work stops after Phase 2B.
