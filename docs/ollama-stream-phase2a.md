# Phase 2A: Ollama NDJSON transport

Implemented locally on Windows, 2026-10-16. No Pi connection, hardware test,
application startup, deployment, commit, push or cleanup was performed.

## Root cause and reproduction

Both `chatWithLLMStreamInternal` and `answerFromAvailableToolResults` in
`src/cloud-api/local/ollama-llm.ts` decoded each Buffer independently using
`chunk.toString()`, split that string on newline, and attempted JSON.parse on
every nonempty piece. Incomplete pieces were logged as malformed and discarded.
There was no carry buffer, and a UTF-8 character split across buffers could
be replaced by decoding each fragment separately.

The application accumulated content/thinking strings and tool-call packages
from parsed records. Tool packages were flattened and dispatched after `end`;
`done` supplied timing stats but did not gate successful stream completion.
The final no-tools path also accepted EOF after a streaming error. Complete
malformed JSON records were logged and skipped, rather than fatal.

Baseline: **110/110 tests passed** (`.test-artifacts/phase2a-baseline.log`).
Before modifying production code, new Test C sent a real provider a single
valid response split at byte 23 using a mocked HTTP PassThrough stream. It
failed: expected `Reconstructed.`, received an empty string. The response and
done record were lost as fragments. Evidence:
`.test-artifacts/phase2a-reproduction.log` (1 failure, 0 passed).

## Implementation and contracts

- `src/cloud-api/local/ollama-ndjson.ts`: one shared reader for the two existing
  consumers, using Node's built-in StringDecoder. Decoder, carry buffer and
  completion state are created per response, including concurrent responses.
- `src/cloud-api/local/ollama-llm.ts`: the two existing aggregation callbacks
  consume reconstructed records. Main-loop finalization runs only after the
  reader resolves. Tool authorization, schema validation, offered tools, JSON
  fallback, tool package aggregation/order and dispatch code are unchanged.
- `src/test/ollama-stream.spec.ts`: deterministic integration tests A–O plus
  the final no-tools path. The actual provider, tool router, registry and
  centralized executor run; only axios HTTP responses and plugin effects are
  test doubles. The existing test preload keeps writes in disposable folders.
- `package.json`: registers the new suite in npm test.
- `docs/tool-execution-phase1.md` and this file: update resolved transport risk
  and document the exact change and remaining limits.

The reader processes complete newline-delimited records once in order, supports
LF/CRLF, skips empty/whitespace lines, and retains incomplete lines. It never
parses a remainder without a newline, even if that remainder is valid JSON.
Normal success requires an `end` event, no non-whitespace remainder (including
decoder flush) and a parsed boolean `done=true` record. That record's message
fields still reach the existing aggregation callbacks; it does not discard
other records or reorder content, thinking or calls.

Small necessary error-path correction: partial EOF, missing done, premature
close, transport error and Ollama `{error: "..."}` reject the reader. Remaining
buffered data is discarded, listeners are detached and failed streams are
destroyed. Errors go to existing provider catch/logging and end callbacks.
Main-loop tool dispatch and successful assistant-history append do not run on
these failures. Final no-tools errors similarly bypass its successful history
append. End callbacks still mean the request stopped; they are not proof of
goal achievement. No retry, new cancellation system or error framework was added.

Complete malformed JSON retains the previous log-and-skip behavior; it never
generates a tool call. This policy is intentionally different from incomplete
transport records, which remain buffered until a newline or fail at termination.
Tools still pass through Phase 1 authorization even after transport succeeds.

## Deterministic test coverage

| Test | Observed behavior |
|---|---|
| A | A complete record with content and done works. |
| B | Two complete records in one chunk are processed once, in order. |
| C | Two pieces reconstruct the original JSON response (red before fix, green after). |
| D | Three pieces, including a split between CR and LF, reconstruct correctly. |
| E | æ, ø and å survive cuts inside multibyte content and tool arguments. |
| F | Prior remainder, whole records and next prefix share a chunk correctly. |
| G | Empty/whitespace LF and CRLF lines are skipped. |
| H | Partial EOF logs truncation, never dispatches and ends once. |
| I | Partial, valid-but-undelimited and trailing incomplete tool data never executes. Even complete pending calls are blocked when a later record is truncated. |
| J | Thinking/content aggregation, tool package arrays and invocation order match existing behavior. |
| K | Complete malformed JSON is logged/skipped; later valid records still work. |
| L | Transport error, close without end, Ollama error and missing done prevent pending tool dispatch. |
| M | Disabled tools cannot execute via fragmented native calls or text JSON fallback. |
| N | Exhaustive boundary invariance through the actual provider, not a copied parser. |
| O | Failed sequential requests, interleaved concurrent streams, and the existing same-provider cancellation path keep buffers isolated. |
| Final no-tools | The second consumer reconstructs byte-by-byte UTF-8 and rejects a truncated final answer. |

Test N's actual implementation is `src/test/ollama-stream.spec.ts`, test named
`N every single-byte boundary gives identical parsing and application results`.
After Phase 2A.1 it occupies lines 217–250; the exhaustive loop starts at line 239.
Its loop is `for (let boundary = 1; boundary < bytes.length; boundary++)`.
The representative streams are **86 and 150 bytes**: **234 single-boundary
splits**, including every split inside multibyte characters, plus one-chunk,
byte-by-byte and deterministic mixed-size delivery of each stream. Assertions
compare content, thinking, tool events/effects, end-callback count and errors.
These are cases within one test, not 234 separately counted tests.

