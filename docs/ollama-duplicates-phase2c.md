# Phase 2C: duplicate-call investigation

Scope: Windows project copy only. No skills or agents were invoked for this
work; the application's existing skill-tool source was inspected as code.
No Pi connection, live model, hardware, deployment, dependency change or commit.

## Authorization and concrete tool inventory

There is no project-root `.env` in this copy, no `plugins/` directory, and no
installed top-level `whisplay-plugin-*` package was found. Thus the table describes
the executable built-in contracts and their configuration gates, not a claim
about the actual running Pi configuration. That configuration is NOT VERIFIED.
Template values are examples, not evidence of runtime enablement.

Every executable entry must pass `config/tool-execution.ts:100-138`: enabled,
not cancelled, valid non-reserved name, unique registration, actual handler,
membership in the offered list and supported validated JSON arguments. An
advertised tool alone does not prove that its backend is usable. Tool outputs
marked success remain handler reports, not independent proof of goal completion.

For Ollama, `OLLAMA_ENABLE_TOOLS` must equal `true`. `llm-tools.ts:59-73,99-105`
wraps handlers and applies the centralized boundary. Request-specific offers
come from `tool-router.ts:49-96` and `ollama-llm.ts:288-301`: memory, volume and
image tools are gated by the request (or an eligible follow-up). Other registered
tools are normally offered. After automatic time-sensitive search, only
`web_search` and `fetch_webpage` remain offered. A direct-answer request skips
web execution. Disabled, unoffered or invalid calls cannot become executable
through native calls or JSON fallback.

**D** below means the existing Ollama duplicate check applies across rounds of
one public request, for both native and JSON-fallback calls. It does not mean
same-response or cross-request exactly-once execution. No inventory entry has
a separate general duplicate guard in the central executor. Other LLM providers
use the authorization wrappers but not this Ollama signature set.

| Tool name | Can pass authorization / registration prerequisites | Operation | Duplicate guard | Definition |
| --- | --- | --- | --- | --- |
| `setVolume` | Built-in; volume-related request; numeric `percent` 0..100 | Changes mixer | D | `plugin/builtin/llm-tools.ts:22` |
| `increaseVolume` | Built-in; volume-related request; empty arguments | Adds 10 volume points, capped | D | `plugin/builtin/llm-tools.ts:50` |
| `decreaseVolume` | Built-in; volume-related request; empty arguments | Subtracts 10 volume points, capped | D | `plugin/builtin/llm-tools.ts:73` |
| `fetch_webpage` | `WEB_SEARCH_ENABLED` is not `false`; no API key required | HTTP read; updates in-process previous-page links | D | `config/web-search.ts:68` |
| `web_search` | Same web gate; required query; public search has keyless fallback | HTTP reads | D | `config/web-search.ts:115` |
| `webSearch` | Web gate plus selected legacy provider's valid key configuration | Provider HTTP read | D | `config/web-search.ts:152-204` |
| `webImageSearch` | Legacy search prerequisites plus `WEB_SEARCH_INCLUDE_IMAGES=true` | Provider HTTP read returning URLs | D | `config/web-search.ts:206-235` |
| `searchLocalMemory` | `MEMORY_ENABLED=true` (case-insensitive); memory-related request | Reads stored facts/conversations | D | `config/local-memory.ts:815-845` |
| `storeLocalMemory` | Same gate and routing; content, optional valid kind; handler rejects secrets | Writes existing memory format atomically | D | `config/local-memory.ts:850-879` |
| `mempalaceSearch` | `MEMPALACE_ENABLED=true`; usable configured Python/module needed for success | Memory CLI search | D | `config/mempalace.ts:52` |
| `mempalaceStore` | Same MemPalace gate and backend requirement | Writes memory through fixed Python invocation | D | `config/mempalace.ts:105` |
| `mempalaceWakeUp` | Same MemPalace gate and backend requirement | Requests context from CLI | D | `config/mempalace.ts:157` |
| `mempalaceStatus` | Same MemPalace gate and backend requirement | Requests status from CLI | D | `config/mempalace.ts:196` |
| `listSkills` | `HARNESS_COMMAND_TOOL_ENABLED=true/1`; skill flag defaults true; legacy `HARDNESS_*` fallback | Reads directory/reference metadata; no action permission | D | `config/harness-command.ts:136-151,191-197` |
| `readSkill` | Same gates; valid exact installed skill name | Reads reference text; no execution permission | D | `config/harness-command.ts:153-188` |
| `endConversation` | `WAKE_WORD_ENABLED=true` (case-insensitive) | Success callback ends wakeword conversation after reply | D | `config/llm-tools.ts:17-32`; `core/chat-flow/states.ts:412-417` |
| `playMusic` | Nonempty `MUSIC_LIBRARY_DIRS`; query required | Selects track; callback defers playback to music state | D | `plugin/builtin/music-tools.ts:7-61` |
| `playMusicRandom` | Same music registration gate | Selects random track; callback defers playback | D | `plugin/builtin/music-tools.ts:66-80` |
| `generateImage` | Nonempty `IMAGE_GENERATION_SERVER`; image-related request; usable selected provider for success | Generates/saves image, display callback | D | `config/image-generation.ts:30-56` |
| `showPreviouslyGeneratedImage` | Same image registration/routing; existing image for success | Changes displayed image | D | `config/image-generation.ts:61-71` |
| `showCapturedImage` | `ENABLE_CAMERA=true`; captured image for success | Changes displayed image | D | `config/vision.ts:31-46` |
| `describeImage` | Nonempty `VISION_SERVER`; usable selected vision provider for success | Reads image via provider; may use remote service depending on provider | D | `config/vision.ts:49-72` |
| `runCommand`, `checkCommand`, `stopCommand` | **Never executable**; filtered from registry and reserved at executor, including malicious registration | General shell runner removed | Not applicable: authorization always rejects | `config/llm-tools.ts:59`; `config/tool-execution.ts:18,107` |

