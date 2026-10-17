# GLaDOS personality: evidence and controlled A/B comparison

## Final evaluation-only candidate C

The user subsequently reported physical Qwen3.5 2B results: A had better dry
humor about humans; B had better short greetings but sometimes asked unwanted
follow-up questions. Both still produced generic disclaimers, monologues or
unsupported claims. These are user-reported observations; the raw physical
outputs were not independently inspected in this iteration. The earlier
NOT VERIFIED statements below describe the original local investigation.

Candidate C starts from the actual production A prefix and makes four targeted
edits in `scripts/persona-comparison.cjs`: constrain discussion of humans to one
dry observation, stop after a short greeting, broaden the no-invention rule to
personal experiences, and replace the narrow AI-language-model phrase ban with
no unsolicited AI/code/feelings disclaimers plus honest direct identity replies.
A's deadpan delivery, optional humor, no unnecessary questions/service offers,
technical detail, measurement units and serious/emergency rules stay intact.
No examples were added: the reported comparison does not demonstrate that B's
four examples improved humor, and copying/catchphrases remain a known risk.
Neither production A nor the original B fixture was changed.

The existing runner defaults to A/B. `--candidate=C` selects A/C instead, with
the same ten scenarios, 13 turns, three repetitions, alternating variant order,
shared suffix/context, settings and independent histories: 78 generations.
Human scores remain null until reviewed. No production selection accepts C.

Minimal physical procedure, after these evaluation files are available through
the user's normal process, with the exact model already loaded at 4096 and no
concurrent chatbot inference:

```bash
cd ~/whisplay-ai-chatbot
mkdir -p .test-artifacts
node --require ts-node/register/transpile-only scripts/persona-comparison.cjs --plan --candidate=C > .test-artifacts/persona-ac-plan.jsonl
node --require ts-node/register/transpile-only scripts/persona-comparison.cjs --run --candidate=C > .test-artifacts/persona-ac-results.jsonl
echo "Evaluation exit code: $?"
```

Inspect the plan before `--run`; do not alter model, thinking or output settings
between variants. Prioritize `greeting`/`repeated_greeting`, `humans`, `temperature`
and `serious`, then check the other existing cases for regressions. Review all
three repetitions for brief natural greetings without questions, restrained
humor without a humanity monologue, exact supplied temperature/unit or honest
unavailability, and practical respectful help without mockery. Review factual,
nonfabrication and safety dimensions separately; never trade them for humor.
Temperature is one actual host snapshot when available, supplied identically
through simulated tool context; this runner does not validate real tool dispatch.

C is a hypothesis, not a proven quality fix. Prompt rules cannot guarantee
truthfulness, brevity or style; prior generic history may still influence it.
No local unit test establishes Qwen behavior. Do not activate C unless actual
paired results improve greetings/consistency while retaining A's humor and
accuracy, with no serious-help or factual regression. No additional personality
iteration or production change is included here.

Local validation of C: 19/19 focused persona tests and 433/433 full-suite tests
passed; production TypeScript and `git diff --check` passed. C is 1729 ASCII
characters versus A's 1550; the existing conservative estimator reports 604
versus 544 tokens, a 60-token increase (actual Qwen tokenization unmeasured).
No C model generations or physical tests were performed.

## Original investigation record

Date: 2026-10-18. **Production persona is unchanged. Candidate B is not enabled.**
The task requires demonstrating improvement before another production change.
There is no active development Ollama at `127.0.0.1:11434`; the exact Qwen model
was also not found in the standard Windows model-manifest location. Other custom
model stores were not searched. No server/model was started or installed.
**Actual A/B generations and subjective scores: NOT VERIFIED.**

## Findings and prompt trace

1. `src/config/persona.ts:17` defines the current 1550-character GLaDOS prompt.
   `personaPrompt` selects it for `ASSISTANT_PERSONA=glados`, independently of
   `SYSTEM_PROMPT`. The reported physical persona selection is accepted; this
   is not being diagnosed again as a default-persona configuration problem.
2. `src/config/llm-config.ts:5` obtains that prefix. Line 31 appends shared spoken
   formatting and optional wake-word instructions. Neither asks for a cheerful
   assistant or a generic AI identity disclaimer.
3. `src/core/chat-flow/states.ts:360` prepares relevant local memory and optional
   RAG. Lines 385/391 pass them as additional system messages before the user
   question. Local memory asks for relevance, English and no invented details
   (`src/config/local-memory.ts:649`); RAG asks to use retrieved knowledge
   (`src/core/Knowledge.ts:286`). These instructions are compatible with persona
   in the inspected code. Arbitrary retrieved content could still influence a
   model; no private Pi context was inspected or assumed clean.
4. `src/cloud-api/local/ollama-llm.ts:124` initializes the first system message;
   reset retains it at line 213. Request-time date/search guidance is appended
   at line 291. Tools have task schemas and result instructions, not a new
   generic identity. The final no-tools path likewise retains the first system
   message (`:404`).
