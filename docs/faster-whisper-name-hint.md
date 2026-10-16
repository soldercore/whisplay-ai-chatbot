# Faster-Whisper: optional GLaDOS vocabulary hint

## Inspected behavior

The reported Pi transcript substituted `Gladdles` for `GLaDOS` before Ollama.
Neither repository HTTP wrapper originally read `initial_prompt` or `hotwords`.
The TypeScript client sent only language and either a file path or base64 audio.
Both wrappers called `WhisperModel.transcribe(audio_path, language=language,
vad_filter=True)` and joined segment text unchanged except outer whitespace.

The inspected [official Faster-Whisper implementation](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py)
supports both `initial_prompt` and `hotwords`; they are separate optional
transcription arguments. Library support did not imply HTTP wrapper support.
Requirements do not pin Faster-Whisper, and the Pi's installed version, service
interpreter and ExecStart are NOT VERIFIED.

The local-spawn client references `python/speech-service/faster-whisper-host.py`.
Docker copies its separate `docker/faster-whisper-http/faster-whisper-host.py`
to `/app/server.py`. Both must forward the parameter; only editing Docker's
copy would leave the local-spawn path unchanged. The repo does not define a
`whisplay-whisper.service` unit, so its actual script path must be checked on Pi.

## Minimal change

Opt in through the chatbot's existing `.env` configuration:

```dotenv
FASTER_WHISPER_INITIAL_PROMPT=GLaDOS
```

The client trims this value once at module initialization. Nonempty values add
`initial_prompt` to each `/recognize` JSON request, for filePath and base64 modes.
Unset or blank values omit it completely. No universal default hint or persona
change is introduced. The existing English default and language field are kept.

Both wrappers accept an optional string/null `initial_prompt`, reject other
types with HTTP 400 before model invocation, and pass it to the actual
`model.transcribe` call. Existing requests remain valid with no hint. Response
fields, VAD, model selection/size, CPU/int8 settings and temp-file cleanup remain
unchanged. HTTP `hotwords` support is not added because one hint is sufficient
for this narrowly scoped integration. No transcript normalization is implemented:
`Gladdles`, `Gladles`, corrections, quotes and later segments are not rewritten.

## Validation and limits

- Baseline: **201/201 passed**.
- Before production edits: new Node suite **8 passed / 3 failed**. It reproduced
  the omitted client field in both request modes and missing forwarding in both
  real Python route handlers. Failure log: `.test-artifacts/asr-hint-before.log`.
- After correction: **11/11 new Node tests passed**, including one subprocess
  running **7/7 Python unittest methods** with subtests for both wrappers.
- Full suite: **212/212 passed** on unchanged rerun, zero skipped/cancelled.
  The 7 Python tests run inside one of those 212 Node tests, not seven additional
  Node tests. Log: `.test-artifacts/asr-hint-full-repeat.log`.
- First full run: **211/212**, with only the previously known wall-clock
  speech-sync failure (30 vs 22). Its log is retained as `asr-hint-full.log`.
  Unchanged isolated speech suite: **11/11**. No speech assertions/code changed.
- Production TypeScript and strict TypeScript for all 13 spec files pass.
  `git diff --check` passes; existing CRLF normalization warnings may appear.

The client tests capture the real Axios call payload. Python standard-library
tests run each real `/recognize` handler, with Flask request/response objects
and WhisperModel replaced by test doubles, and inspect the actual transcription
call arguments. They cover configured/absent/invalid hints, base64 cleanup,
canonical and observed names, ordinary English, correction/quoted speech,
punctuation and multiple segments. No actual Flask HTTP server, acoustic model,
audio hardware or model download is involved. Python is an existing project
runtime; no package is installed for these tests.

This establishes integration only. Flask and Faster-Whisper are not installed
in the local test interpreter, and no suitable recording of the reported Pi
utterance was supplied. A real with/without-hint transcription comparison was
NOT performed. `initial_prompt` can bias recognition or introduce unrelated
words; the one-word hint reduces scope but does not prove absence of bias.
If microphone A/B testing shows unrelated changes, clear the setting and
restart the chatbot. Do not compensate by adding global replacement rules.

## Activation commands for a later authorized Pi session

Nothing below was executed. These changes are not committed/pushed/deployed;
first transfer the reviewed updated client and the wrapper actually used by
the Pi into their existing locations. Do not assume a git pull contains them.

Check the existing service without changing its configuration:

```bash
cd ~/whisplay-ai-chatbot
systemctl show whisplay-whisper.service -p FragmentPath -p ExecStart --no-pager
```

If ExecStart uses neither repository wrapper, stop and inspect that actual
wrapper before activation. Its HTTP contract has not been tested here. With
the same Python interpreter shown by ExecStart, check library support without
constructing a model (use the actual venv interpreter instead of `python3`
when applicable):

```bash
python3 -c 'import inspect; from faster_whisper import WhisperModel; print("initial_prompt" in inspect.signature(WhisperModel.transcribe).parameters)'
```

Proceed only if that prints True. Edit only the new setting in the existing
`.env`; retain English and all existing model/audio values:

```bash
nano .env
# Add or update exactly: FASTER_WHISPER_INITIAL_PROMPT=GLaDOS
./node_modules/.bin/tsc --incremental false
```

This compiler command updates `dist` without the build script's cleanup or
daemon-registration hook. After updated Python code is in the script location
confirmed above, for a separately managed `whisplay-whisper.service`:

```bash
sudo systemctl restart whisplay-whisper.service
whisplay service restart
systemctl is-active whisplay-whisper.service
whisplay service status
```

**Both processes need restart for first activation:** the Whisper service loads
updated Python code, and the chatbot loads the compiled client and `.env` hint.
No service-unit edit or daemon-reload is needed. The repo CLI restarts either
`chatbot.service` or the chatbot app managed by whisplay-daemon, as configured.
For a manually launched chatbot, restart that process using its existing launch
method. If the chatbot itself owns the spawned Whisper child, a chatbot restart
normally replaces both; there is no separate Whisper service to restart.
If only the hint changes later, the Python service need not restart.

Docker is a separate path: simply restarting a container still uses its existing
embedded script. For a temporary validation on the repo's existing container,
after confirming this is the active endpoint, update its runtime script and
restart it instead of the systemd Whisper service:

```bash
docker cp docker/faster-whisper-http/faster-whisper-host.py faster-whisper:/app/server.py
docker restart faster-whisper
whisplay service restart
```

That runtime copy is lost when the container is recreated; a later permanent
image update is separate deployment work. Do not download/change models here.

Finally compare the same microphone phrases with the setting blank and with
`GLaDOS`, restarting the chatbot after each change: the exact reported request,
ordinary English questions, `I meant to say gladdles, not gladles.`, quoted
speech and a later sentence beginning with the variant. Inspect ASR output
before Ollama. Accept only demonstrated improvement without unrelated changes.
Physical recognition accuracy, latency and installed Pi configuration remain
**IKKE VERIFISERT** until those tests are performed.

Changed project files: both Python wrappers, the TypeScript ASR client,
`.env.template`, `package.json` (test registration), `AGENTS.md`, this report,
`python/test/test_faster_whisper_host.py` and `src/test/faster-whisper-asr.spec.ts`.
No Agent Core, tool, reminder, memory, streaming/resource, model, voice/persona,
Piper, microphone driver, display or audio-sync code was changed.
