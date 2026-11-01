# Diagnostic reliability follow-up

2026-11-01, existing draft PR #3 / `diagnostics/voice-latency`.
This supersedes the original unsupervised capture instructions. It is a reliability
fix, not a model/personality change or a latency optimization.

## Evidence and access limits

The user reports that the original registered chatbot was restored successfully
after a diagnostic child retained the application lock. That recovery is user
evidence, not a fresh verification by this task.

The current executor is Linux in Codex Cloud, not the user's Windows SSH client.
Its policy reports no VPN, private TCP grants or SSH identity. A bounded normal
SSH attempt failed locally on permissions for the system SSH include; ignoring
that unrelated local include while retaining strict host-key verification reached
hostname resolution and failed to resolve the supplied `.local` Pi hostname.
Authentication and the Pi were never reached. No host-key checking was disabled,
credentials requested/read, public SSH exposed, or network policy bypass attempted.

**No Pi files/services/configuration were changed. Production health, diagnostic
startup on Pi and actual latency remain unverified. No interruption approval was
requested because the required preceding read-only Pi checks could not be done.**
The remaining hardware phase requires an executor with the user's existing local
SSH access (or a separately configured permitted private connection). It must
first verify health/build/preflight, then request the explicit short interruption.

## Confirmed repository defects and corrections

| Failure | Confirmed code evidence | Correction / remaining uncertainty |
| --- | --- | --- |
| Display resources | Base font and emoji lookup depended on the review Python directory; ignored runtime assets were not shared by Git worktree creation | Resolve checked-in resources first, then existing production Python resources via the explicitly supplied diagnostic runtime directory. Configured absolute fonts remain authoritative. No downloads or resource copying. |
| Unnecessary hardware imports | `whisplay_client.py` imported `spidev`/`gpiod` before testing the daemon connection | Lazy-import the direct driver only when actually using it. Daemon-mode test succeeds without those imports. Diagnostic mode reuses existing registration, never calls `app.register`, and refuses fallback when an expected daemon socket is unavailable. |
| Python shutdown | Signal registration followed the blocking socket server and included uncatchable SIGKILL/SIGSTOP | Install catchable handlers before initialization; use `finally` for render/board cleanup. Diagnostic daemon RPCs have a 2-second bound. |
| Orphan ownership | The previous wrapper waited on a foreground Node child without lifetime supervision; both inherited the lock | Bash now execs a relay/guardian supervisor. It owns the real app subtree and retains FD 9 until termination/reaping. Ctrl+Z requests shutdown instead of suspending the relay. |
| Hidden startup failures | The old pipe discarded all non-interaction lines, including the Python traceback | Python emits selected exception type, known module and repository frame/line; Node emits selected startup reason codes. Supervisor forwards structured safe failures to the capture and terminal. Raw messages/source/paths are discarded. |
| False report success | Empty input produced JSON `[]` and exit 0 | Report schema now includes status, sessions and interactions; empty/incomplete input fails. Collector preserves session exit status. |
| Insufficient preflight | Model/backend checks did not validate actual display dependencies/resources or freshness of compiled diagnostic modules | Read-only check validates imports, fonts, emoji directory, required Python/UI sources, Python/pidfd support and emitted build markers/hashes. It runs while production holds the application lock. |

The **actual Pi traceback** and the reason its orphan ignored SIGTERM were not
available remotely. Missing assets, eager driver imports and late handlers are
independently demonstrated defects, not proof that each caused the reported Pi
exception. New failure metadata is designed to establish the actual cause during
the next authorized run. A successful preflight explicitly says
`hardware_initialized:false` and `hardware_startup_guaranteed:false`.

`emoji_svg.zip` is optional installation material; the runtime SVG directory and
valid base font are checked. Terminal mode also checks its packaged fonts/files.
Preflight imports image libraries and, only for direct-driver mode, driver modules;
it never instantiates a board, opens GPIO/SPI/camera/audio, requests foreground
focus, registers an app, or generates model/speech output.

## Process ownership and bounds

[`diagnostic-session.py`](../scripts/diagnostic-session.py) uses only Python's
standard library and Linux APIs already available on current Pi OS:

- The foreground relay has a lifeline to an independent guardian. EOF after relay
  death or SSH/pipe closure requests cleanup. Linux parent-death notification also
  handles loss of the relay's parent.