External plugins can add names only through registration and supported schemas;
they are trusted in-process code, not a sandbox. No additional installed plugin
tool was assumed. `config/custom-tools/template.ts` is a template, not imported
by the current collector. MemPalace uses fixed host-owned Python entry points,
not a restored model-selected general shell command. CLI-internal behavior and
all hardware/backend success prerequisites remain unverified here.

## Duplicate semantics and confirmed root cause

`ollama-llm.ts:200-231` constructs a signature from the exact tool name and
recursively sorted argument keys. Historically **every string argument** was
lowercased and all punctuation/whitespace collapsed. Array order and numeric
values are retained. The same normalized set covers all currently offered tools,
not just disabled `checkCommand`.

`ollama-llm.ts:604-632` checks the whole incoming batch against the signatures
already recorded by earlier rounds. Any match takes the existing final no-tools
answer path for that batch. Signatures are recorded before dispatch. They are
shared through recursive rounds (`:722-728`) and include automatic search
(`:283`), but a fresh set is created for every public request (`:784`). This is
request-scoped loop suppression, not conversation/process-scoped idempotency.
The latest prior result lookup is by tool name, not an argument-keyed cache;
this existing behavior is unchanged.

JSON fallback is interpreted against the actual offered names (`:554-564`),
then joins native calls in the same signature/authorization/dispatch path
(`:569-574,604-654`). No alternative execution path was added.

The historical `checkCommand` polling defect is no longer executable because
Phase 1 blocks the tool unconditionally. However, a current supported interaction
was affected: fetching two different documentation pages during one question.
`fetch_webpage` uses the supplied URL to select actual HTTP resources
(`web-search.ts:286-310`); `/guide-a` and `/guide/a` are different resources but
previously produced the same duplicate signature. Case-sensitive paths and
punctuation in query values have the same collision.

## Reproduction before production change

The original 144 tests passed. Five regression tests were then added to the
existing `web-search.spec.ts` fixture, before editing production code. This uses
the real provider, actual registered `fetch_webpage` handler, centralized
authorization and HTTP page fetches to a loopback server; only the model is
scripted. No new tool was invented and no external page was fetched.

The original implementation produced **14 passed / 2 failed** in that suite.
Both the native and JSON-fallback distinct-URL tests failed: expected GETs
`['/guide-a', '/guide/a']`, observed only `['/guide-a']`. The log reported
`Repeated tool call blocked: fetch_webpage:{"url":"http 127 0 0 1 <port> guide a"}`.
The three other added tests already passed (true-duplicate suppression and
independent-request isolation). Evidence: ignored local
`.test-artifacts/phase2c-reproduction.log`.