## Validation and limits

Original Phase 2A targeted suite: **16/16 passed**. Full suite: **126/126 passed**, 0 failures,
0 skipped (110 existing tests plus 16 new tests).
Logs: `.test-artifacts/phase2a-targeted.log`, `phase2a-regressions.log`.
Production TypeScript and separate strict typecheck of the new test pass.
`git diff --check` passes (existing LF/CRLF normalization warnings may appear).

Security review checks:

1. **Fail closed:** truncation/error/missing done cannot reach final dispatch;
   disabled and malformed calls retain the central execution boundary.
2. **Wiring:** both existing streaming consumers call the same reader; ordinary
   streaming, tool rounds and final no-tools fallback are executed by tests.
3. **Preservation:** prior security/startup code and persistent files are checked
   against a pre-change hash manifest; no tests use production data as fixtures.

Final manifest: `.test-artifacts/phase2a-preservation-result.json` confirms 257
existing files unchanged, only the three listed existing files changed, three
new files added, and all **442** existing data files unchanged by content hash,
size and modification time. Existing uncommitted work is retained. The Ollama
provider's pre-existing Phase 1 authorization edits remain in place; this phase
changes its transport callbacks and success/error gating only.

Already emitted content from complete records cannot be retracted if a later
record is truncated. Existing error logging and stream-ending callbacks remain
the user-interface contract; no new UI error status was introduced. Phase 2A.1
adds the per-record limit below; no new request deadline/retry is introduced. These transport tests do not
prove hardware timing, real-model quality, application-level fragmented tool
arguments or full tool-history serialization; those are unchanged and outside
Phase 2A. There are no new dependencies or prompt changes.

Physical Raspberry Pi behavior, installed configuration/build, GLaDOS voice,
Ollama model, Piper/Faster-Whisper, display and audio timing are **IKKE VERIFISERT**
here. Before eventual deployment, build and verify those on the Pi under separate
authorization. Phase 2B and subsequent development have not been started.

## Phase 2A.1: final corrections

Only `ollama-ndjson.ts`, `ollama-stream.spec.ts` and this document are changed
in this follow-up. No dependencies, model settings, application-level message
aggregation, authorization, startup-data protection or hardware code change.

The fixed maximum is **1,048,576 raw UTF-8 bytes per NDJSON record**, excluding
LF or CRLF. Repository evidence supports the proposed 1 MiB ceiling: the
central executor already limits serialized tool arguments to 65,536 JavaScript
characters and default individual string arguments to 32,768 characters;
the existing transport fixtures are small streamed content/thinking/tool
records (Test N uses 86 and 150 bytes). No inspected expected response requires
a larger record. `OLLAMA_PREDICT_NUM` is optional and is not a byte-size guard.
This selection is based on source/fixtures, not measurements of the installed Pi.

The reader scans each incoming Buffer for LF and counts each record's raw
segments before decoding or adding them to the pending string. Counts carry
across chunks and reset at each LF. A potential terminal CR can defer **one
byte** until the next chunk distinguishes CRLF from additional record data;
if more data follows, that CR counts too. Thus an exactly-at-limit record
works with either LF or CRLF, even if CR and LF arrive separately. A chunk
larger than 1 MiB is accepted when its individual records fit.

On excess, the existing fail path clears pending text/count, detaches
listeners, destroys the stream and rejects with
`Ollama NDJSON record exceeds 1048576 UTF-8 bytes`. The oversized segment is
not decoded/appended and the record is not parsed or passed to callbacks.
Provider finalization therefore cannot dispatch pending native or text-fallback
tool calls from the failed response. Previously completed tool rounds and
already emitted text cannot be undone.

Test N now specifies its expected objects independently, including events,
exactly one end callback and no errors:

| Fixture | Answer | Thinking | Effects | Tool events |
|---|---|---|---|---|
| First | `Text æøå.` | `æøå` | `[]` | `[]` |
| Second | `Prefix æFinished.` | empty | `["æøå"]` | transportProbe start, then `[success]Stored.` |

One-chunk, byte-by-byte, all **234** single-byte splits and mixed-size delivery
are each checked against these constants. No implementation result is used
as the expected object.

Seven new tests cover below/exact/over limit, UTF-8 bytes versus string
characters, fragmented excess detected before EOF/newline, two valid 600 KiB
records in one chunk, and pending native/text-fallback tool safety. Cases also
cover split CRLF at the exact limit and a deferred CR followed by extra data.
Before the size fix, the focused N/size run had **4 failures / 4 passes**;
afterward the complete targeted suite has **23/23 passes**.

Final validation: **133/133 passed**, 0 failures, 0 skipped (126 prior tests
plus 7 added). Production TypeScript, separate strict test typecheck and
`git diff --check` pass. Evidence: `.test-artifacts/phase2a1-targeted.log`,
`phase2a1-regressions.log`, `phase2a1-before-fix.log` and
`phase2a1-preservation-result.json`.

The limit bounds accumulation for one record, not total response/history size
or all memory used by the application/HTTP buffers. Valid text from multiple
records still accumulates as before. Actual Pi memory headroom and behavior
remain **IKKE VERIFISERT**. No Phase 2B work is included.