- Both are child subreapers. Even double-forked/escaped diagnostic descendants can
  be adopted and reaped; cleanup does not depend on a shell job table or port owner.
- Node is started in its own session with the existing lock FD. If the guardian
  itself dies, Node has a last-resort parent-death signal and the relay adopts and
  cleans remaining descendants.
- SIGINT, SIGTERM, SIGHUP and SIGTSTP request bounded shutdown. Stopped owned tasks
  are continued before TERM. Normal grace is 3 seconds, followed by KILL and up to
  2 seconds of exit verification. A stalled/killed guardian has an additional
  bounded relay recovery path (up to approximately 11 seconds in that case).
- Signals are sent only after checking actual ancestry and birth identity, using
  **pidfds** so numeric PID reuse cannot redirect delivery. No `killall`, process
  patterns, port-owner kills or arbitrary caller-supplied target PIDs are used.
- Existing external Whisper/Piper/Ollama processes are outside this owned tree and
  are not stopped. No original app/service is automatically started or stopped.
- The original lock inode is never deleted. Supported cleanup verifies zero live
  owned descendants and reaps children before the normal lock release.

Output is drained without blocking cleanup on a slow/stopped receiver. Only
bounded, sanitized records enter the relay buffer. Separate file descriptions
avoid changing the calling shell/TTY's blocking flags. A broken/full destination
is a collection failure, not a successful empty capture.

SIGKILL is an emergency owned-process escalation, not the primary shutdown path.
As with other user-space supervisors, simultaneous uncatchable termination of all
supervisors or a kernel task that cannot exit even after SIGKILL cannot be promised
recoverable. Unverified cleanup is a failure; do not start production into that
state. No report claims such exceptional kernel behavior was tested on the Pi.

## Capture, errors and return codes

Supported voice capture is now **direct redirection**, without a second filter
process hiding startup errors:

```bash
WHISPLAY_DIAGNOSTIC_RUNTIME_DIR="$ACTIVE" \
  bash scripts/pi-latency.sh voice --confirm-idle > .test-artifacts/latency/voice.jsonl
```

This remains an explicit hardware launch **only after approval and controlled exit
of production**. Read-only `check` needs no production interruption. Structured
startup/runtime/collection/cleanup failures remain visible on stderr as well as
in available capture output. No raw conversation, traceback message, secrets,
private configuration, recordings, memory content or response text is captured.
Native parameter reporting is restricted to selected numeric parameters.

Session footers distinguish the actual application return code from the diagnostic
exit status. A natural Node exit 17 remains 17 through capture/collection/reporting;
operator SIGINT normally returns 130 even after valid measurements and successful
cleanup. Do not turn that return value into a successful empty session. Completed
turn measurements and termination status are separate report fields. A report may
contain useful completed turns while still recording an interrupted/failed session.

Before restoring the original registered app:

```bash
bash scripts/pi-latency.sh verify-cleanup .test-artifacts/latency/voice.jsonl
```

This requires a matching final session footer and verified zero remaining children,
then probes the actual existing per-user kernel lock. It does **not** start a
service. Missing evidence or a busy lock fails closed. After it succeeds, the
already authorized restoration can use the original `whisplay service start` and
status/real hardware checks. A diagnostic failure can still have verified cleanup;
restoring production takes priority over obtaining measurements.

## Validation and remaining gates

Exact final results are in
[`validation-reliability.json`](evaluation/voice-latency-2026-11-01/validation-reliability.json).
The full canonical Node suite is run serially, including real-rsync preservation
tests. Python contracts, real Linux supervisor/lock/signal tests, TypeScript builds
and UI self-tests are separate checks. Test-only CairoSVG was installed in an
isolated temporary environment; it is an existing project dependency, not a new
runtime dependency or a Pi installation.

Process tests use real Node/Python children and Linux locks/pidfds, including
signals, parent/guardian death, ignored TERM, stopped guardian, pipeline closure,
receiver backpressure, original exit codes, PID reuse rejection, unrelated child
survival and verified lock release. Hardware/service/model edges are fixtures;
these results do not establish actual GPIO/LCD/audio compatibility.

No fresh latency measurements exist. Next steps on an accessible Pi are read-only
verification of original app health/build/config and the review preflight; explicit
approval; three real voice interactions; supervised stop; verified cleanup; original
registered app restoration and confirmation of `running=true`, focus and hardware.
PR #2, stable branches, production data and current model settings remain unchanged.
