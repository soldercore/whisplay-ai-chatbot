# Voice latency: instrumentation audit and measurement status

2026-11-01. Separate diagnostic branch `diagnostics/voice-latency`, based on stable
`tts-pipeline-fix` at `9aa0fcfae89f67539bbd6e32b8d8511be490f68a`. No personality
changes from PR #2 are included. Its reference commit
`de8a196b8bd2538cbdcac89a87bd34699dc670d5` and all earlier model evidence remain
on their own branch. **No optimization, deployment, Pi access or new real-model
inference was performed in this task.**

Current Pi model, persona, loaded context, build and thermal state are unverified.
Qwen + A is the intended baseline, not an observed current configuration. The
cloud environment has no configured VPN/private-network access or Pi identity.
Mocked protocol tests below do not count as model or physical voice measurements.

## Audit performed before implementation

| Stage | Already measured? | Missing information | Diagnostic action |
| --- | --- | --- | --- |
| Speech end / capture | SoX VAD/manual stop and process exit in [audio.ts](../src/device/audio.ts) | Exact acoustic speech end and VAD decision time are not emitted | Record stop request and capture-process exit; do not invent acoustic timestamps |
| ASR | `[ASR time]` in [ChatFlow.ts](../src/core/ChatFlow.ts) | Turn correlation; the pre-ASR file-duration check is outside this timer | Add correlated precheck/start/completion events |
| Context preparation | Memory/RAG prepared in [states.ts](../src/core/chat-flow/states.ts) | Duration before provider entry | Mark answer entry and provider entry, without logging context |
| Ollama warmup | Empty-message chat, `keep_alive:-1`, in [ollama-llm.ts](../src/cloud-api/local/ollama-llm.ts) | Warm residency does not mean the prompt was prefetched | Retain existing warmup unchanged; benchmark observes residency separately |
| Ollama requests | Existing `[Ollama timing]`, prompt/decode/load and application prefix comparison | Existing first-token field also includes thinking/tool proposals; uses wall-clock differences | Add monotonic per-call submission, first-content and terminal metrics; preserve legacy log |
| Cache | Application `kept` comparison | No proof of server KV reuse; optional server count not recorded by stable code | Retain actual `prompt_eval_cached_count`, including zero; absent becomes null |
| Speakable segment | Existing split/queue times in [StreamResponsor.ts](../src/core/StreamResponsor.ts), [splitSentences](../src/utils/index.ts) | No common origin with ASR/LLM | Record segment readiness with turn/segment IDs |
| Piper | HTTP, conversion and probe durations in [piper-http-tts.ts](../src/cloud-api/local/piper-http-tts.ts) | First byte/server synthesis-start not exposed by this curl-to-file client | Record HTTP submission/completion, validated full file and usable converted WAV |
| Ordered speech | Existing [audio-timing.ts](../src/core/audio-timing.ts) splits text/TTS/scheduling gaps | Correlation across queued asynchronous segments | Extend the existing module with optional async context; bind queued segment context explicitly |
| Playback | Existing SoX spawn/run timing in [audio.ts](../src/device/audio.ts) | Process spawn is not ALSA start or physical sound | Record submission, SoX spawn/close and timeout separately; physical start stays unavailable |

The added mode is **off by default**, enabled only by
`WHISPLAY_LATENCY_DIAGNOSTICS=true` in a diagnostic process. Template documentation
is commented out; no production `.env` is edited. There are no new dependencies,
filesystem writes, polling loops or HTTP metadata calls on the application hot
path. Each event uses `performance.now()` relative to one interaction; only its
start has an ISO wall-clock anchor for an external recording. IDs include PID
and a random UUID. LLM calls and speech segments have separate counters.

Correlation wraps existing state execution, provider requests, queue entries and
playback calls. A new interaction closes the abandoned context; late callbacks
cannot emit events into the next turn. Missing completion after shutdown is
reported as incomplete, not success. Normal end denotes application response
completion, not proof that the audio backend physically drained successfully.

Events contain only selected metadata, counters, durations and identifiers: no
transcript, prompt, memory content, audio, tool arguments, response text or raw
errors. The collector filters out the application's **existing** ordinary logs,
which can contain private material. Do not persist/share an unfiltered application
or journal log. Logger failures are contained. Model metrics are nanoseconds;
correlated `at_ms` and derived intervals are milliseconds.

## Current streaming behavior, unchanged

1. Normal non-markup model content streams to the existing responder. Thinking
   and native tool proposals are not speakable text. Initial JSON/markup may be
   held until interpretation; tool routing/prefetch can delay generation or speech.
