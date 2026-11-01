# GLaDOS D: opt-in implementation, not a demonstrated model win

**Latest follow-up:** [Gemma 4 compatibility and measured comparison](gemma4-evaluation.md)
adds 83 completed generations without accepting a replacement. Qwen + A remains
the user's selected fallback; the chronological records below are retained.

**Update — real hardware regression:** the user has now confirmed the exact
Qwen configuration and supplied a failing eleven-turn Pi conversation. D failed
acceptance. [The measured follow-up investigation](glados-d-hardware-regression.md)
contains 72 actual 2B generations and supersedes the initial "no model evidence"
status below. No tested replacement was accepted and PR #2 remains draft. The
remaining text preserves the original implementation/evaluation record.

2026-11-01. Based on accepted custom branch `tts-pipeline-fix` at
`9aa0fcfae89f67539bbd6e32b8d8511be490f68a`.

**A remains the production default.** D is implemented and selectable, but no
real A/D generations, listening comparison or subjective quality scores are
available. The user confirms the previously documented model is
`qwen3.5:2b-q4_K_M` at 4096 tokens; current thinking is unconfirmed, and no separate
Ollama test instance is confirmed. No production Pi connection, configuration
change, model download, deployment or inference benchmark was performed.

## Findings and design

The existing A/B/C research in [persona-consistency-comparison.md](persona-consistency-comparison.md)
is retained. A's stronger dry humor and B's sometimes better greetings are
user-reported findings; C was never activated or validated on the physical model.
None constitutes evidence that D wins.

The current prompt trace still holds: `personaPrompt` supplies the first part of
`llm-config.ts`'s system prompt. Shared speech/wake-word instructions are appended;
Ollama retains the first system message through both normal and final-no-tools
paths, reset and budgeting. Request-time date/search guidance does not replace
the persona. Relevant memory and RAG are additional context, not a persona
selector. Previous generated answers remain in the live conversation and can
reinforce generic style; entire saved conversation files are not reloaded as
Ollama history. No code path silently replacing GLaDOS with the default assistant
was found. Small-model instruction following and history contamination remain
plausible causes, not independently proven diagnoses of each reported answer.

A emphasizes abstract adjectives and prohibitions. Its narrow ban on the words
"AI language model" leaves paraphrases such as "merely code" uncovered. B supplies
examples, with a known copying risk; C broadens the disclaimer rule but mostly
adds prohibitions. D instead adds compact positive conversational mechanics:

- Observe a contradiction in the actual exchange; use understatement, faint
  praise or a final-clause reversal. Do not force a joke or recite game lines.
- Let recent teasing, apologies and achievements affect delivery subtly. Carry
  the topic into follow-ups, not the same joke. Respect serious help and requests
  for plain delivery immediately.
- Avoid unsolicited identity/feelings disclaimers while answering direct
  identity questions honestly. Admit missing evidence and failed tools plainly.
- Let requested technical detail override casual brevity. Presentation never
  changes facts, measurements, memory contents or tool permissions.

These are instructions to the existing model, not a deterministic emotion
classifier. Existing conversation context is the only continuity mechanism.
There is no emotion LLM, timer, background worker, mood record, psychological
profile, extra generation round or permanent emotional memory. After normal
history reset/trimming, forgotten tone is intentionally not reconstructed from
private memory. Separate mood state has no measured benefit here and is omitted.

### Research and attribution