## Minimal correction and tests

Only `ollama-llm.ts:216-231` production code changed in this phase: preserve the
exact top-level `url` and `current_url` values **only for `fetch_webpage`** when
building signatures. Other argument normalization, sorted object keys, array
handling, authorization, execution, loop limits and no-tools fallback remain as
before. The array map uses an explicit callback so its index is not passed as
the new optional normalization flag. No URL canonicalization was introduced;
different spellings of an equivalent URL are not guaranteed to deduplicate.

Changed files:

- `src/cloud-api/local/ollama-llm.ts`: the scoped signature correction above.
- `src/test/web-search.spec.ts`: five tests, fixture GET pages, test-process-only
  proxy removal to ensure loopback requests stay local, isolation assertion and
  completion count capture. Existing tests retained.
- This investigation report. Earlier uncommitted work is preserved.

Permanent tests at `src/test/web-search.spec.ts:275-327`:

- **A/D/E:** native and fallback repeated authorized reads of distinct URLs
  across rounds. Each runs all six combinations of `url`/`current_url` and
  path punctuation, path case, query punctuation. Independently specified GET
  paths, tool-result URL headers, event order, answer and one completion callback.
- **B/D/E:** identical webpage calls remain blocked across rounds for native
  and fallback, even when argument-key order changes. Exactly one GET and the
  existing final no-tools request are asserted. B is applicable and passes.
- **C:** two public requests on the same provider/history can fetch an identical
  URL twice; first native, second fallback. Expected two GETs and fixed answers.
- **F:** existing tool-execution/Ollama security suites still reject reserved
  shell names, invalid arguments, disabled and unoffered tools.
- **G/H:** existing 11 history tests and 23 streaming tests remain unchanged,
  including exhaustive byte splits, UTF-8, isolation and 1 MiB record bounds.

Validation: targeted suites **85/85**, full suite **149/149**, zero failures,
skips or cancellations. Production `tsc --noEmit --incremental false` and strict
TypeScript checking of all spec files passed. `git diff --check` passed; Git may
print existing LF/CRLF conversion warnings. Full log:
`.test-artifacts/phase2c-full.log`. Earlier baseline and failure logs are retained.

## Limits and remaining risks (no speculative implementation)

- **Same-response duplicates have no suppression.** The check precedes adding
  any signature in the batch, then dispatch uses `Promise.all` (`:604-654`). An
  isolated diagnostic using the real provider/executor and a fake
  `increaseVolume` handler confirmed two effects for two identical calls in
  one response, versus one effect for the same call across two rounds. No
  hardware was invoked. Evidence: `.test-artifacts/phase2c-duplicate-probe.cjs`
  and `.log`. This is an existing coverage limitation, not a newly implemented
  defect fix. Adding batch idempotency would be a new mechanism, excluded here.
- This matters for relative volume changes, memory writes, image generation,
  music/display effects, conversation termination and trusted plugin actions.
  Central authorization validates each call but does not promise exactly-once
  effects. Independent requests intentionally do not deduplicate either.
- An identical read after a state change, or intentional same-argument relative
  volume changes, cannot be distinguished from an accidental loop by the current
  signature set. No intent/polling protocol was invented. Other strings retain
  historical fuzzy normalization; suitability for exact skill/plugin identifiers
  or other stateful sequences has not been established by these tests.
- Authorization and disabled tools remain intact. No retries, schedulers,
  polling infrastructure, new approval flow or alternative dispatcher was added.
- Phase 1.5 initialization, the NDJSON parser and history serialization were not
  edited. Source/data preservation is checked against the pre-work manifest;
  actual voice, Piper, Whisper, memory, display and model configuration files
  remain unchanged. Test memory/audio data stays under `.test-artifacts/`.
- Live Ollama model choices, tool generation, installed backend versions and
  physical Raspberry Pi behavior are **NOT VERIFIED**. Local fixtures establish
  host-side behavior, not whether the 1.7B model reliably chooses these calls.

Stop at Phase 2C. No Phase 2D work, commit, push or deployment.