2. `splitSentences` recognizes punctuation with its existing boundary rules and
   combines already available short clauses around its 60-character grouping
   threshold. It does not deliberately wait for an entire model response.
   An unterminated remainder is flushed at `endPartial`.
3. The first segment starts synthesis immediately. Later segments wait for that
   first synthesis, then use the existing concurrency limit (default five). Thus
   synthesis can overlap continued LLM output; later synthesis can overlap playback.
4. Piper's current client downloads a complete WAV to a file, then converts it to
   48 kHz stereo and probes duration. It does not stream partial Piper audio into
   ALSA. `piper_file_available` means a full validated file, not the first byte.
5. Playback remains ordered. Empty queue checks can wait 100 ms while the stream
   is open, or 1000 ms when partial text remains. This is a source-code observation,
   **not a measured dominant Pi delay**. No polling or segmentation was optimized.
6. UI reveal is announced at playback submission using the existing WAV speech
   timing. SoX process startup, ALSA buffering and physical output follow separately.
   Existing gap/silence reports remain available. A playback wait may time out
   before SoX exits; the new events distinguish that case.

Memory summary logging remains in the existing post-response path. It is not an
extra stage introduced here and is not included in the closed interaction's
correlated totals. Its existing `[Ollama timing] memory-summary` line may be
inspected locally if interference is suspected; do not share its surrounding
private logs. No new background inference or memory behavior was added.

## Ollama 0.34.4: residency and cache interpretation