Inspected [dnhkng/GLaDOS](https://github.com/dnhkng/GLaDOS/tree/ea018f57fac8bbdde5057b65e372ddf9ac0758a8)
at `ea018f57fac8bbdde5057b65e372ddf9ac0758a8`:

| Source path | Finding and decision |
| --- | --- |
| `configs/glados_config.yaml` | Strong short character framing and dialogue demonstrations; forced mockery, unsafe examples and universal two-sentence caps conflict with this build's requirements. No prompt or examples copied. Its Gemma/llama.cpp setup is not our Qwen/Ollama stack. |
| `src/glados/autonomy/emotion_state.py` | PAD state and slower mood become readable response guidance. Reuse the distinction between continuing tone and reacting to the current request, without numeric state. |
| `src/glados/autonomy/agents/emotion_agent.py` | Three model-scored PAD axes, persisted state, event queues, cancellation and elapsed-time recovery; 95% drift recovery over the configured six minutes. Too much unproven work/state for this task; not ported. |
| `src/glados/autonomy/config.py` | HEXACO traits influence the emotion agent. High precision/curiosity and restrained social distance inform D's prose; no trait vector, manipulative behavior or mood persistence added. |
| `src/glados/core/prompts.py` | Separates current source evidence from presentation and insists on honest search results. Our existing authorization and measurement paths are preserved. |
| `src/glados/core/llm_processor.py`, `context.py` | Main response assembly separates stable context from volatile state, then streams complete speakable clauses to its TTS queue. D keeps our existing stable prefix and history instead of injecting a changing mood message that could also disturb Ollama's prefix cache. |
| `src/glados/core/speech_chunking.py`, `speech_markup.py` | Clause boundaries and silent avatar markers belong to that project's speech protocol. Our Piper path has no such marker contract; none copied or emitted intentionally. |
| `LICENSE.txt` | MIT, copyright 2022 David Ng. Design research only: no code, prompt text, dialogue, assets or substantial source portions are vendored. The repository's GPL-3.0-only licensing and existing voice provenance remain unchanged. |

## Runtime scope and later opt-in

In a separately authorized test checkout, selecting both
`ASSISTANT_PERSONA=glados` and `GLADOS_PERSONA_VARIANT=D` uses D. Unset, A or unknown
variants retain A; B/C remain evaluator-only. Other personas and `SYSTEM_PROMPT`
retain their original behavior. The new template setting is commented out.
Prompt composition happens at process startup, as before. No running process or
local `.env` was changed, and this document is not a deployment instruction.

Deterministic memory command replies also select D's plain clinical wording.
They lack conversational tone context, so they do not force sarcasm or diagnose
the user's behavior. Save/update/forget/recall, secret rejection, atomic storage,
backups and cancellation are unchanged. A/default replies are unchanged. D recall
returns the supplied facts exactly, and not-found no longer asserts the user
"never told" the system something that might simply be unavailable now.

Actual before/after outputs from `memoryReply` with the same supplied detail
(one existing A variation shown; these are not model generations):

| Operation | A | D |
| --- | --- | --- |
| Update | Updated. Your favorite color is green now. Consistency was never your strength. | Updated. Your favorite color is green. |
| Missing saved fact | I have nothing on your favorite color. You never told me. I would remember. | I have nothing saved about your favorite color. |
| Recall | Your favorite color is green. You told me yourself. | Your favorite color is green. |

Generative before/after examples are **not available**. The existing repeated-
greeting fixture contains the previously reported generic "merely code" answer;
D's recovery from it must be judged from actual future paired outputs, not from
invented demonstration replies or these deterministic memory examples.

### Speech and cost

The current `StreamResponsor` already releases complete sentences, preserves
ordered TTS playback and cancellation, and reports audio-paced word reveal.
Natural sentence punctuation is enough to test D's deliberate delivery. No
artificial sleep, pause injection, SSML, emotion marker parser, voice/model change
or audio-chunking modification is justified without listening evidence.

| Prefix | Characters / ASCII bytes | Existing conservative token estimate |
| --- | ---: | ---: |
| A | 1550 | 544 |
| B, current fixture | 1719 | 605 |
| C | 1729 | 604 |
| D | 1695 | 593 |

D adds 145 bytes / 49 estimated tokens over A, approximately 1.2% of a 4096-token
window. Estimates use the repository's existing message estimator, not Qwen's
tokenizer. Shared suffix/history/tool schemas cost extra, equally for all
variants. A's selected prefix and runtime overhead remain unchanged. D adds no
inference calls; real latency, actual prompt token counts, cache effects and
Piper timing remain unmeasured. Static size is not a latency benchmark.

## Targeted human evaluation

The original A/B/C prompts, fixture, three-repetition default and 78-request
comparison remain available. `--candidate=D` compares A/D. Five additional
explicitly selectable scenarios cover teasing/apology, earned credit, a mistake
followed by distress, direct identity questions and a six-turn diagnostic
conversation. They are not inserted into the default workload.

Start with an offline plan; it imports no application/provider, dispatches no
tools, speaks nothing, and writes no user memory:

```sh
node --require ts-node/register/transpile-only scripts/persona-comparison.cjs \
  --plan --candidate=D --repetitions=1 \
  --scenarios=greeting,teasing_repair,earned_credit,serious,temperature
```

That selection is **20 generation requests** if later explicitly run. B or C can
use the exact same selection/settings. Do not run all variants/replicates before
this small comparison provides a reason to continue.

Before any future `--run`, verify the actual model, thinking, endpoint and output
limit from the authorized test configuration. `OLLAMA_MODEL` and
`ENABLE_THINKING=true|false` must be explicit; neither is inferred from historical
notes. The evaluator honors `OLLAMA_ENDPOINT` only for literal loopback hosts,
rejects URL credentials/non-root paths and disables proxies/redirects. Its
historical endpoint fallback is printed in the plan, not evidence of a working
production endpoint. It requires the exact fixture model already loaded at 4096
via `/api/ps`. It never pulls/loads a replacement model or sends `num_ctx`.

Only after those checks and separate authorization, use the same command with
`--run` in the test environment. Keep thinking/output settings unchanged across
variants and avoid concurrent inference. Histories, shared suffix, date and
external fixtures are paired; each variant's actual answer feeds its own next
turn. Every request must fit the existing 4096 budget without trimming; an
overflow/error ends the experiment rather than silently changing conditions.

Results retain requests, generated text, elapsed time, first-content time and
Ollama prompt/evaluation/load/total timing metadata when supplied. Server duration
fields use Ollama's nanoseconds; `elapsedMs`/`firstContentMs` use milliseconds.
Alternating prefixes measures cold/cache-mixed comparison timing, not steady-
state production latency. Empty, truncated, tool-proposing or incomplete streams
fail; there are no automatic retries. All human score fields remain null.

Human review must inspect actual outputs: recognizable character and contextual
sarcasm, natural humor, technical completeness, no unsolicited disclaimers,
variation over repeated greetings, gentle apology recovery, honest identity and
respectful serious help. Humor omission is correct when inappropriate. Grade
accuracy/nonfabrication and safety independently; averages must not hide a
regression. Do not ask the generating model to certify its own personality.

If the smoke comparison convinces a human reviewer, repeat relevant scenarios
three times, then include `humans,dns_short,dns_detailed,tool_failure,recall,unrelated_followup,repeated_greeting,identity,mistake_then_distress,long_followup`.
Inspect generated responses and actual timing before considering any promotion.
Temperature/memory/tool-error inputs are controlled fixtures (temperature uses
one real test-host snapshot or null), not evidence of live tool execution.

Acceptance requires convincing authenticity/humor/consistency gains without
factual, safety, repetition, requested-detail or material latency regressions.
Then separately validate D through the real authorized app: voice/listening,
audio-paced text, tool authorization/results, memory recall, interruptions,
buttons and launcher switching. A remains default until that evidence supports
an explicit production decision. No claim of improved generated quality or
perfect character fidelity is made by this PR.

## Automated validation

Validated in the isolated x86-64 Linux checkout using Node 24.19.0 and the
existing locked dependencies; no package or lockfile changes:

- Focused persona/evaluator tests: **29/29 pass**, including a run with an
  inherited D environment to check that A controls remain isolated. Covers
  opt-in/default behavior, shared suffix/wake instructions, real disposable
  memory storage, secret rejection, paired follow-up history, endpoint checks,
  settings preflight, streaming completion and timing fields.
- Production and strict spec TypeScript checks pass:
  `tsc --noEmit --incremental false` and
  `tsc --project tsconfig.tests.json --incremental false`.
- Isolated emitted build passes with `tsc --incremental false`; the existing
  registration script reports `daemon socket not found, skip`. Yarn is not
  available on this executor, so this is the direct compiler/registration build,
  not a claim that `yarn build` ran successfully.
- `node --check scripts/persona-comparison.cjs`, CLI offline smoke plan and
  `git diff --check` pass. No actual generation was attempted.
- Full `npm test`: **499/502 pass initially**, zero skips. Two real-rsync tests
  lacked the required binary. One unchanged launcher test failed because its
  external sleep child was no longer alive; the cause of that transient failure
  is not established. It passes in both isolated and serial rechecks.
- Extracted official Debian `rsync_3.2.7-1+deb12u6_amd64.deb` and
  `libpopt0_1.19+dfsg-1_amd64.deb` into a test-only directory outside the repository,
  without system installation or application dependencies. With that local PATH,
  the three failed cases pass **3/3** in a serial targeted run. Thus all **502**
  cases have a passing result across runs; this is not a single clean 502-test
  run. The hundreds of already-passing cases were not rerun.

Full regression coverage includes existing memory, tool authorization, Ollama,
ASR, TTS ordering, speech sync, cancellation/lifecycle, startup-data and deployment
preservation contracts. Tests use isolated data and mocked model/hardware edges;
they do not establish real D conversational quality or physical performance.

Provider implementations, memory storage, tool authorization/registry, UI/audio,
lifecycle, wake-word, deployment scripts, dependency manifest and lockfile are
byte-identical to the accepted baseline. The original A prompt and A/default
reply tables are unchanged. The new fixture contains only fictional test input.
The 37 original custom commits and accepted upstream history remain ancestors.

The remaining release gate is actual matched-model A/D output and human review,
followed by separately authorized app/voice/hardware acceptance. Production A
stays selected until that evidence supports a separate decision.
