# Ollama runtime prompt budget and launcher ownership

The Pi reports a 4096-token loaded slot in `/api/ps`, while `/api/show`
advertises about 40960. These are different concepts. No `num_ctx`, model,
quantization, threads, inference timeouts or speech settings are changed here.

## Discovery and diagnostics

Before each text chat request (including the final no-tools answer) and memory
summary, query `/api/ps`. Match the configured model against `name`/`model`,
allowing only the implicit `:latest` spelling. Accept one exact model match
with a positive integer `context_length`. Other models, ambiguous matches,
missing/invalid context, HTTP errors or an unloaded model use **4096**.
Runtime results are not cached: a subsequent loaded slot can be different.
Parent cancellation propagates; it never becomes a fallback inference request.

`/api/show` is optional advertised-capacity diagnostics only, cached as before.
`CONTEXT_AUTO_COMPACT_ENABLED=false` skips that optional metadata call; it no
longer disables Ollama's request safety budget. No advertised value can enlarge
the effective budget. Example log:

```
[Ollama] advertised_context=40960 effective_context=4096 request_budget=3353 history_budget=... source=/api/ps reserves=...
```

`advertised_context=unknown` is legitimate when metadata is disabled/unavailable.
`source=fallback` identifies the conservative 4096 assumption explicitly.

## Reserves and trimming

The outgoing message projection (including system-note text, native tool-call
metadata and actual offered tools) is budgeted, not the whole tool registry.

* Each message: `16 + ceil(serialized UTF-8 JSON bytes / 3)` estimated tokens.
* Offered tools, when present: `64 + ceil(serialized UTF-8 JSON bytes / 3)`.
* Expected output: positive configured `OLLAMA_PREDICT_NUM`, otherwise 1024.
  The memory summary keeps its existing explicit 160-token output reserve.
* Safety margin: `max(256, ceil(effective_context * 0.15))`.
* Input/request budget: effective context minus output and safety reserves.
* Required static instructions: the first message, unchanged.
* Required context: current-turn memory/RAG system messages, unchanged and in
  their original positions. ChatFlow explicitly marks injected messages with
  host-only `contextScope: "turn"`; the marker is stripped before Ollama HTTP
  dispatch. Unmarked system instructions remain permanent. Do not infer scope
  from message text.
* Active turn: the newest real user question and every following message,
  including active assistant proposals, tool results and the final no-tools
  instruction. These messages are mandatory.
* Available history budget: input budget minus tools, static, context and active
  reserves. It is calculated afresh; there is no fixed 3072-token history cap.

Only if the input exceeds this budget, drop complete oldest removable turns
until it fits, including the scoped context immediately preceding each owning
user question. Old assistant/tool pairs are never split. Retained messages are
not reordered, summarized or rewritten. If mandatory content alone cannot fit,
fail through the existing resource-error boundary before inference. A summary
transcript is mandatory: an oversized one fails and the unchanged memory caller
can use its existing heuristic-summary fallback.

This estimates tokens; it is **not an exact model/template tokenizer**. The byte
estimate and margin reduce risk but cannot prove the exact rendered token count
for all possible inputs. The application explicitly trims/rejects rather than
depending on Ollama to silently remove content. Validate actual prompt counts
on the Pi, especially unusual text and near-limit turns. No cache-speed gain
or universal exact-token guarantee is claimed.

Trimming is request-local: the existing stored/live-history limits of 200
messages / 4 MiB are independent and unchanged. Persistent memory formats,
facts and saving semantics are unchanged. The history safety cap also removes
scoped context with its owning turn. Current context and permanent instructions
are retained even if that means rejecting an unusually large request. Relevant
memory and RAG can be injected again on a later turn; retrieval no longer assumes
that a previously injected turn remains in the prompt. No persistent memory is
deleted or rewritten by trimming. No authorization is weakened for caching.

## Ollama startup paths found

* `run_chatbot.sh`: application launcher; formerly spawned `ollama serve` on
  `SERVE_OLLAMA=true` and cleaned by process name. Fixed here. Its entrypoints
  include `startup.sh`'s legacy chatbot unit, the basic image's unit in
  `packaging/pi-gen/basic/stage-whisplay/files/provision-basic.sh`, CLI service
  management, and daemon registration by `scripts/register-whisplay-daemon-app.js`.
