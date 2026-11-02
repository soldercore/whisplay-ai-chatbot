# Memory commands: reject partial topic matches

2026-11-02. Development base: installed production commit `de8a196`.
**Candidate only; production remains unchanged on original GLaDOS A.**

## Confirmed defect and fix

The installed compiled memory module accepts half the meaningful topic words.
With only `My favorite color is amber` saved, it treats `favorite food` as a
match. This returns an unrelated fact, allows a plain unknown-food statement to
create a saved fact as an update, and deletes the saved color when asked to
forget food. Three regression tests fail on baseline and pass with the fix.

`findFacts` now requires every meaningful query word. Polite/temporal fillers
`please`, `now`, `again`, `currently`, `still` are ignored so ordinary recall
phrasing keeps working. Exact subjects, spelling normalization and broader memory
search tools are unchanged. Matching remains lexical, not a semantic guarantee;
single-word/ambiguous requests and model-based summary truthfulness retain their
existing limitations. No stored facts, summaries, file format or persona changes.

## Actual Pi host replies and persistence

An isolated `/tmp` test directory used synthetic facts and original A's existing
reply tables. It imported no LLM provider and sent no model, speech or tool
requests. These are actual host-command outputs, **not model generations**:

| Request, with only color saved | Baseline | Candidate |
| --- | --- | --- |
| Do you remember my favorite food? | Your favorite color is amber. You told me yourself. | There's nothing in your file about your favorite food. |
| Actually, my favorite food is pasta. | Saves pasta despite no existing food fact. | Returns null to normal conversation; file unchanged. |
| Forget my favorite food. | Reports food erased and deletes the color. | Reports no match; color retained, including after a fresh process. |

[Baseline results](evaluation/memory-subject-2026-11-02/baseline.json) and
[candidate results](evaluation/memory-subject-2026-11-02/candidate.json) contain
only these synthetic inputs, replies and fact states. Production memory/history
was not read or edited. There is no claim that generative Qwen conversation,
apology handling or humor has improved.

## Validation and performance scope

- 121/121 focused memory/persona/history/security tests pass; the final full run
  also includes the added polite recall and restart assertions.
- Full Windows suite: 515/519 pass. Four deployment tests need rsync, Linux paths
  or symlink privileges; all five deployment tests pass in the isolated Pi test
  directory. This is passing coverage across runs, not one clean full-suite run.
- Production/spec TypeScript checks, isolated emitted build and diff checks pass.
  Existing ASR, Piper, ordered streaming, tool permissions, interruption and
  lifecycle tests pass with simulated service/hardware boundaries.
- Diff audit found no new permission, storage-format or lifecycle changes. The
  handler is reached through the existing public LLM memory-command shortcut.
- Read-only historical Pi logs: last 20 Piper timings have median synthesis HTTP
  1180 ms, conversion 35 ms and external duration probe 36 ms (probe range 15–321).
  These are unmatched historical stages, not a controlled baseline/candidate
  comparison. `c5dfb21` remains unmerged and undeployed. No speed optimization is
  accepted here; physical speech-to-audio latency remains unmeasured.

Candidate source/compiled-file and exact production rollback archives are ready
locally in `.test-artifacts/`. Deployment needs explicit approval, baseline hash
recheck, bounded normal daemon stop/start and preservation of every data/config
path. The candidate should then be verified through the real microphone/speaker.