The official [Metrics definition](https://github.com/ollama/ollama/blob/v0.34.4/api/types.go#L560)
contains optional `PromptEvalCachedCount *int` with JSON name
`prompt_eval_cached_count`. Archived responses from the earlier 0.34.4 test
runtime contain actual zero and positive values. That establishes availability in
that runtime, not that today's Pi has returned it. The new tools record the Pi's
own field when present, otherwise null. They never infer cached counts from speed.

In [ChatHandler](https://github.com/ollama/ollama/blob/v0.34.4/server/routes.go#L2726),
`checkpointLoaded` follows `scheduleRunner`; an empty message list returns
`done_reason:"load"`. Native completion copies runner prompt/cache/generation
metrics and sets `load_duration` to the interval from handler entry through
scheduling/loading ([native response](https://github.com/ollama/ollama/blob/v0.34.4/server/routes.go#L3021)).
Consequently a large load duration is not, by itself, proof of disk weight loading:
scheduling/runner readiness can contribute. Native source retrieval verified the
tag's files (types blob `2d180840a1df548930a07753503487688984f7c4`, routes blob
`99846c1ec5264c7e021481cbfa97e2d25cd1eedc`).

The controlled tool separates:

- **Cold-observed:** `/api/ps` has no models immediately before an explicitly
  requested cold generation. It never unloads a resident model to create this state.
- **Warm-observed:** only the expected Qwen digest is resident at 4096 immediately
  before the request. This is a point-in-time observation, not a guarantee against
  an unrelated concurrent client or later eviction.
- **Cache evidence:** a returned cached count records exactly that value. Repeated
  identical requests and incremental histories allow comparison of prompt costs;
  missing counts leave only indirect timing evidence. Neither short duration nor
  application `kept` proves cache reuse. A warm first request is not automatically
  an uncached request: a prior client may already have populated a compatible prefix.

The benchmark requests a fixed original A/speech prompt, no tools (`[]`), Qwen,
context 4096, `think:false`, temperature 0.7, top-k 20, top-p 0.95, presence 1.5,
seed 42 and maximum `num_predict:96`. It reuses the stable evaluator's prompt
budget refusal and the production NDJSON parser, and sends `truncate:false` to
prevent server-side truncation. The maximum is a test-only cap, not an exact
length or a production setting. Native model parameters and exact installed
digest are recorded. No generated text is written to benchmark output; generated
history is held only in memory for the incremental experiment.

Identical mode makes three byte-identical requests; incremental mode makes three
requests with the same original prefix and complete generated exchanges; cold
mode makes one request only. Limits: 120 seconds and 64 KiB per request. Missing
terminal data or unexpected thinking/tool output fails the run. A `length` stop
is recorded as a capped benchmark result, not a complete answer. Output-count
variation above 20% is flagged; use token throughput rather than presenting
unequal answer durations as equivalent workloads. Hardware snapshots are taken
before/after, and residency before/after each call. No extra metadata sampling
is added to normal voice turns.

## Performance evidence currently available

These values were supplied by the user from earlier Pi logs. **They do not name
the model, have no correlated ASR/TTS events, and were collected during Gemma
experiments when two models were at one point resident.** Do not label them Qwen.

| Component | Duration | Evidence / limit |
| --- | ---: | --- |
| Speech recognition | Unavailable | No correlated physical ASR sample supplied |
| Server loading/scheduling | 18.762 s | One supplied anonymous `[Ollama timing]` line |
| Prompt evaluation | 13.997 s, 586 tokens, 41.9 tokens/s | Same anonymous line |
| Generation | 2.548 s, 11 tokens, 4.3 tokens/s | Same anonymous line |
| First streamed event | 32.776 s | Legacy first-token field; not necessarily first text |
| Total model request | 35.327 s | Same anonymous line; not time to audible speech |
| First speakable segment | Unavailable | Needs new correlated Pi capture |
| Piper synthesis / first audio file | Unavailable | Needs correlated capture |
| Playback submission / SoX spawn | Unavailable | Needs correlated capture |
| Actual ALSA / physically audible onset | Unavailable | Backend does not expose ALSA start; external recording required for physical onset |
| Current temperature, frequency, throttling, RAM, swap | Unavailable | No current Pi access; sampler prepared |

The three server durations sum to 35.307 s, 20 ms below the supplied client total.
Loading/scheduling plus prompt processing sum to 32.759 s, near the first stream
event at 32.776 s. This one line supports a large pre-generation wait in that
request; it does not establish its cause, model or current recurrence.

Other supplied rows: 82 tokens at 4.1 tokens/s / 21.0 s total; 88 at 4.0 / 25.1 s;
96 at 3.8 / 29.6 s; 96 at 3.8 / 27.9 s; 99 at 3.6 / 42.1 s. Dividing counts by
the rounded rates suggests roughly 20–27.5 seconds of decoding. These are
**derived approximations**, not retrieved `eval_duration` values. Output lengths
vary by more than 20%; total durations are not equal workloads. Longer decoding
also does not prove a late first audible segment when synthesis/playback overlaps.

**Diagnosis:** no defensible largest recurring contributor for the current Qwen
voice pipeline can be selected from these anonymous LLM-only lines. Recurrent
decoding cost appears substantial in that historical set, while one cold/queued
request has major loading/scheduling and prompt costs. Current ASR, segment wait,
Piper, output buffering, thermal impact and physical first-audio latency remain
unmeasured. No new Pi numbers or cloud-to-Pi extrapolation are asserted.

## One conditional optimization recommendation, not implemented

Evaluate **exclusive residency of the already selected voice model during voice
sessions**, if controlled Pi captures demonstrate repeated loading or competition.
This means preventing an incidental second model/client from displacing or
queueing the working voice model; it does not mean another warmup inference,
model replacement or new automatic service. Existing keep-alive is already present.

The concrete supporting observation is 18.762 s of loading/scheduling in one
historical request and the user's report of simultaneous residency. Avoiding a
comparable cold/competition event could remove some of that class of wait. The
benefit for present Qwen is **unknown**, potentially zero if it is already warm
and uncontended; cache/ASR/TTS costs would remain. This is the only proposed
optimization, conditional on measurements, not an established production fix.

Complexity would be low operationally, but RAM contention with Whisper/Piper,
other model consumers and scheduler settings must be reviewed. Verification:
compare identified warm/resident sessions and existing cold/competing observations
under comparable thermals; check server load duration, client first content and
externally measured first sound. If Qwen is already warm with no recurrent
loading/queueing, reject this recommendation rather than changing settings.
Rollback would restore the previously recorded scheduling/residency policy;
neither model, memory nor voice is deleted. No setting or residency policy was
changed by this task. Do not implement this recommendation before reviewing Pi data.

## Validation and next step

The [Pi procedure](pi-latency-procedure.md) uses one helper for inspection,
snapshots, bounded benchmarks, opt-in foreground voice capture, filtering and
reporting. Normal hardware measurement requires an explicitly agreed interruption
of the current app to run the instrumented build. This task does not perform it.

Relevant existing and new tests cover correlation, absent cache metrics, multiple
native/final-no-tools rounds, segment scheduling and real curl/fake-SoX fixtures,
timeouts, interrupted contexts, lock refusal, memory, authorization and speech/UI
sequencing. Fake model streams are protocol fixtures, not LLM inference. Exact
final counts and commands are recorded in
[validation.json](evaluation/voice-latency-2026-11-01/validation.json).
**Final relevant serial run: 205 passed, 0 failed/cancelled/skipped.** App TypeScript
emission, test typechecking, shell/Node syntax and diff checks pass. One unchanged
launcher shell-process test failed intermittently in a parallel run, then passed
isolated (9/9 launcher tests) and in the complete serial run; no root cause or
production launcher defect is claimed. Strict VM fixtures were updated to include
the new pure timing dependency. No daemon-registration build hook, installation,
model management or full unrelated deployment suite is needed for this change.
