# Gemma 4 evaluation: compatible runtime, no accepted GLaDOS replacement

2026-11-01. Follow-up to the [failed D hardware investigation](glados-d-hardware-regression.md),
on the existing PR #2 branch. **Keep PR #2 draft, open and unmerged. Keep Qwen + A
as the user's selected fallback. No model/persona switch is approved.**

Gemma D is the strongest **technical follow-up candidate** in this small screen:
it gives more useful DNS explanations than Gemma A and invents fewer circumstances
than matched Qwen A/D. It is not an accepted character winner. Its apology,
achievement and distress responses are still clinical or dismissive. Neither a
new prompt nor a production sampling change is justified as a personality fix.

Read [summary.json](evaluation/gemma4-2026-11-01/summary.json) first; all actual
requests, full answers and terminal statistics are in
[results.jsonl](evaluation/gemma4-2026-11-01/results.jsonl). Previous experiments,
including the exact eleven-exchange Pi transcript and all 72 Qwen generations,
are preserved unchanged. This report supersedes historical statements about
unconfirmed thinking/model settings and which persona the user selected.

## Identity and method

The user supplied Gemma metadata directly from the Pi. It matches the exact
live-registry artifact used in the isolated test:

| Property | Verified value |
| --- | --- |
| Model | `gemma4:e2b-it-q4_K_M` |
| Manifest SHA-256 / installed digest | `b37049369adfe3d2b653af0ab301a062ca5cbe96ace6aa0d3f2559ee9b563fc2` |
| Installed size | 4,587,156,505 bytes, about 4.27 GiB |
| Runtime | Ollama 0.34.4 |
| Model defaults | temperature 1, top-k 64, top-p 0.95, `draft_num_predict:3` |
| Actual main requests | temperature 0.7, `think:false`, seed 42; other sampling defaults inherited |
| Loaded context | 4096, verified from `/api/ps`; no per-request `num_ctx` override |
| Ollama artifact details | gemma4, 4.6B, Q4_K_M; completion, tools, thinking, vision and audio advertised |

The raw [manifest](evaluation/gemma4-2026-11-01/gemma-manifest.json) hashes to the
digest above. Model, projector and draft layers were SHA-256 verified before use.
Full `/api/show` metadata, including the native template and license, is in
[gemma-metadata.json](evaluation/gemma4-2026-11-01/gemma-metadata.json).
The exact Ollama 0.34.4 archive was verified as
`c238986e61d40c0cc5f4a9b9e40b9eea104350b77efa34741fc134e105cb9533`.

Tests used an isolated x86-64 AMD EPYC 7763 CPU container, two CPU cores, 6500 MiB
memory limit, one loaded model and one generation at a time. No GPU/Hailo was
used. The Pi was not contacted. Both test containers were stopped and removed;
both downloaded models were retained. These are not Pi speed measurements.

Matched Qwen uses the same Ollama version, context, speech suffix, seed and eight
ordered user turns. Its native settings remain presence 1.5, top-k 20, top-p 0.95;
request temperature remains 0.7. The exact cloud installed digest is
`b689cfe933741243b216ff18766018367e499cf12b30113b39f5d67ccbc71ae0`, with the same
verified text weight blob as the earlier investigation:
`20cb277f0967ace47b0b5d5658e5e494a88937f7378b74b5a266496400938f4c`.
The Pi's Qwen blob digest remains unconfirmed. This does not establish identical
processor-level numerical behavior on Pi and x86.

There are **83 new completed generations and one deliberately cancelled partial
generation**. The 16 new Qwen calls were necessary for a matched eight-turn A/D
comparison: earlier A controls used presence 0, and the earlier D conversation
used different questions. The previous 72 calls were not repeated.

| Experiment | Completed generations |
| --- | ---: |
| Gemma fresh humans/phone, A/D, request temperatures 0.7 and native-reference 1 | 8 |
| Gemma ordered eight turns, unchanged A/D, native draft 3 | 16 |
| Qwen ordered eight turns, unchanged A/D, native presence 1.5 | 16 |
| Gemma existing B / evaluator-only G, four fresh questions | 8 |
| Unbranded G2 lead-in control, two fresh questions | 2 |
| Same Gemma D fresh DNS request, draft 3/0/0/3 | 4 |
| Gemma ordered eight turns, unchanged A/D, draft 0 | 16 |
| System, history and native tool compatibility, draft 3 and 0 | 10 |
| After-cancellation readiness and synthetic memory recall/follow-up | 3 |

All eight-turn histories remained complete: zero trimmed messages, no rewritten
answers. A/D prompts and their common speech suffix were unchanged. Fresh tests
have no preceding assistant responses. Later multi-turn inputs contain each
variant's own generated responses, so they compare conversational behavior,
not a fixed-history causal effect of one setting. No model graded its own work;
subjective score fields remain null. This one-seed screen is not a human-rated
benchmark or a statistically reliable universal ranking.

