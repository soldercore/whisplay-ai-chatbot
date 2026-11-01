"""Real Linux processes, no hardware, services, models or production locks."""
import ast
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
import diagnostic_display
import runtime_resources

spec = importlib.util.spec_from_file_location("diagnostic_session", ROOT / "scripts/diagnostic-session.py")
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)

READY = '''import json,os,signal,sys,time,uuid
print('[Diagnostics] '+json.dumps({'event':'application_ready','phase':'startup'}),flush=True)
print('[Diagnostics] '+json.dumps({'event':'display_ready','phase':'startup'}),flush=True)
identity=str(os.getpid())+'-'+str(uuid.uuid4())
for event in ('interaction_start','interaction_end'):
 print('[AudioTiming] interaction '+json.dumps({'id':identity,'event':event,'at_ms':1,'outcome':'completed'}),flush=True)
'''


class Resources(unittest.TestCase):
    def test_runtime_fallback_and_custom_font_without_cwd_dependence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "python").mkdir()
            (root / "python/NotoSansSC-Bold.ttf").touch()
            with mock.patch.dict(os.environ, {"WHISPLAY_LATENCY_DIAGNOSTICS": "true", "WHISPLAY_DIAGNOSTIC_RUNTIME_DIR": temp}, clear=True), \
                 mock.patch.object(runtime_resources, "PYTHON_ROOT", root / "isolated-review-python"):
                self.assertEqual(runtime_resources.font_path(), root / "python/NotoSansSC-Bold.ttf")
                os.environ["CUSTOM_FONT_PATH"] = str(root / "other.ttf")
                self.assertEqual(runtime_resources.font_path(), root / "other.ttf")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(runtime_resources.resource_path("missing"), ROOT / "python/missing")

    def test_preflight_detects_missing_import_and_font_without_hardware(self):
        actual_import = diagnostic_display.importlib.import_module
        def probe(name):
            self.assertNotIn(name, {"whisplay", "WhisPlay", "camera"})
            if name == "cairosvg":
                raise ModuleNotFoundError("PRIVATE VALUE")
            return actual_import(name)
        with mock.patch.object(diagnostic_display.importlib, "import_module", side_effect=probe), \
             mock.patch.object(diagnostic_display, "font_path", return_value=Path("/not-present/font.ttf")):
            result = diagnostic_display.preflight()
        self.assertFalse(result["ok"])
        self.assertFalse(result["hardware_initialized"])
        self.assertFalse(result["hardware_startup_guaranteed"])
        self.assertTrue(any(x["resource"] == "base_font" and not x["ok"] for x in result["checks"]))
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_python_failure_retains_type_not_message_or_private_path(self):
        try:
            raise ModuleNotFoundError("password=PRIVATE", name="cairosvg")
        except Exception as error:
            result = diagnostic_display.failure(error)
        self.assertEqual(result["error_type"], "ModuleNotFoundError")
        self.assertEqual(result["module"], "cairosvg")
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_failed_render_thread_requests_main_thread_cleanup_without_raw_traceback(self):
        with mock.patch.object(diagnostic_display.os, "kill") as kill, \
             mock.patch("sys.stderr") as output:
            diagnostic_display.thread_failure(mock.Mock(exc_value=RuntimeError("PRIVATE")))
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)
        messages = "".join(str(c.args[0]) for c in output.write.call_args_list)
        self.assertIn('"phase": "runtime"', messages)
        self.assertNotIn("PRIVATE", messages)

    def test_daemon_mode_never_imports_direct_gpio_or_rewrites_registration(self):
        spec = importlib.util.spec_from_file_location("isolated_whisplay_client", ROOT / "python/whisplay_client.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # Succeeds even without gpiod/spidev.
        fake = mock.Mock()
        fake.ping.return_value = True
        with mock.patch.object(module, "WhisplayDaemonProxy", return_value=fake), mock.patch.dict(os.environ, {"WHISPLAY_LATENCY_DIAGNOSTICS": "true"}):
            self.assertIs(module.create_whisplay_hardware(), fake)
        fake.register.assert_not_called()
        fake.acquire_foreground.assert_called_once()

    def test_signal_handlers_installed_before_blocking_server_and_cleanup_runs(self):
        tree = ast.parse((ROOT / "python/chatbot-ui.py").read_text())
        main = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == "main")
        # Execute only the real main, with hardware and server edges replaced.
        events = []
        board = mock.Mock(LCD_WIDTH=240, LCD_HEIGHT=280)
        renderer = mock.Mock()
        scope = {"signal": signal, "os": os, "create_whisplay_hardware": lambda: board,
                 "RenderThread": lambda *a, **kw: renderer, "resolve_font_path": lambda: "/fixture/font.ttf",
                 "on_app_exit_requested": lambda: None,
                 "start_socket_server": lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("fixture"))}
        with mock.patch.object(signal, "signal", side_effect=lambda s, h: events.append(s)):
            exec(compile(ast.Module(body=[main], type_ignores=[]), "main-fixture", "exec"), scope)
            with self.assertRaisesRegex(RuntimeError, "fixture"):
                scope["main"]()
        self.assertIn(signal.SIGTERM, events)
        self.assertNotIn(signal.SIGKILL, events)
        self.assertNotIn(signal.SIGSTOP, events)
        board.cleanup.assert_called_once()
        renderer.stop.assert_called_once()