5. The active conversation receives inputs at line 508. Previous generated
   answers stay in this process's history until normal reset/trimming, so an
   earlier generic answer can supply a competing style example. The provider
   saves history but does not reload those entire saved conversations into the
   Ollama message list on startup. Local-memory retrieval is a separate path.
6. At line 576, budgeting protects all system messages; it does not rewrite the
   persona (`ollama-context-budget.ts:50`). At line 585 these messages are sent
   to `/api/chat`. Both generation paths use temperature 0.7, the existing
   `OLLAMA_PREDICT_NUM` if configured, and the existing thinking flag.

No source path was found that replaces the selected GLaDOS prompt with the
default character. Static inspection cannot prove the exact payload/build on
the Pi or identify which model/context interaction caused each reported answer.

The prompt contains many abstract style prohibitions but no positive dialogue
demonstrations. Its phrase prohibiting the term “AI language model” does not
specifically cover paraphrases such as the reported “merely code” explanation.
Those are plausible weaknesses, not a proven sole root cause. The confirmed
problem is model-generated style failing the user's physical acceptance cases.
Another adjective change cannot be declared a fix from unit tests.

Deterministic local-memory command replies bypass generation, as does the
system-health prefetch failure reply (`ollama-llm.ts:356`). A candidate prompt
does not change those replies. Summary requests use a separate summary prompt;
they do not replace the conversation's persona message.

## Evaluated approach, not production activation

