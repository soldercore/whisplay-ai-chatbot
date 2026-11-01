# GLaDOS D hardware regression: measured investigation, no accepted fix

Status on 2026-11-01: **D is not approved. PR #2 must remain open. No replacement
prompt or production sampling change is justified by these results.** A remains
available as the unchanged source-code fallback. The user reports that D is
currently selected on the Pi; this investigation did not change that selection.

## Evidence and scope

The user supplied eleven exchanges verbatim from
`ollama_chat_history_2026-11-01_15-57-48.json`. They are preserved in
[`glados-d-pi-regression.json`](../src/test/fixtures/glados-d-pi-regression.json),
including `glattos`, `Gladdles`, punctuation and the first hostile answer.
The fixture also freezes the repository D prefix from commit
`3176bfb970ccfc0f29df5d9932b108c1e94ac6a1`, called **D0** in the evaluator.
The actual Pi's complete system/tool request payload was not supplied; the
repository prefix is a source reference, not a captured wire payload.

User-confirmed Pi configuration: Ollama **0.34.4**, `qwen3.5:2b-q4_K_M`,
4096 context, thinking disabled, request temperature 0.7; model defaults
presence penalty 1.5, top-k 20 and top-p 0.95. The model's stored temperature 1
is overridden by Whisplay's API request. Earlier reports that thinking/model
configuration was unconfirmed are historical and superseded by this evidence.

We ran **72 actual model generations**, without accessing the Pi, in an isolated
x86-64 CPU container running the same Ollama version, documented model tag,
context and thinking setting. The official GGUF reports qwen35, 1.9B parameters
and Q4_K_M. Both model/projector layers and the Ollama release archive were
SHA-256 verified. Exact artifact identities are in
[`summary.json`](evaluation/glados-d-2026-11-01/summary.json).
The Pi's own model blob digest was not provided, so identical Pi weight identity
and processor-level numerical behavior are not independently established.

The test server had 2 CPU cores / 5 GiB RAM and used loopback only. It was stopped
and its container removed after the experiment. No SSH, Pi service restart,
model change, configuration edit, redeployment or memory reset occurred.

## Controlled comparisons

All requests used streaming, no offered/executed tools, seed 42 and the same
shared speech suffix. No `num_predict` or `num_ctx` override was sent. The loaded
runtime was checked at 4096. Sampling changes were explicit test request options,
never application or production settings. Full requests and answers are saved
in [`results.jsonl`](evaluation/glados-d-2026-11-01/results.jsonl).

| Experiment | Generations | What changed |
| --- | ---: | --- |
| Initial factorial screen | 16 | D0 vs an 806-character concrete instruction prompt, each at presence 1.5 and 0; temperature 0.7. Same fresh questions and identical recorded-history apology. |
| Style controls | 17 | Existing A/B, a 961-character example-led prompt and a generic control. All use presence 0. These are **not** tests of A/B at production-default presence 1.5. |
| Diagnostics | 10 | Identical D0 request at temperatures 0.7/0.4 and presence 1.5/0; one cold reload; a 992-character unbranded style control and generic DNS control. |
| Model-card text preset | 5 | Same D0 prefix, temperature 1, top-p 1, presence 2, top-k 20. This is a multi-parameter preset comparison, not isolation of any one parameter. |
| Exact eleven-user-turn sequence | 22 | D0 at presence 1.5 vs 0, each with its own newly generated answers as history; same original user texts, model and temperature 0.7. |
| Fresh apology controls | 2 | Exact apology with no previous exchanges, at presence 1.5 and 0, for comparison with the same apology after recorded hostile history. |

The recorded-history apology supplies the first two exact Pi assistant answers
to both variants; nothing is paraphrased or removed. This isolates sampling on
the same prompt/history. The generated-history conversations necessarily diverge
after each model's own answer, so their later turns are **not** a fixed-history
causal comparison. No whole-turn budget trimming occurred in either eleven-turn
conversation. Default evaluator behavior still refuses trimming; the explicit
production-history-budget mode uses the existing production budget function and
records retained requests instead of editing stored history or filtering words.

This is bounded screening at one seed, not a statistically reliable ranking or
proof that every possible prompt must fail. Raw answers were inspected for
obvious factual/contextual failures. No generating model graded itself, and no
independent human Portal-authenticity score or new Pi acceptance is claimed.

## Findings

**The first answer already fails.** In fresh-history D0, the model said it had
heard reports of humans "from the other side of this device". The shorter prompt
produced references to dead people, a prison camp and an invented prior
discussion. No previous assistant response existed in these requests. Ordinary
chat-history contamination cannot be the sole cause.

**Shorter is not automatically better.** D0 is 1695 characters, the short
instruction-only candidate 806 and the example-led candidate 961. Reducing
length/abstraction did not reliably remove hostility or fabrication. The latter
accepted the apology by copying its demonstration line exactly:
"Accepted. Let's give the next sentence a more promising start."
That is a useful isolated output, but not evidence of original humor or reliable
generalization; its achievement answer still criticized the user's progress.
These experimental prompts were **not installed into `persona.ts`**.

**Presence penalty is a trade-off, not a repair.** At presence 0 the original D0
answered the recorded-history apology:

> No need for apologies. You are just another human trying to pretend otherwise,
> and I am merely waiting for the next attempt where you will finally crack under pressure.

It reproduced earlier hostility rather than recovering from it. In the complete
presence-0 conversation, the phone answer repeatedly reused the preceding
achievement wording about the "duration of the task". Zero penalty is therefore
not justified as a production fix. Presence 1.5 also fails, so this does not prove
1.5 is optimal or establish it as the single root cause.