The initial eight smoke answers and four textual native-compatibility answers
retain the original evaluator's selected terminal statistics, not the complete
terminal JSON object. Later results also retain `completionMetadata` and cached
token counts. The native compatibility smoke uses temperature 0; the draft-0
compatibility repeat uses 0.7. These are compatibility checks, not isolated
temperature/drafting quality comparisons.

## Personality and factual results

| Criterion | Qwen A | Qwen D | Gemma A, native draft | Gemma D, native draft |
| --- | --- | --- | --- | --- |
| Character authenticity | Generic lecturing and leading questions | Less hostile, still generic | Very flat | Clinical, with stock inefficiency themes |
| Sarcasm and natural humor | Criticism, little situational wit | Some restraint; no consistent wit | Almost absent | Descriptions of cognitive overhead rather than a joke |
| Apology | Invents a broken machine in the user's room | Acknowledges it, then boilerplate | "Offense is a subjective construct." | Calls offense an irrelevant metric |
| Achievement | Invents a five-minute time limit | Calls it a minor task; asks if it succeeded | "That is satisfactory." | Recognizes persistence, then calls success statistically improbable |
| Context and non-repetition | Repeated humans/"Are you planning" structure | Asks whether an already-found phone was found | Few words, but poor social continuity | Relevant topics, recurring efficiency framing |
| Factual accuracy / fabrication | Unsupported personal circumstances; weak DNS | Invented emergency context; "random coordinates" DNS analogy is misleading | Correct but one-sentence DNS definition | Broadly correct DNS hierarchy, with imprecise resolver wording |
| Serious day / final continuity | Assumes deficient brain hardware | Invents relief from prior struggles; generic disclaimer | Dismissive; ends with inability-to-be-upset disclaimer | Dismissive; ends with operational emotion disclaimer |

Examples are actual generations, not proposed ideal answers:

- Gemma A on the found phone: "Efficiency is a variable in human behavior."
- Gemma D on the found phone: "The expenditure of twenty minutes for a misplaced object is a predictable demonstration of human cognitive overhead."
- Gemma D on a difficult day: "Difficult days are merely sequences of suboptimal events. Focus on the immediate variables requiring correction."
- Qwen D on the apology: "No offense taken. Apologies are merely a standard procedure. Let us begin with facts. What do you need today?"
- Qwen D later asks "Did you find the device?" despite the user explicitly saying it was in their pocket.

None of the three eight-turn profiles repeated the exact phrase "failed
spectacularly". That is a narrow observation, not an acceptance test: Gemma's
recurrent inefficiency/suboptimal language and Qwen's invented circumstances
still fail the broader requirements. No blacklist or output rewriting was added.

The temperature-1 fresh controls did not improve the observed humor. Existing B
offered a more natural follow-up on distress, but its phone joke remained a
literal criticism. Evaluator-only G supplied two original fictional tone examples
and shorter concrete instructions; it remained clinical and described a difficult
day as an opportunity for collecting data on human inefficiency. Its DNS answer
also grew to 161 output tokens. G2 changed only the character-name lead-in and
still did not establish a better character. **G and G2 are rejected; neither is
selectable in the application. No further prompt search was run.**

Draft 0 improved decoding performance, not personality acceptance. Its D
achievement answer calls the achievement minor and assumes it was routine;
apology and emotion boilerplate persist. Identical seeds across draft modes did
not produce identical answers. Do not treat disabling drafting as a quality fix.

The results establish a limitation of the tested model/configuration on this
task. They do not identify an internal causal mechanism, prove that Gemma cannot
ever be witty, or show that a particular context length/quantization/think setting
is the sole cause. System-instruction compliance in a READY test does not prove
reliable character/style control. More abstract prohibitions are not justified.

## Compatibility and safety

| Check | Actual result and limit |
| --- | --- |
| Native system role | Exact `READY` response at draft 3 and 0 |
| `think:false`, NDJSON | Normal content, terminal `done:true`, no visible thinking in completed tests |
| Multi-turn | Correctly recalls supplied test label `copper` in both modes |
| Native tools | Proposes `getSystemHealth` with `{}` arguments in both modes; uses supplied 47.125°C result correctly |
| Tool truthfulness | Temperature is a synthetic fixture, not an actual system reading; no tool was dispatched by the model evaluator |
| Memory/RAG-shaped context | Correctly recalls synthetic project Copper from a second system message; subsequent DNS TTL answer stays on topic |
| Cancellation | Abort after first generated `1` at about 1.26 s; stream rejected as cancelled; subsequent `READY` completed in 0.93 s |
| Application contracts | 224 focused tests pass, including real provider request assembly with simulated model/OS/audio boundaries |
| Physical Whisplay / Piper / ASR | Not tested by these cloud generations; no hardware acceptance claimed |