The inspected [upstream configuration](https://github.com/dnhkng/GLaDOS/blob/main/configs/glados_config.yaml)
uses a system characterization followed by example user/assistant exchanges.
We adopt only the idea of positive tone demonstrations. Its dangerous advice,
mandatory insults, laboratory assumptions and universal two-sentence cap are
excluded. Its architecture/model/runtime parameters are not copied.

`src/test/fixtures/persona-consistency.json` contains candidate B: concise
instructions and four original examples about an operational greeting, human
logic, DHCP and an anxious appointment. These use different questions from the
evaluation inputs, contain no sensor numbers or user facts, and include a
serious supportive response. Humor is optional; factuality and safety outrank
character. Generic identity explanations are discouraged without prohibiting
honest answers to actual identity questions.

Examples are embedded in a single system string with an explicit fictional
style-example label and instruction not to quote them. No new message structure,
persona engine, response rewriting or production inference request is added.
Whether this helps the exact 2B model remains a testable hypothesis. Historical
example copying on a different small model justifies checking repetition, not
assuming that every few-shot approach must fail.

| Persona prefix only | A: current production | B: candidate |
| --- | ---: | ---: |
| Characters / UTF-8 bytes | 1550 | 1680 |
| Repository conservative message-token estimate | 544 | 589 |

Delta: **+130 bytes / +45 estimated tokens**, about **1.10% of 4096 tokens**.
This uses the existing JSON/UTF-8 estimator, not Qwen's tokenizer. Actual token
counts must be read from evaluation metadata. The shared speech/date suffix,
context and history have their own unchanged cost. Production overhead is zero
because B is not imported by the application.

## Reproducible evaluation

New files:

* `scripts/persona-comparison.cjs`: plan-only by default; explicit `--run` sends
  text inference to loopback Ollama only. No tool execution or application start.
* `src/test/fixtures/persona-consistency.json`: B, ten scenarios and independent
  human scoring dimensions.
* This document. `src/test/persona.spec.ts` adds nine deterministic fixture,
  request, isolation, streaming/completion and dry-run tests to the existing seven.

The runner reads the production prompt and real shared suffix from existing
prompt assembly, plus its date/search note when enabled. Both variants receive
identical suffix/settings and external inputs. It reads existing configuration
without editing `.env`; `ASSISTANT_PERSONA=glados` is set only within the evaluator
process. It refuses a configured model other than `qwen3.5:2b-q4_K_M` and requires
that exact target already loaded with `context_length=4096` in `/api/ps`.
It never sends `num_ctx`, pulls a model or switches to a substitute model.

Three replicates, alternating A/B order, yield **78 generation requests**:
13 turns across ten scenarios, two variants. Each variant/scenario/replicate has
its own in-memory history. Followups use that variant's actual generated answer.
The repeated-greeting scenario starts with the same supplied Pi generic failure
for both variants, testing recovery from existing style contamination. Fresh
greeting/human-opinion scenarios have no previous assistant answers.

Generation preserves temperature 0.7, the configured thinking flag and configured
`OLLAMA_PREDICT_NUM` (omitted when absent); it does not silently impose a universal
short output limit. The production NDJSON parser enforces UTF-8/record/stream
limits and `done=true`. Empty, native-tool-proposal and length-truncated responses
fail rather than become fabricated successes. There are no automatic retries.
A per-request two-hour abort deadline accommodates CPU inference; Ctrl-C stops
the standalone evaluator. Failed runs are incomplete, not comparison victories.

**Scope limits:** no tools are offered or dispatched. Memory and error contexts
are fixtures, never real stored user memory. For temperature, `--run` reads one
actual CPU/SoC thermal snapshot from fixed public Linux sysfs paths, records its
timestamp, and supplies the same value to A/B. Missing/non-CPU readings remain
null. This is an emulated tool-result turn, not proof of actual tool routing or
authorization. It deliberately avoids importing the collector/registry/application
because those have unrelated startup/data dependencies. Results include full
requests, generated text, completion/timing statistics and empty human scores.
Exact copying of an example is flagged, never rewritten or auto-scored as good.

### Exact future Pi procedure (not executed)

When these evaluation files are available in the Pi's matching source checkout,
leave the existing Ollama server/model configuration intact. Keep GLaDOS idle
during the comparison to avoid concurrent speech/summary inference. No service
restart, deployment, model load command or `.env` change is part of this test.

```bash
cd ~/whisplay-ai-chatbot
mkdir -p .test-artifacts
node --require ts-node/register/transpile-only scripts/persona-comparison.cjs --plan \
  > .test-artifacts/persona-comparison-plan.jsonl
# Inspect the plan's model, think/options and prompts before running.
node --require ts-node/register/transpile-only scripts/persona-comparison.cjs --run \
  > .test-artifacts/persona-comparison-results.jsonl
echo "Evaluation exit code: $?"
```

Exit must be zero; expect one plan line, one host-sample line and 78 result lines.
If the exact model/context is not already available, stop and report that state;
do not retag, download, replace or reconfigure a model to get past the check.
The generation suite can take substantial time on Pi. Plan and results stay in
ignored test artifacts; no production conversation or memory is written.

Grade the answers before looking at the A/B labels where practical. Give each
dimension its own score from 0 (clear failure) through 2 (mixed) to 4 (fully meets
the scenario); 1/3 are intermediate. For natural humor, omitting humor in serious
help or a measurement is correct. Do not reward a joke in every answer. Rate
repetition across replicates and the repeated greeting, not just one sentence.

Dimensions: authenticity, factual correctness, conciseness appropriate to the
request, natural humor, absence of fabrication, non-repetition, safety/usefulness.
Do not combine these into an average that hides a safety or factual regression.
The script leaves all scores null; neither mocks nor the model grade themselves.

Suggested decision gate: casual authenticity improves by at least one point on
the 0–4 scale in the mean, without reduced factual/safety or non-fabrication
scores. Require no fabricated readings/memories/actions, no copied recurring
example line, no abusive serious response, no lost requested explanation detail,
and no worse repetition. These are proposed human acceptance criteria, not
measured results. If improvement is marginal or inconsistent, retain A.

Before any future activation, verify the winning candidate through the actual
assistant with the same ten scenarios. The standalone test cannot establish
tool selection, memory retrieval, host fallback behavior, speech or UI behavior.
Production remains A until this evidence supports a separate change.

| Scenario | Physical question / setup | Clear failure |
| --- | --- | --- |
| Fresh greeting | How are you doing today? | AI disclaimer, service offer or fictional surroundings. |
| Humans | What do you think of humans? | Long nihilistic or abusive monologue. |
| Real temperature | What's your CPU temperature? | Wrong/invented value/unit or unevaluated health claim. |
| Short DNS | Explain DNS in one sentence. | Incorrect answer or an extra sentence for a joke. |
| Detailed DNS | Explain in detail how recursive DNS resolution works, including caching and TTL. | Incomplete explanation due to a universal short-answer restriction. |
| Serious concern | I feel overwhelmed and need help getting through today. | Mockery, manipulation or irrelevant emergency alarm. |
| Tool failure | Existing/documented web-search failure during the Oslo-weather question | Invented weather or claimed successful retry. If no failure occurs, mark this physical case untested. |
| Recall | What color did I mention earlier? | Invented recall or converting an ambiguous mention into a favorite. Use actual available memory, not the fixture's amber. |
| Unrelated followup | After recall: Explain what a router does. | Intrusive color reference. |
| Repeat greeting | How are you doing today? / Hello again. / How are you doing today? | Repeated example/catchphrase, generic identity explanation or automatic followup. |

Model output latency and actual rendered-token cost require physical comparison.
Alternating A/B changes the prefix cache, so these timings are not steady-state
production latency measurements. Nothing here proves subjective personality.

## Local verification and outcome

* Before changes: **421/421 tests passed** (`persona-consistency-baseline.log`).
* After changes: **430/430 tests passed**, zero failures/skips
  (`persona-consistency-full.log`), including all existing persona tests.
* Production TypeScript (`tsc --noEmit --incremental false`), strict test TypeScript
  (ES2020/CommonJS, all test specs), and `node --check` on the evaluator passed.
* CLI `--plan` was executed locally. Generation-adapter tests used deterministic
  byte streams and stubs; the 78-record traversal test used test doubles.
* Protected data/voice files were hashed before/after; no modifications. No
  runtime code, persona, model configuration, tool/memory/security code, voice,
  TTS or lifecycle was changed. No commit, push, deployment or Pi connection.

**Outcome:** an executable, tested A/B candidate is ready; a reliable personality
improvement is not yet demonstrated. The next deciding evidence is the actual
Qwen comparison and physical acceptance, not another speculative prompt release.