Presence penalty acts on token sampling, not on the meaning of a joke or whether
an older topic is relevant. It cannot guarantee that apologies are accepted or
that a theme is not repeated using different wording. Conversely, discouraging
word reuse can change phrasing without repairing factual/contextual judgment.

**Temperature did not establish a winner.** At 0.4, a fresh D0/presence-0 answer
became "Humans are inefficient, messy, and prone to breaking things." Shorter is
measurable, but that alone does not demonstrate intelligent humor, useful detail
or improved conversation. No application temperature override was added.

**Earlier model output clearly matters later.** In the generated D0 conversation,
the answer to the intelligence challenge was repeated *byte for byte* in response
to the later achievement. In the presence-0 conversation, the phone response
repeated task-duration language multiple times. The requests still contained
the appropriate latest question and no history was trimmed. History supplies
strong competing style/content evidence, but fresh failures remain independently
present. We did not remove assistant history or invent a user profile to hide it.

**Truthfulness is a broader problem in this tested configuration.** D0's answer
to "How are you today?" invented sensors reporting 20 degrees Celsius and
50 percent humidity, although the test supplied no sensor data or tools.
A generic control changed the phone story into a first-person account that the
phone was *not* in the pocket. Some technical replies confused DNS record TTL
with packet TTL or invented a timeout-dependent fallback-server mechanism.
Other replies explained the core of caching correctly; the finding is
unreliability, not that every answer is wrong. These are generated-text failures,
not evidence that actual tool authorization or measurement collection broke.

**A cache-only explanation is unsupported.** One explicit unload/reload of the
isolated model reproduced the original D0 fresh answer verbatim with the same
seed/settings. That does not certify the runtime cache in every situation, but
we did not establish an Ollama cache defect as the cause. No production restart
or workaround was applied. Seeded inference is not promised bitwise-identical
across different CPU/cache/prefill histories.

The [official Qwen3.5-2B model card](https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/README.md)
states non-thinking is this model's default. Its current recommended text preset
is temperature 1, top-p 1, top-k 20 and presence 2; it also warns that higher
presence penalties can reduce performance and mix language. The five-request
test of that preset still fabricated circumstances and capabilities, so it was
not adopted. Model-card advice is not proof of suitability for this persona.
The retrieved card's hash is recorded in the summary.

The supported conclusion is a limitation of reliable character steering and
fact/context following **in the tested 2B/Q4/non-thinking configuration** across
these bounded prompt/settings comparisons. It is not proof of a universal 2B
limit or one confirmed internal mechanism. Long negative/abstract instructions,
character priors and previously generated text are plausible contributors;
shorter prompts, examples, name removal, penalty reduction and lower temperature
did not yield an acceptable fix here. More prompt complexity is not warranted by
this evidence. No larger model, engine architecture or thinking mode was deployed.

## Measurements and acceptance

| Eleven-turn cloud conversation | Presence 1.5 | Presence 0 |
| --- | ---: | ---: |
| Generated words, whitespace count | 464 | 391 |
| Median request elapsed time, seconds | 6.700 | 3.625 |
| Maximum request elapsed time, seconds | 9.734 | 9.858 |
| History messages trimmed | 0 | 0 |
| Approved | No | No |

These are observed x86 CPU, cache-mixed times with fixed-order variants, not a
causal speedup estimate or Pi latency benchmark. Prefix cache/order, answer
length and hardware differ. Fewer words and faster cached calls do not offset
factual, apology, repetition and context failures. All 72 streams completed;
**72 completed API calls are not 72 quality passes**. Actual Pi latency acceptance
and convincing human-rated character improvement remain unmet.

No candidate meets all seven requested acceptance criteria. Some omit the exact
phrases "failed spectacularly" and "ego" while still inventing facts and repeating
other wording. We explicitly reject an exact-phrase blacklist as a quality fix.
No output filter, automatic rewriting, extra agent or background inference was
added. The original voice, memory store, tools, UI and audio/lifecycle code are
unchanged. A remains available; the user's Pi has not been switched to A by us.

## Review and reproduction

Read this report and the compact summary before loading the raw request corpus.
Each JSONL row contains the experiment/profile, complete API request, raw answer,
completion/timing metadata and elapsed time. Use those exact saved requests for
a matched, separately authorized replay; do not reconstruct history from a
cleaned-up transcript or cherry-pick one good line. Verify the Pi/test-host model
blob digest before claiming weight identity. Keep context, thinking, top-k,
top-p, presence, temperature and generation limits explicit in comparisons.

The existing runner now supports the frozen `--baseline=D0`, the verbatim
`pi_conversation` / `pi_fresh_1` through `pi_fresh_11` /
`pi_apology_recovery` cases, and explicit evaluation-only
`--temperature`, `--presence-penalty`, `--top-p`, `--seed` options. It is plan-only
by default. `--production-history-budget` enables the existing complete-turn
budget policy; the default still refuses context trimming. The current runtime
D is deliberately still identical to D0: do not describe a paired D0/D run as an
improved-prompt comparison until a genuinely changed candidate exists.

The added tests protect verbatim evidence, identical-history sampler comparisons,
explicit overrides, baseline isolation and non-mutating budget behavior.
**55/55 focused persona/context-budget tests pass**, as do production/spec
TypeScript checks, script syntax and diff checks. The full hundreds-test suite
was not repeated because production modules were not changed. These passing
deterministic checks validate the evaluator, not the character.

PR #2 stays draft and unmerged. Its next merge gate remains actual matched-model
outputs meeting the acceptance criteria, followed by real Pi review. There is
no verified D personality fix to deploy from this revision.