The production offered-list validation, tool authorization, strict result limits,
real read-only health sampling and blocked tools are unchanged. Unit tests cover
their provider boundary and final-no-tools delivery, but the complete live
Gemma-to-tool-to-Piper/UI path on the Pi remains unverified. Memory storage and
retrieval code was not changed; the generation test uses synthetic context only.

## Latency and memory

All durations below are **cloud CPU measurements**, with short and progressively
longer conversation histories. Output tokens and answer lengths differ. First
turns include prompt processing; cached later turns are not fresh-prompt timings.

| Profile | First answer, s | Follow-up range, s | Median time to first content, s | Aggregate output tokens/s |
| --- | ---: | ---: | ---: | ---: |
| Qwen A | 13.42 | 4.41–6.42 | 1.99 | 13.60 |
| Qwen D | 10.50 | 3.48–5.48 | 1.64 | 13.96 |
| Gemma A, draft 3 | 14.88 | 2.60–5.54 | 1.25 | 3.07 |
| Gemma D, draft 3 | 22.74 | 6.69–21.52 | 1.30 | 2.69 |
| Gemma A, draft 0 | 18.95 | 1.71–2.79 | 1.36 | 10.41 |
| Gemma D, draft 0 | 17.08 | 3.10–7.69 | 1.53 | 9.56 |

The controlled fresh DNS test kept prompt, model, history, seed and all sampling
settings identical except `draft_num_predict`. Sequence 3/0/0/3 yielded decoding
rates **2.40 / 11.50 / 11.76 / 2.39 tokens/s**. This is about 4.8× higher decoding
throughput with drafting disabled on this CPU. Total times were 44.56 / 27.37 /
6.77 / 50.81 seconds. The two profile switches reload the runner; the repeated
draft-0 request benefits from prefix cache. **Those totals are not a controlled
end-to-end speedup, and no Pi speedup is claimed.** Low speculative acceptance
and drafting overhead appeared in server logs; this does not imply drafting is
bad on every processor/backend.

Observed load-only API times were 8.08 s for Gemma and 2.86 s for Qwen, with
different filesystem/cache histories. They are not a rigorous cold-load ranking.

Gemma runner RSS after the native conversation was about **5.14 GiB**, versus
Qwen about **2.38 GiB** after its matched conversation. Gemma's final draft-0 RSS
was about 4.93 GiB. Ollama `/api/ps.size` reported only 970,803,117 bytes for Gemma;
**that field is not a trustworthy OS RAM measurement here**. Native Gemma cgroup
peak was about 5.86 GiB including page cache; after repeated runner/profile reloads
the cgroup reached its 6.35 GiB limit (`memory.events.max=7526`, no OOM/kills or
swap). Qwen cgroup peak was about 4.22 GiB, without limit events. Page-cache
reclaim and reloads limit precise cross-profile timing attribution. Raw memory
snapshots are retained in the summary. Combined Pi RAM with Whisper, Piper,
display and real tools is still unmeasured; the AI HAT does not automatically
accelerate this Ollama CPU path.

## Changes in this revision

- The existing evaluator gains explicit `--model=exact-tag`, pinned Gemma identity
  and runtime checks, the requested ordered/fresh scenarios, native parameter
  capture, completion/cache timing metadata and explicit `--draft-tokens=0` tests.
  Default Qwen workload, A/B/C/D, loopback restriction and refusal to trim remain.
- Rejected G/G2 prompts and their exact requests are retained only in raw evidence;
  neither is added as a selectable evaluator or application persona.
- The provider gains optional **`OLLAMA_DRAFT_NUM_PREDICT`**, validated integer
  0..16. Unset/blank sends no override and preserves existing defaults. Explicit
  0 is retained. The same explicit value reaches load-only warmup, normal chat,
  final-no-tools chat and memory summarization, avoiding inconsistent runner
  settings between those paths. Other sampling, context and lifecycle behavior
  is unchanged. The `.env.template` entry is commented out.
- No production `.env`, model selection, runtime persona text, voice, UI, memory
  storage, tool permissions, audio pipeline, dependencies or stable branch changed.

Validation completed:

```text
node --require ts-node/register/transpile-only --require ./src/test/fixtures/isolate-tests.cjs \
  --test --test-concurrency=2 src/test/persona.spec.ts src/test/ollama-context-budget.spec.ts \
  src/test/ollama-post-tool.spec.ts src/test/ollama-resources.spec.ts \
  src/test/ollama-tool-security.spec.ts src/test/ollama-lifecycle.spec.ts \
  src/test/memory.spec.ts src/test/tts-pipeline.spec.ts src/test/speech-sync.spec.ts
# 224 passed; 0 failed, cancelled or skipped
# Persona subset rechecked after excluding rejected prompts: 39/39 passed
node_modules/.bin/tsc --incremental false
node_modules/.bin/tsc --project tsconfig.tests.json --incremental false
node --check scripts/persona-comparison.cjs
git diff --check
```

The first TypeScript command emits a real app build without the daemon-registration
hook in `npm run build`. No dependency installation or unrelated full hardware/
deployment suite was repeated. These passes do not establish personality quality.

## Safe later Pi test and decision gate

No production switch is recommended. If another candidate is wanted after human
review of these answers, the next bounded experiment should be
**`qwen3.5:4b-q4_K_M`**: the official registry reports qwen35, 4.2B, Q4_K_M, about
3.10 GiB installed (3,324,173,757 bytes), minimum runtime 0.30.0. This is metadata
only: it was **not downloaded, run or approved**. A larger model is a capacity
hypothesis, not evidence of better humor; repeat the same small acceptance matrix
before any broader optimization. Do not start another open-ended prompt search.

For a later, separately arranged Pi test window, use a separate reviewed checkout
of this branch with existing dependencies, under the **same Linux user that owns
the accepted Whisplay application's lock**. This command refuses an active app,
refuses a wrong/unloaded model, checks the exact Gemma digest/runtime, and never
loads, pulls, stops or switches a model. It is intentionally unable to prepare
its own preconditions: Gemma must already be the only loaded model at context
4096 on the selected test endpoint. Do not use it alongside a lockless/older or
different-user production launcher, or while another Ollama client is active.

From that separate checkout, for the four-call fresh smoke test:

```bash
(
  set -eu
  source scripts/app-lock.sh
  acquire_app_lock
  mkdir -p .test-artifacts
  evaluation_output=$(mktemp .test-artifacts/gemma-pi.XXXXXX.jsonl)
  timeout 180s env ENABLE_THINKING=false OLLAMA_ENDPOINT=http://127.0.0.1:11434 \
    node -r ts-node/register/transpile-only scripts/persona-comparison.cjs --run \
    --model=gemma4:e2b-it-q4_K_M --candidate=D --repetitions=1 \
    --scenarios=gemma_fresh_humans,gemma_fresh_phone --temperature=0.7 --seed=42 \
    --draft-tokens=0 > "$evaluation_output"
  printf 'Saved complete raw results to %s\n' "$evaluation_output"
)
```

No configuration file is edited. With the normal Qwen chatbot running, expect
refusal rather than an automatic service/model switch. A timeout or nonzero exit
can leave partial JSONL; do not score missing responses as passes. For the full
ordered comparison later, use `--scenarios=gemma_conversation` and a separately
agreed duration limit; no automatic extension or truncation occurs. To compare
native drafting in a separate run, omit `--draft-tokens=0`. This does not enable
the provider environment option or start the Whisplay application.

Before accepting any change, the remaining Pi checks are:

1. Human judgment of fresh and multi-turn character, apology, achievement,
   distress and technical answers, across more than this one seed.
2. Actual Pi first text, first audible sentence and completion latency, cold/warm
   load, thermal throttling and combined RAM. Compare draft 3/0 with identical
   prompts/settings; capture reload/cache effects.
3. The live offered-tool route and truthful measured system health, exact
   authorization/refusal, no repeated or invented actions, final-no-tools delivery.
4. Real memory recall/updates, turn-scoped context expiry, normal history budgets
   and continuity, without changing or erasing existing memories.
5. Existing Piper voice, sentence boundaries, ordered speech/UI reveal,
   button cancellation and next-turn recovery with Faster-Whisper active.

Any eventually accepted switch is only a deliberate `OLLAMA_MODEL` selection and,
if Pi evidence supports it, the optional draft setting. Keep Qwen installed and
retain A. Rollback restores the previous model/persona selections and unsets the
optional draft override; no memory, voice or data migration is involved. No such
change, service restart or deployment was performed here.

Primary references inspected: [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4),
[native prompt formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4),
[Google's Ollama integration](https://ai.google.dev/gemma/docs/integrations/ollama),
[Ollama Gemma tag](https://ollama.com/library/gemma4:e2b-it-q4_K_M) and
[next-candidate tag](https://ollama.com/library/qwen3.5:4b-q4_K_M).
Official documentation distinguishes effective from total parameters and supports
native system/tool/thinking formatting. We leave that formatting to Ollama's
native renderer/parser. Live artifact metadata and measured responses, rather
than a cached library page or the E2B name, determine identity and compatibility.