@unittest.skipUnless(sys.platform == "linux", "Linux subreaper/kernel lock coverage")
class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="diagnostic-owned-")
        self.root = Path(self.temp.name)
        self.lock = self.root / "application.lock"
        self.processes = []
        self.fixture = self.root / "app.py"
        self.launcher = self.root / "launch.py"
        self.launcher.write_text(f'''import os,sys,fcntl
sys.path.insert(0,{str(ROOT / 'scripts')!r})
import importlib.util
s=importlib.util.spec_from_file_location('owner',{str(ROOT / 'scripts/diagnostic-session.py')!r})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
fd=os.open({str(self.lock)!r},os.O_CREAT|os.O_RDWR,0o600)
if fd!=9: os.dup2(fd,9);os.close(fd)
fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
sys.exit(m.supervise([sys.executable,'-u',{str(self.fixture)!r}],{str(self.root)!r},os.environ.copy(),grace=0.25,kill_wait=1,startup_timeout=0.5))
''')

    def tearDown(self):
        for p in self.processes:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
            for stream in (p.stdout, p.stderr):
                if stream:
                    stream.close()
        self.temp.cleanup()

    def start(self, code):
        self.fixture.write_text(code)
        p = subprocess.Popen([sys.executable, "-u", str(self.launcher)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(p)
        return p

    def lock_free(self):
        with self.lock.open("a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False

    def wait_file(self, name):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if (self.root / name).exists():
                return (self.root / name).read_text()
            time.sleep(0.02)
        self.fail(f"fixture did not create {name}")

    def assert_dead(self, pid):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            info = session.process_info(pid)
            if not info or info["state"] == "Z":
                return
            time.sleep(0.02)
        self.fail("diagnostic descendant remained alive")

    def test_node_startup_exit_code_and_private_stderr(self):
        p = self.start("import os\nos.execvp('node',['node','-e',\"console.error('password=PRIVATE');process.exit(17)\"])\n")
        out, err = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 17)
        self.assertIn(b"startup_failure", out)
        self.assertIn(b"cleanup_verified", out)
        self.assertNotIn(b"PRIVATE", out + err)
        self.assertTrue(self.lock_free())

    def test_successful_exit_without_measurements_is_failure(self):
        p = self.start(READY[:READY.index("identity=")] + "sys.exit(0)\n")
        out, _ = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 65)
        self.assertIn(b"no_interaction_events", out)
        self.assertTrue(self.lock_free())

    def test_signals_cleanup_and_never_suspend_or_leak_lock(self):
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTSTP):
            with self.subTest(signal=signum):
                marker = f"ready-{signum}"
                p = self.start(READY + f"open({marker!r},'w').write(str(os.getpid()))\nwhile True: time.sleep(.05)\n")
                pid = int(self.wait_file(marker))
                self.assertFalse(self.lock_free())
                p.send_signal(signum)
                out, _ = p.communicate(timeout=5)
                self.assertEqual(p.returncode, 128 + signum)
                self.assertIn(b"cleanup_verified", out)
                self.assert_dead(pid)
                self.assertTrue(self.lock_free())

    def test_stubborn_owned_descendant_escalated_but_unrelated_process_survives(self):
        external = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(20)"])
        self.processes.append(external)
        child_code = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)"
        code = READY + f"import subprocess\np=subprocess.Popen([sys.executable,'-c',{child_code!r}],start_new_session=True)\nopen('child','w').write(str(p.pid))\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True: time.sleep(.05)\n"
        p = self.start(code)
        child = int(self.wait_file("child"))
        time.sleep(0.1)
        p.terminate()
        out, _ = p.communicate(timeout=5)
        self.assertIn(b"escalation", out)
        self.assert_dead(child)
        self.assertIsNone(external.poll())
        self.assertTrue(self.lock_free())

    def test_broken_output_pipeline_stops_owned_application(self):
        p = self.start(READY + "open('pid','w').write(str(os.getpid()))\nwhile True:\n print('[Diagnostics] '+json.dumps({'event':'display_ready','phase':'startup'}),flush=True)\n time.sleep(.03)\n")
        pid = int(self.wait_file("pid"))
        p.stdout.close()
        p.wait(timeout=5)
        self.assert_dead(pid)
        self.assertTrue(self.lock_free())

    def test_abrupt_relay_death_lifeline_cleans_application(self):
        p = self.start(READY + "open('pid','w').write(str(os.getpid()))\nwhile True: time.sleep(.05)\n")
        pid = int(self.wait_file("pid"))
        p.kill()
        p.wait(timeout=5)
        self.assert_dead(pid)
        end = time.monotonic() + 5
        while not self.lock_free() and time.monotonic() < end:
            time.sleep(0.02)
        self.assertTrue(self.lock_free())

    def test_startup_timeout_is_bounded(self):
        p = self.start("import time\ntime.sleep(20)\n")
        out, _ = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 124)
        self.assertIn(b"startup_timeout", out)
        self.assertTrue(self.lock_free())

    def test_guardian_death_adopts_and_cleans_remaining_owned_children(self):
        p = self.start(READY + "open('pid','w').write(str(os.getpid()))\nopen('guard','w').write(str(os.getppid()))\nwhile True: time.sleep(.05)\n")
        pid, guard = int(self.wait_file("pid")), int(self.wait_file("guard"))
        os.kill(guard, signal.SIGKILL)
        out, _ = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 137)
        self.assertIn(b"guardian_terminated", out)
        self.assert_dead(pid)
        self.assertTrue(self.lock_free())

    def test_stalled_consumer_does_not_block_cleanup(self):
        p = self.start(READY + "open('pid','w').write(str(os.getpid()))\nwhile True:\n print('[Diagnostics] '+json.dumps({'event':'display_ready','phase':'startup'}),flush=True)\n")
        pid = int(self.wait_file("pid"))
        p.wait(timeout=5)  # Deliberately never drain stdout while it is running.
        self.assert_dead(pid)
        self.assertTrue(self.lock_free())
        self.assertIn(b"output_backpressure", p.stderr.read())

    def test_stopped_guardian_cannot_hang_relay_shutdown(self):
        p = self.start(READY + "open('pid','w').write(str(os.getpid()))\nopen('guard','w').write(str(os.getppid()))\nwhile True: time.sleep(.05)\n")
        pid, guard = int(self.wait_file("pid")), int(self.wait_file("guard"))
        os.kill(guard, signal.SIGSTOP)
        p.terminate()
        p.communicate(timeout=5)
        self.assert_dead(pid)
        self.assert_dead(guard)
        self.assertTrue(self.lock_free())

    def test_sanitizer_retains_exception_type_but_discards_messages(self):
        record = session.safe_record('[Diagnostics] {"event":"display_failure","error_type":"OSError","message":"PRIVATE","frame":"utils.py","line":4}')
        self.assertEqual(record["error_type"], "OSError")
        self.assertNotIn("PRIVATE", json.dumps(record))
        self.assertIsNone(session.safe_record("Traceback with PRIVATE content"))

    def test_reused_pid_identity_is_never_signalled(self):
        old = {"pid": 123456, "birth": "old", "state": "S"}
        with mock.patch.object(session, "descendants", return_value=[old]), \
             mock.patch.object(session, "process_info", return_value={**old, "birth": "new"}), \
             mock.patch.object(session.os, "pidfd_open", return_value=345), \
             mock.patch.object(session.os, "close") as close, \
             mock.patch.object(session.signal, "pidfd_send_signal") as send:
            session.signal_owned(1, signal.SIGKILL)
        send.assert_not_called()
        close.assert_called_once_with(345)


if __name__ == "__main__":
    unittest.main()
