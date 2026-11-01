"""Linux-only diagnostic ownership guardian. No service/model management.

The foreground relay owns a lifeline to a separate guardian. Closing the output,
losing SSH/the parent, or killing the relay closes that lifeline. The guardian
retains the application lock until its own subtree has been terminated/reaped.
"""
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time
import uuid


def prctl(option, value):
    if ctypes.CDLL(None, use_errno=True).prctl(option, value, 0, 0, 0) != 0:
        raise OSError("diagnostic_prctl_unavailable")


def process_info(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        parts = text[text.rfind(")") + 2:].split()
        return {"pid": pid, "parent": int(parts[1]), "birth": parts[19], "state": parts[0]}
    except (OSError, ValueError, IndexError):
        return None


def descendants(root):
    processes = {}
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            info = process_info(int(entry.name))
            if info:
                processes[info["pid"]] = info
    found = {root}
    while True:
        added = {pid for pid, info in processes.items() if info["parent"] in found} - found
        if not added:
            return [info for pid, info in processes.items() if pid in found and pid != root]
        found.update(added)


def signal_owned(root, signum):
    for old in reversed(descendants(root)):
        try:
            identity_fd = os.pidfd_open(old["pid"])
        except ProcessLookupError:
            continue
        try:
            current = process_info(old["pid"])
            if not current or current["birth"] != old["birth"] or current["state"] == "Z":
                continue
            cursor, visited = current, set()
            while cursor and cursor["pid"] != root and cursor["pid"] not in visited:
                visited.add(cursor["pid"])
                cursor = process_info(cursor["parent"])
            owned = cursor and cursor["pid"] == root
            if owned and current["birth"] == old["birth"] and current["state"] != "Z":
                # pidfd pins the validated identity even if the numeric PID is
                # reused between this check and signal delivery.
                if signum == signal.SIGTERM:
                    signal.pidfd_send_signal(identity_fd, signal.SIGCONT)
                signal.pidfd_send_signal(identity_fd, signum)
        except ProcessLookupError:
            pass
        finally:
            os.close(identity_fd)


def reap(root, exclude=None):
    for child in descendants(root):
        if child["parent"] == root and child["pid"] != exclude:
            try:
                os.waitpid(child["pid"], os.WNOHANG)
            except ChildProcessError:
                pass


def write_record(fd, record):
    data = (json.dumps(record, separators=(",", ":")) + "\n").encode()
    try:
        while data:
            data = data[os.write(fd, data):]
        return True
    except (BrokenPipeError, OSError):
        return False


NUMBERS = {"at_ms", "segment", "call", "round", "duration_ms", "chars", "code", "temperature",
           "prompt_eval_count", "prompt_eval_cached_count", "prompt_eval_duration", "eval_count",
           "eval_duration", "load_duration", "total_duration"}
STRINGS = {"origin", "outcome", "model", "build", "persona", "variant", "done_reason", "asr", "tts"}
DIAGNOSTIC_EVENTS = {"display_ready", "application_ready", "display_failure", "node_failure"}
ERRORS = {"ModuleNotFoundError", "ImportError", "FileNotFoundError", "PermissionError", "OSError",
          "RuntimeError", "ValueError", "TypeError", "AttributeError", "SyntaxError", "Exception"}


def safe_benchmark(line):
    try:
        value = json.loads(line)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("kind") not in {"benchmark_start", "generation", "benchmark_end"}:
        return None
    out = {"kind": value["kind"]}
    keys = NUMBERS | {"index", "context", "preparation_ms", "first_content_ms", "elapsed_ms", "output_chars",
                      "decode_tokens_per_second", "prompt_tokens_per_second", "cpu_busy_percent"}
    for key in keys:
        item = value.get(key)
        if key in value and (item is None or type(item) in (int, float) and 0 <= item < float("inf")):
            out[key] = item
    for key in ("mode", "version", "model", "digest", "done_reason", "request_sha256"):
        if isinstance(value.get(key), str) and re.fullmatch(r"[a-zA-Z0-9_.:/-]{1,120}", value[key]):
            out[key] = value[key]
    for key in ("thinking", "output_length_differs_over_20_percent"):
        if type(value.get(key)) is bool:
            out[key] = value[key]
    for key in ("options", "model_parameters"):
        if isinstance(value.get(key), dict):
            out[key] = {k: v for k, v in value[key].items() if k in {"temperature", "top_k", "top_p", "presence_penalty", "seed", "num_ctx", "num_predict", "draft_num_predict"} and type(v) in (int, float)}
    for key in ("before", "after"):
        if isinstance(value.get(key), dict):
            data = value[key]
            out[key] = {k: data[k] for k in ("cpu_temperature_c", "cpu_frequency_khz", "available_ram_bytes", "swap_total_bytes", "swap_free_bytes") if k in data and (data[k] is None or type(data[k]) in (int, float) or isinstance(data[k], str) and data[k].isdigit())}
            flags = data.get("throttling")
            if isinstance(flags, dict):
                out[key]["throttling"] = {period: {k: v for k, v in flags.get(period, {}).items() if k in {"undervoltage", "frequency_capped", "throttled", "soft_temperature_limit"} and type(v) is bool} for period in ("active", "historical")}
    ps = value.get("pre_request_residency")
    if isinstance(ps, dict) and isinstance(ps.get("models"), list):
        out["pre_request_residency"] = {"models": [{k: m[k] for k in ("name", "model", "digest", "context_length", "size", "size_vram") if k in m and (type(m[k]) in (int, float) or isinstance(m[k], str) and re.fullmatch(r"[a-zA-Z0-9_.:/-]{1,120}", m[k]))} for m in ps["models"] if isinstance(m, dict)]}
    return out


def safe_record(line):
    """Never relay raw stdout/stderr, exception messages, paths or source text."""
    timing = line.startswith("[AudioTiming] interaction ")
    diagnostic = line.startswith("[Diagnostics] ")
    if not timing and not diagnostic:
        try:
            value = json.loads(line)
            if value.get("kind") == "diagnostic_session" and value.get("event") == "command_failure":
                reason = value.get("reason")
                return {"kind": "diagnostic_event", "event": "node_failure", "phase": "startup",
                        "reason": reason if reason in {"not_pi", "model_residency", "runtime_version", "baseline_mismatch", "missing_build", "display_prerequisites", "required_file_missing", "remote_speech_host", "browser_audio", "command_failed"} else "command_failed"}
        except (ValueError, AttributeError):
            pass
        return None
    try:
        value = json.loads(line.split(" ", 2)[2] if timing else line[len("[Diagnostics] "):])
    except (ValueError, IndexError):
        return None
    if not isinstance(value, dict):
        return None
    if diagnostic:
        if value.get("event") not in DIAGNOSTIC_EVENTS:
            return None
        out = {"kind": "diagnostic_event", "event": value["event"], "phase": value.get("phase") if value.get("phase") in {"startup", "runtime"} else "startup"}
        if value.get("error_type") in ERRORS:
            out["error_type"] = value["error_type"]
        for key, allowed in {
            "module": {"PIL", "PIL.Image", "numpy", "cairosvg", "gpiod", "spidev", "WhisPlay", "picamera2", "cv2"},
            "frame": {"chatbot-ui.py", "utils.py", "whisplay_client.py", "whisplay.py", "fonts.py", "diagnostic_display.py"},
            "reason": {"display_not_ready", "display_spawn_failed", "startup_failed", "module_missing", "required_file_missing", "permission_denied", "port_in_use", "display_port_in_use"},
        }.items():
            if value.get(key) in allowed:
                out[key] = value[key]
        if type(value.get("line")) is int and 0 < value["line"] < 100000:
            out["line"] = value["line"]
        return out
    if not re.fullmatch(r"\d+-[a-f0-9-]{36}", str(value.get("id", ""))) or not re.fullmatch(r"[a-z_]{1,48}", str(value.get("event", ""))):
        return None
    if type(value.get("at_ms")) not in (int, float) or value["at_ms"] < 0:
        return None
    out = {"id": value["id"], "event": value["event"]}
    for key in NUMBERS:
        item = value.get(key)
        if key in value and (item is None or type(item) in (int, float) and 0 <= item < float("inf")):
            out[key] = item
    for key in STRINGS:
        if isinstance(value.get(key), str) and re.fullmatch(r"[a-zA-Z0-9_.:/-]{1,120}", value[key]):
            out[key] = value[key]
    for key in ("thinking", "custom_prompt_present"):
        if type(value.get(key)) is bool:
            out[key] = value[key]
    if re.fullmatch(r"\d{4}-\d\d-\d\dT[\d:.]+Z", str(value.get("wall_time", ""))):
        out["wall_time"] = value["wall_time"]
    return out


def guardian(command, cwd, env, control, output, session, grace, kill_wait, startup_timeout, mode):
    os.setsid()  # Ctrl+Z affects the relay, not the cleanup guardian/application.
    prctl(36, 1)  # Adopt even double-forked diagnostic descendants.
    parent = os.getpid()
    selector = selectors.DefaultSelector()
    selector.register(control, selectors.EVENT_READ, "control")
    stop_at = None
    stop_code = None
    measurements = 0
    completed = 0
    ready = set()
    begun = time.monotonic()
    app = None
    raw_buffers = {}
    output_ok = True
    failure_at = None
    expected_ready = {"application_ready", "display_ready"} if mode == "voice" else {"benchmark_start"}

    def event(name, phase, **fields):
        nonlocal output_ok, stop_at, stop_code
        output_ok = write_record(output, {"kind": "diagnostic_session", "session_id": session,
                                          "event": name, "phase": phase, **fields}) and output_ok
        if not output_ok and stop_at is None:
            stop_at, stop_code = time.monotonic(), 74

    def child_death_signal():
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTSTP, signal.SIGPIPE):
            signal.signal(signum, signal.SIG_DFL)
        prctl(1, signal.SIGKILL)  # Last resort if this guardian itself is killed.
        if os.getppid() != parent:
            os._exit(125)

    event("start", "startup")
    try:
        app = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(9,),
                               start_new_session=True, preexec_fn=child_death_signal)
        event("child_started", "startup", child_pid=app.pid)
        for stream in (app.stdout, app.stderr):
            selector.register(stream, selectors.EVENT_READ, "log")
            raw_buffers[stream.fileno()] = b""
        sent_term = sent_kill = False
        while True:
            for key, _ in selector.select(0.05):
                block = os.read(key.fd, 32768)
                if key.data == "control":
                    if stop_at is None:
                        requested = int(block.decode().strip()) if block.strip().isdigit() else signal.SIGHUP
                        stop_at, stop_code = time.monotonic(), 128 + requested
                        event("stop_requested", "cleanup", signal=requested)
                    selector.unregister(key.fileobj)
                    continue
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                pending = raw_buffers[key.fd] + block
                lines = pending.split(b"\n")
                raw_buffers[key.fd] = lines.pop()[-8192:]
                for line in lines:
                    record = safe_record(line.decode("utf8", "replace"))
                    if not record and mode == "benchmark":
                        record = safe_benchmark(line.decode("utf8", "replace"))
                    if not record:
                        continue
                    if "id" in record or record.get("kind") == "generation":
                        measurements += 1
                        if record.get("event") == "interaction_end" and record.get("outcome") == "completed":
                            completed += 1
                    elif record.get("kind") == "benchmark_start":
                        ready.add("benchmark_start")
                    elif record.get("kind") == "diagnostic_event":
                        record["session_id"] = session
                        ready.add(record["event"])
                        if record["event"].endswith("failure") and failure_at is None:
                            running = expected_ready.issubset(ready)
                            event("runtime_failure" if running else "startup_failure", "runtime" if running else "startup", reason=record["event"])
                            failure_at = time.monotonic()
                    if not write_record(output, record) and stop_at is None:
                        stop_at, stop_code = time.monotonic(), 74
            returncode = app.poll()
            if returncode is not None and stop_at is None:
                stop_at = time.monotonic()
                stop_code = returncode if returncode >= 0 else 128 - returncode
                if not expected_ready.issubset(ready):
                    event("startup_failure", "startup", reason="application_exited_before_ready")
                    if stop_code == 0:
                        stop_code = 65
                elif stop_code:
                    event("runtime_failure", "runtime", reason="application_exit_nonzero")
            if stop_at is None and not expected_ready.issubset(ready) and time.monotonic() - begun >= startup_timeout:
                event("startup_failure", "startup", reason="startup_timeout")
                stop_at, stop_code = time.monotonic(), 124
            if stop_at is None and failure_at is not None and time.monotonic() - failure_at >= grace + kill_wait:
                stop_at, stop_code = time.monotonic(), 1
            if stop_at is not None:
                if not sent_term:
                    signal_owned(os.getpid(), signal.SIGTERM)
                    sent_term = True
                    event("cleanup_start", "cleanup")
                app.poll()
                reap(os.getpid(), app.pid)
                live = [p for p in descendants(os.getpid()) if p["state"] != "Z"]
                if not live:
                    app.poll()
                    if any(k.data == "log" for k in selector.get_map().values()) and time.monotonic() - stop_at < kill_wait:
                        continue
                    event("cleanup_verified", "cleanup", remaining=0)
                    if (not measurements or mode == "voice" and not completed) and stop_code == 0:
                        event("collection_failure", "collection", reason="no_interaction_events")
                        stop_code = 65
                    event("end", "cleanup", exit_code=stop_code, app_exit_code=app.returncode,
                          measurement_events=measurements, cleanup_verified=True)
                    return stop_code
                elapsed = time.monotonic() - stop_at
                if elapsed >= grace and not sent_kill:
                    signal_owned(os.getpid(), signal.SIGKILL)
                    sent_kill = True
                    event("escalation", "cleanup", signal=signal.SIGKILL)
                if elapsed >= grace + kill_wait:
                    event("cleanup_failure", "cleanup", reason="owned_exit_unverified", remaining=len(live))
                    return 70
    except BaseException:
        event("startup_failure", "startup", reason="supervisor_error")
        signal_owned(os.getpid(), signal.SIGKILL)
        end = time.monotonic() + kill_wait
        while time.monotonic() < end and any(p["state"] != "Z" for p in descendants(os.getpid())):
            if app:
                app.poll()
            reap(os.getpid(), app.pid if app else None)
            time.sleep(0.02)
        return 70
    finally:
        selector.close()


