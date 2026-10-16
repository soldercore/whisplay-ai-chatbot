# Narrow unsupported-reminder input guard

The reported Pi transcript was correct: "Can you remind me in two minutes to
call the doctor?" The model promised a future phone call without a confirmed
tool operation. The existing executor validates actual calls; ordinary model
prose previously streamed without checking whether a reminder was possible.

The current built-in registry has volume, web, memory, image/vision, music,
conversation and read-only reference tools. None implements timed reminders,
timers, scheduling or phone calls. Windows has no external `plugins/` directory
or installed top-level `whisplay-plugin-*` packages. This is repository evidence;
the Pi's actual configuration and plugins are NOT VERIFIED.

## Scope and execution

`src/config/unsupported-reminder.ts` recognizes only anchored English requests:

- `remind me <time> to <task>` and `remind me to <task> <time>`, where time is
  `tomorrow` or `in <positive digits|one|two> <seconds|minutes|hours>`.
- `set a reminder for <nonempty text>`.
- Optional `can/could/would you` or `please` prefix, case-insensitive, with
  surrounding whitespace trimmed. Multiline bodies are not recognized.

The response is fixed:

> I can't set timed reminders yet, so no reminder has been created.

ASR assigns recognized text to `ctx.asrText`, then enters `answer`. For Ollama,
the answer state recognizes the same narrow inputs before prompt preparation:
it skips RAG retrieval and passes no model summarizer to `autoSaveExchange`.
Conversation saving still uses the existing local heuristic summary. Persistent
memory code, formats and queues are unchanged; no reminder is stored as a fact.

Ollama's public `chatWithLLMStream` returns the fixed reply before its internal
tool loop, automatic search, context compaction and HTTP generation request.
Existing cancellation of an older answer and idle-history reset happen first.
The input messages and truthful assistant reply enter the ordinary in-process
and JSON chat history; the timestamp is updated. The existing partial/end
callbacks deliver the reply to StreamResponser, TTS and speech/display callbacks.
No tool call/result is invented, no model output is buffered, and no second
model round is used. The load-only startup warmup remains unchanged.

Other providers and unmatched text keep their existing paths. Informational
questions about remind/schedule/call, quoted examples, ordinary conversation,
memory commands and supported volume requests are not broadly blocked. No
existing tool, authorization policy, NDJSON parser, resource limit, persona,
model, Piper/Whisper, renderer or speech synchronization code is changed.

This is not general action-claim verification. Other phrasings, languages,
elliptical follow-ups, standalone timer/scheduling/phone-call requests and
unsupported promises in otherwise ordinary answers remain outside the guard.
Revisit this explicitly unsupported capability rule before adding a legitimate
scheduling tool; tool names/descriptions are not a capability-discovery contract.

## Deterministic evidence and validation

`src/test/unsupported-reminder.spec.ts` uses the real shared LLM entry point,
Ollama provider, registry and central executor. Mocked byte streams reproduce
the exact false promise. Mixer, playback, ASR and external services are stubbed;
all filesystem fixtures use the existing isolated preload.

Tests cover the exact reproduction, six equivalent direct requests, twelve
unaffected informational/conversational inputs, no model/tool calls on guarded
input, disk and subsequent wire history, approved volume/memory operations,
direct provider callers, replacement cancellation, and the actual answer state
with real StreamResponser and fake synthesis/playback for RAG on and off.
Exact spoken chunks and display text are independently specified.

Baseline: 175/175. The initial fixture-corrected suite gave 13 passes/11 failures
before production changes. The final 26 tests against the original provider
loaded only in memory gave 13 passes/13 failures; no production file was reverted.
The TTS fixture uses playable fake audio and independently expects the existing
comma-based splitting. Additional answer-state tests reproduced auxiliary RAG/summary calls before their fix
(23 passes/2 failures). Logs remain under ignored `.test-artifacts/reminder-*`.

Final suite has 26 new tests. One full run had 200 passes/1 failure in the
unchanged wall-clock speech-sync test (30 rather than 22), the previously
documented timing issue. Its log is retained as `reminder-full.log`; no speech
implementation or assertion was modified.

Final targeted suite: **26/26 passed**. Isolated unchanged speech suite: **11/11
passed**. Unchanged full rerun: **201/201 passed**, zero failures/skips/cancellations
(`reminder-full-repeat.log`). Production TypeScript, strict TypeScript validation
of all 12 spec files and `git diff --check` pass. Only the seven listed project
files changed; all 442 existing data files retain their hashes, sizes and mtimes.

Changed files: this report, `AGENTS.md`, `package.json` (test registration only),
`src/config/unsupported-reminder.ts`, `src/cloud-api/local/ollama-llm.ts`,
`src/core/chat-flow/states.ts` and `src/test/unsupported-reminder.spec.ts`.

Real model behavior, installed Pi capabilities, voice, physical display/audio
timing and device resource use remain NOT VERIFIED.
No Pi connection, deployment, commit or push is performed for this correction.
