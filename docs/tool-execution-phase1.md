# Phase 1: controlled tool execution

Scope: the existing Windows project copy, existing providers and Ollama loop.
No model, persona, voice, speech sync, UI, memory format or Pi configuration change.
No new dependency, diagnostic tool, approval screen or agent platform.

Changed files: `src/config/tool-execution.ts`, `src/config/llm-tools.ts`,
`src/cloud-api/local/ollama-llm.ts`, `src/config/harness-command.ts`,
`src/config/spoken-text-guard.ts`, `src/plugin/builtin/llm-tools.ts`,
`src/type/index.ts`, `src/test/tool-execution.spec.ts`,
`src/test/ollama-tool-security.spec.ts`, `src/test/fixtures/isolate-tests.cjs`,
`src/test/web-search.spec.ts`, `package.json`, `.gitignore`, `.env.template`,
`AGENTS.md`, and this document. No production memory/audio/display module changed.

## Authority and wiring

`tool-execution.ts::executeToolCall` checks application enablement, cancellation,
reserved names, unique registration, membership of the allowed list, and JSON
arguments before invoking a handler. It returns `success`, `rejected`, `error`
or `unverified`. No coercion or argument repair is performed. Arguments are copied
before invocation; accessors, non-JSON values, dangerous object keys, excessive
depth/size and unexpected properties are rejected.

`llm-tools.ts` wraps registry functions (including plugin tools) with that same
boundary. The compatibility function map has no object prototype. Existing
non-Ollama providers use these wrappers with their full registered tool list.
Ollama additionally calls `executeLLMTool` against the exact list offered for
that model round. Native tool calls, held JSON fallback and host-routed automatic
web search all traverse the boundary. No tools are offered to the JSON fallback
when `OLLAMA_ENABLE_TOOLS=false`; native calls are denied too. Disabling Ollama
tools does not disable user-requested deterministic memory commands.

Schema support is intentionally finite: object/properties/required, array/items,
string, finite number/integer, boolean, null, enum, numeric minimum/maximum,
string and array length bounds, and boolean additionalProperties. Extra object
properties are denied by default. Empty root schemas mean an empty argument
object. An unsupported keyword (for example pattern, oneOf, $ref) rejects the
call rather than silently skipping validation. Plugins using such schemas need
an explicitly supported contract before execution; no new validator dependency
has been introduced. Plugins themselves remain fully trusted in-process code,
not sandboxed code. Registration is not approval for arbitrary future OS work.

## Shell restriction

The general shell runner, regex command filter and background command pool were
removed from `harness-command.ts`. `runCommand`, `checkCommand` and `stopCommand`
are not offered and are blocked by name even if a plugin registers them.
`HARNESS_COMMAND_ALLOW_DANGEROUS=true` and legacy `HARDNESS_*` settings cannot
restore them. Command length, pool, timeout and spill settings are retired.

Read-only `listSkills`/`readSkill` retain their existing flag gates and alias.
Skill content is reference data and grants no execution authority. No replacement
command executor or system/network diagnosis tool is implemented in this phase.

## Result truth

The executor accepts explicit `[success]`/`[response]` output only from an invoked,
registered handler. `[error]` and exceptions are execution errors; `[rejected]`
is a policy/validation denial. Empty, non-string or unmarked legacy output is
unverified; a completed Promise alone is not proof of success. Built-in volume
handlers now mark their results explicitly and declare their numeric range.
`success` describes the handler's result, not independently verified achievement
of a multi-step goal. Trusted plugins remain responsible for truthful results.

Ollama uses a host-authored completion-not-verified reply for denied calls and
non-success action results instead of another model round that could claim
success. Existing web-failure explanations retain the search response path.
An exception/cancellation after invocation never establishes that no side effect
occurred. No general semantic verifier of model prose is claimed in this phase.

## Test safety and validation

Use `npm test`. Its preload creates fresh data/temp directories inside the
project's ignored `.test-artifacts/` tree, substitutes `utils/dir` before import,
forces cleanup off, and disables loading external plugins (which could otherwise
install dependencies at import). Node subprocesses inherit the preload. Existing
memory tests operate on disposable stores; Piper/Ollama are fake loopback servers,
and playback uses the existing fake SoX. Real plugin fixtures exercise only test
handlers. No Pi connection or real model request is needed.

On Windows the voice-switch script test needs existing Bash (for example Git
Bash) on PATH. It changes only a synthetic test `.env` with `--no-restart`.
Do not install a shell or change the production environment just to run it.
Typecheck with `node node_modules/typescript/bin/tsc --noEmit --incremental false`.
There is no lint script configured in this repository; use the typecheck and
`git diff --check`, and report the lint limitation explicitly.

## Unresolved risks / later phases

- **Startup data loss resolved in phase 1.5:** `utils/dir.ts` no longer deletes
  files at startup. `CLEAN_DATA_FOLDER_ON_START=true` only logs a warning.
  Existing directory paths and creation remain unchanged; data is not reset or
  migrated. See `startup-data-cleanup-phase15-review.md` for investigation and tests.
- **NDJSON transport resolved in phase 2A:** both Ollama streaming paths now
  reconstruct complete UTF-8 NDJSON records and require an untruncated stream
  with `done=true` before completing or dispatching tools. See `ollama-stream-phase2a.md`.
- **Tool-history serialization resolved in phase 2B:** both outgoing native
  Ollama projections retain flat tool calls, named results and already-supplied
  supported IDs. Internal aggregation and authorization are unchanged. See
  `ollama-history-phase2b.md`.
- Total action/deadline
  budgets and propagation of cancellation into already-running plugin work still
  require their separately scoped phases. The executor prevents new dispatch
  after cancellation but cannot undo an action already started.
- There is no new approval policy for arbitrary system changes, no plugin
  sandbox, and no independent verification of every existing handler's effects.
- Physical Pi audio, microphone, LCD and installed model behavior cannot be
  established by Windows fixture tests. No deployment is performed here.