def supervise(command, cwd, env, grace=3.0, kill_wait=2.0, startup_timeout=90.0, mode="voice"):
    """Internal API accepts fixture commands for tests; CLI fixes the app command."""
    prctl(36, 1)
    session = str(uuid.uuid4())
    control_read, control_write = os.pipe()
    result_read, result_write = os.pipe()
    requested = [None]

    def stop(signum, _frame):
        requested[0] = requested[0] or signum

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTSTP, signal.SIGPIPE):
        signal.signal(signum, stop)
    original_parent = os.getppid()
    prctl(1, signal.SIGTERM)
    if os.getppid() != original_parent:
        requested[0] = signal.SIGHUP
    guard = os.fork()
    if guard == 0:
        os.close(control_write)
        os.close(result_read)
        # Signal delivery is handled by lifeline EOF; reset relay handlers.
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTSTP, signal.SIGPIPE):
            signal.signal(signum, signal.SIG_IGN)
        code = guardian(command, cwd, env, control_read, result_write, session, grace, kill_wait, startup_timeout, mode)
        os._exit(code)
    os.close(control_read)
    os.close(result_write)
    os.set_blocking(result_read, False)
    sent_stop = False
    status = None
    pending_output = b""
    # Reopen independent file descriptions: never change the shell/TTY's flags.
    relay_out = os.open("/proc/self/fd/1", os.O_WRONLY | os.O_NONBLOCK | os.O_APPEND | os.O_CLOEXEC)
    relay_error = os.open("/proc/self/fd/2", os.O_WRONLY | os.O_NONBLOCK | os.O_APPEND | os.O_CLOEXEC)
    relay_stop_at = None
    forced = False
    error_lines = b""
    while status is None:
        if requested[0] and not sent_stop:
            try:
                os.write(control_write, str(requested[0]).encode())
            except BrokenPipeError:
                pass
            sent_stop = True
            relay_stop_at = time.monotonic()
        if relay_stop_at is not None and not forced and time.monotonic() - relay_stop_at > grace + kill_wait + 1:
            signal_owned(os.getpid(), signal.SIGKILL)
            forced = True
        try:
            block = os.read(result_read, 32768)
            if block:
                # Only already-sanitized guardian records reach this pipe.
                error_lines += block
                ready_lines = error_lines.split(b"\n")
                error_lines = ready_lines.pop()[-8192:]
                for line in ready_lines:
                    try:
                        record = json.loads(line)
                        if record.get("event", "").endswith("failure"):
                            write_record(relay_error, record)
                    except ValueError:
                        pass
                pending_output += block
                if len(pending_output) > 262144:
                    requested[0] = signal.SIGPIPE
                    pending_output = b""
                    write_record(relay_error, {"kind": "diagnostic_session", "session_id": session,
                                     "event": "collection_failure", "phase": "collection", "reason": "output_backpressure"})
        except BlockingIOError:
            pass
        if pending_output:
            try:
                pending_output = pending_output[os.write(relay_out, pending_output):]
            except BlockingIOError:
                pass
            except (BrokenPipeError, OSError):
                requested[0] = signal.SIGPIPE
                pending_output = b""
                write_record(relay_error, {"kind": "diagnostic_session", "session_id": session,
                                 "event": "collection_failure", "phase": "collection", "reason": "output_closed"})
        waited, value = os.waitpid(guard, os.WNOHANG)
        if waited:
            status = value
        else:
            time.sleep(0.02)
    os.close(control_write)
    # Drain remaining sanitized records after the guardian exits.
    while True:
        try:
            block = os.read(result_read, 32768)
            if not block:
                break
            pending_output += block
        except BlockingIOError:
            break
    flush_deadline = time.monotonic() + 0.5
    while pending_output and time.monotonic() < flush_deadline:
        try:
            pending_output = pending_output[os.write(relay_out, pending_output):]
        except BlockingIOError:
            time.sleep(0.02)
        except (BrokenPipeError, OSError):
            break
    # An unexpectedly killed guardian reparents descendants here. Never abandon them.
    deadline = time.monotonic() + grace + kill_wait
    while any(p["state"] != "Z" for p in descendants(os.getpid())) and time.monotonic() < deadline:
        signal_owned(os.getpid(), signal.SIGKILL)
        reap(os.getpid())
        time.sleep(0.02)
    reap(os.getpid())
    code = os.waitstatus_to_exitcode(status)
    if code < 0 or code == 70:
        live = [p for p in descendants(os.getpid()) if p["state"] != "Z"]
        write_record(relay_out, {"kind": "diagnostic_session", "session_id": session, "event": "cleanup_failure", "phase": "cleanup", "reason": "guardian_terminated"})
        write_record(relay_out, {"kind": "diagnostic_session", "session_id": session, "event": "cleanup_verified" if not live else "cleanup_failure",
                         "phase": "cleanup", "remaining": len(live), "reason": "guardian_terminated"})
        write_record(relay_out, {"kind": "diagnostic_session", "session_id": session, "event": "end", "phase": "cleanup",
                                "exit_code": code if code >= 0 else 128 - code, "cleanup_verified": not live})
        if live:
            return 70
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    try:
        root = Path(__file__).resolve().parent.parent
        runtime = os.environ.get("WHISPLAY_DIAGNOSTIC_RUNTIME_DIR", "")
        mode = "benchmark" if sys.argv[1:2] == ["benchmark"] else "voice"
        if mode == "voice" and (not Path(runtime).is_absolute() or not Path(runtime).is_dir()):
            raise RuntimeError("runtime_directory_missing")
        import fcntl
        lock = Path(f"/tmp/whisplay-chatbot-{os.getuid()}/application.lock")
        actual, inherited = lock.lstat(), os.fstat(9)
        if lock.is_symlink() or actual.st_uid != os.getuid() or (actual.st_dev, actual.st_ino) != (inherited.st_dev, inherited.st_ino):
            raise RuntimeError("lock_unverified")
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
        command = ["node", str(root / "dist/index.js")]
        if mode == "benchmark":
            if sys.argv[2:] not in [[v, "--confirm-idle"] for v in ("identical", "incremental", "cold")]:
                raise RuntimeError("invalid_benchmark")
            command = ["node", "-r", "ts-node/register/transpile-only", str(root / "scripts/pi-latency.cjs"), "benchmark", *sys.argv[2:]]
        sys.exit(supervise(command, runtime if mode == "voice" else root, os.environ.copy(), mode=mode))
    except SystemExit:
        raise
    except BaseException:
        write_record(1, {"kind": "diagnostic_session", "event": "startup_failure", "phase": "startup", "reason": "supervisor_prerequisites", "exit_code": 70})
        sys.exit(70)