* `scripts/install_ollama.sh`: installs `ollama.service`, whose ExecStart runs
  `ollama serve`, and enables/restarts it during installation. Unchanged.
* `docker/docker-compose.yml`: optional `ollama/ollama` container with published
  port 11434. Docker owns its lifecycle. Unchanged.
* `scripts/deploy-aihat2.sh`: separate `hailo-ollama.service` install/start path.
  Unchanged; it is not the confirmed Pi's regular Ollama server.
* TypeScript warmup/chat/summary calls load/use a model over HTTP; they do not
  spawn or own an Ollama server. Load-only warmup remains unchanged.

## Launcher ownership

`scripts/ollama-ownership.sh` is sourced by the launcher. For Ollama use (or an
explicit `SERVE_OLLAMA=true`), check the configured `OLLAMA_ENDPOINT`, default
`http://localhost:11434`, via `/api/version`. Require successful HTTP plus JSON
with a nonempty version string; an open port/HTML is not accepted as healthy.
Endpoint logs omit user credentials, query strings and paths.

* Healthy endpoint: reuse it for either serve flag. Never acquire ownership,
  spawn a second server or terminate the external service.
* Unavailable + true: preserve the existing auto-start bind `0.0.0.0:11434`
  and `OLLAMA_KEEP_ALIVE=-1`. Track `$!` as the exact owned child. Only default
  local endpoints support this auto-start; remote/custom unavailable endpoints
  fail explicitly rather than starting an irrelevant local server.
* Unavailable + false: report failure and exit before starting the application.

New startup probes are bounded (2 s connect / 5 s HTTP; up to 20 readiness
attempts with 250 ms pauses). These are startup checks, not changes to existing
inference/tool timeouts. Failed/contended starts clear ownership. A server that
wins a bind race can be reused as external. Cleanup checks the shell's live-job
table to avoid signalling an exited/recycled PID. It terminates only the exact
owned PID, allows up to 20 x 100 ms for TERM, then uses KILL on that same live
child if necessary, and waits/reaps it. EXIT/INT/TERM traps share idempotent
cleanup. There is no name-, pattern-, port- or `pidof`-based termination.

## Physical Pi benchmark (not performed locally)

1. Use the normal approved build/start procedure separately. Keep model,
   quantization, `num_ctx`, threads, voice and timeouts unchanged. Record version,
   `/api/ps` model/context and the existing service PID before testing.
2. With `ollama.service` already healthy and `SERVE_OLLAMA=true`, start the
   chatbot normally. Expect `external server detected ... startup skipped`.
   Verify no bind-error attempt and the same external server PID; stopping the
   chatbot must leave that service running. Do not stop the service to test the
   ownership branch on a production Pi; it has isolated local regression tests.
3. Ask "What is two plus two?" once, then repeat the identical question five
   times without crossing the five-minute idle reset. Retain normal conversation
   history. Record each round's `[Ollama]` budget log, `[Ollama timing]`, and
   Ollama's actual prompt/cached/evaluated token counts and durations. Repeated
   questions are not identical full prompts as history grows; report that fact.
   Also measure question-to-first-audio elapsed time: runtime/metadata HTTP
   discovery precedes `[Ollama timing]` and is not included in that inference
   timer. Do not mistake its extra latency for prompt evaluation.
4. Continue with unique short turns until `prompt_trimmed` occurs. Expect
   effective=4096, advertised about 40960, oldest-history trimming before the
   inference request, and intact newest question/tool context. Check actual
   prompt + output reservation remains within the runtime slot; inspect server
   logs for truncation. If estimates undercount, stop the near-limit experiment
   and report the counts rather than tuning context or threads.
5. Ask "How much RAM are you using?" and "What's your CPU temperature?";
   confirm existing health routing, explicit units, audible answer and display.
6. Interrupt one answer and ask a new question. Verify existing cancellation
   and that the externally owned Ollama service survives.

Compare prompt-evaluation medians/cached counts against the supplied ~690 total,
234 cached, ~8906 ms prompt evaluation, ~2816 ms generation sample. Keep cold
load and between-question memory-summary work separate. No measured Pi speedup
is claimed by local tests.
