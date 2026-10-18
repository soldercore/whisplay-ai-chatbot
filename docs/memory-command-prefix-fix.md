# Explicit memory-command prefix correction

## Confirmed defect and scope

The existing `parseMemoryCommand` recognized a save verb and optional `that`,
but treated `this` as statement content. `handleMemoryCommand` passed that
statement to `saveFact`, which preserved it while applying existing sentence
capitalization and punctuation. Thus `Remember this. My robot is named Max.`
saved `This. My robot is named Max.` without needing any model involvement.

The correction recognizes the full `remember this` prefix followed by a
period, comma, colon, semicolon, question/exclamation mark, or whitespace before
a new `my`/`I`/`this` clause. Recognition is anchored at the command start;
there is no global replacement. `Remember this robot is named Max` and
`Remember that this robot is named Max` retain the meaningful `this`.
Incomplete `Remember this` commands return no parsed command and save nothing,
following the existing behavior for incomplete `Remember` input. They may
still reach the normal conversational/model path.

The parser still removes terminal sentence punctuation and normalizes
whitespace as before. Storage still capitalizes the statement and adds a
terminal period. In particular, punctuation-free ASR yields the parser statement
`my robot is named Max` and stored content `My robot is named Max.`. Storage
formatting was not changed to remove this existing period.

Twelve isolated regression tests failed 8 / passed 4 before the correction and
passed 12 / failed 0 afterward. Each storage case uses a new process and an
isolated synthetic store. The cold-process tests from the previous investigation
remain in place. This change neither repairs existing records nor resolves the
earlier unexplained full-Pi-reboot recall failure.

## Read-only update analysis

Synthetic sequences were evaluated using existing save, automatic retrieval,
memory-tool search and deterministic recall code, with distinct controlled
timestamps. No update/retrieval code was changed.

| Sequence | Observed existing behavior |
| --- | --- |
| `My imaginary robot is named Copper Finch`, then `I changed my robot's name from Copper Finch to Max`, then `...from Max to Leo` | Three records remain. Both automatic context and memory-tool output contain the three names. `What is my robot's name?` returns the two rename statements, newest first. This does not demonstrate selection of an incorrect current name for the reported sequence. |
| `My robot's name is Copper Finch`, then the same structured subject with Max and Leo | One structured fact remains; deterministic recall returns Leo. Existing subject-based replacement works. |
| `My robot's name is Copper Finch`, then the two free-form rename statements | Three records remain. `What is my robot's name?` returns Copper Finch because `findFacts` returns the exact structured subject before considering the rename statements. This is a separately reproduced stale-answer limitation. |

Records have `createdAt` and `updatedAt`. Automatic fact injection sorts by
`updatedAt`, but fact text supplied to the model does not include those
timestamps. Memory-tool search ranks lexical matches, rather than establishing
which statement supersedes another. Rename sentences themselves convey some
before/after information; their coexistence is not by itself a defect.

Relevant implementation: `parseFact` in `memory-commands.ts`; `saveFact`,
`findFacts`, `factForModel`, `buildSearchMatches` and `buildMemoryPrompt` in
`local-memory.ts`. A separate authorized task could investigate narrow,
unambiguous rename handling that checks the existing subject and old value
before updating it. Simply selecting the newest matching record would not
establish semantic supersession. No such correction is included here.

## Pi backup and rollback procedure — documentation only

Do not perform these operations while the application is writing memory.
Stop the chatbot through its actual owner: `sudo systemctl stop chatbot.service`
only if that service owns this installation; otherwise stop the chatbot through
the Whisplay daemon/launcher controls and prevent it from relaunching during the
operation. Do not stop or kill external Ollama, Whisper or Piper servers.

Run as the user owning the installation. Confirm the actual memory path from
the application's `[Memory] Enabled, store:` startup line. If `MEMORY_DIR` is
overridden, substitute that directory below. Do not print the memory contents.

```bash
cd ~/whisplay-ai-chatbot
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$HOME/whisplay-memory-backups/$stamp"
mkdir -p -- "$backup_dir"
memory_file="$PWD/data/memory/memory.json" # replace with confirmed path if overridden
test -f "$memory_file" && test ! -L "$memory_file" || exit 1
backup="$backup_dir/memory.json"
cp -p -- "$memory_file" "$backup"
cmp -s -- "$memory_file" "$backup" || exit 1
sha256sum -- "$memory_file" "$backup" > "$backup_dir/checksums.txt"
sha256sum -- "$backup" > "$backup_dir/backup.sha256"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log("Backup JSON parses.");' "$backup"
git rev-parse HEAD > "$backup_dir/previous-commit.txt"
git status --short > "$backup_dir/previous-status.txt"
cp -p -- src/config/memory-commands.ts "$backup_dir/memory-commands.ts"
```

Keep the backup outside the repository. Preserve any pre-existing uncommitted
work separately before a deployment; a commit hash alone cannot restore it.
Retain this backup even if the application tests pass. No memory migration is
needed for this parser fix, and old prefixed records remain unchanged.

If a memory restore is necessary, stop the application again and verify the
backup against the previously recorded checksum before proceeding. Preserve
the current memory too, since restoring an older backup otherwise loses facts
saved since it was taken. With the confirmed paths above, as the owning user:

```bash
sha256sum --check "$backup_dir/backup.sha256" || exit 1
cmp -s -- "$backup" "$memory_file" || echo 'Current memory differs; preserve it before restoring.'
restore_stamp=$(date -u +%Y%m%dT%H%M%SZ)
test -f "$memory_file" && test ! -L "$memory_file" || exit 1
cp -p -- "$memory_file" "$backup_dir/pre-restore-$restore_stamp.json"
restore_file="$memory_file.restore-$restore_stamp"
cp -p -- "$backup" "$restore_file"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));' "$restore_file" || exit 1
cmp -s -- "$backup" "$restore_file" || exit 1
mv -- "$restore_file" "$memory_file"
cmp -s -- "$backup" "$memory_file" || exit 1
```

The final rename occurs in the memory directory on the same filesystem. Do not
delete either backup. This restore replaces the whole store; prefer application
rollback alone when there is no evidence that memory needs restoring.

For application rollback, while the chatbot remains stopped, preserve local
work and restore the recorded previous deployed revision using normal Git
checkout/switch procedures. For a verified clean checkout:

```bash
test -z "$(git status --porcelain)" || exit 1
previous_commit=$(cat "$backup_dir/previous-commit.txt")
rollback_stamp=$(date -u +%Y%m%dT%H%M%SZ)
git switch -c "rollback-memory-prefix-$rollback_stamp" "$previous_commit"
npm run build
```

If the previous application had uncommitted source, restore its saved source
instead of assuming that revision is identical. Rebuild before restarting via
the same owner, because this application runs compiled `dist/` JavaScript.
Restore does not require dependency installation or changes to `.env`.

## Physical acceptance

After an approved build/deployment, inspect recognized ASR text and use only
synthetic facts. Try `Remember this. My test robot is named Max.`, the comma
variant, and punctuation-free `Remember this my test robot is named Max`.
Verify their newly saved `userMemories[].content` has no command-prefix `This`.
Then try `Remember this. This robot is named Max.` and verify that its meaningful
`This` remains. `Remember this.` must create no standalone `This` fact; an
ordinary `This robot is named Max.` must not acquire save authorization.

Verify existing memories and ordinary conversation still work, then restart
the application and check recall. The earlier full-reboot Copper Finch failure
still requires its own complete reboot reproduction and pipeline evidence;
passing this prefix acceptance test does not resolve it. Actual ASR wording,
Piper output, Pi persistence and model responses require physical verification.
