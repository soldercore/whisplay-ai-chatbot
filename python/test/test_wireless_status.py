"""No board/microphone/network access: exercise actual subscriber and UI model."""
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class WirelessDisplayTests(unittest.TestCase):
    def test_subscription_snapshot_and_event_wake_the_renderer_without_polling(self):
        with patch.dict(sys.modules, {'whisplay': SimpleNamespace(WhisplayBoard=object)}):
            spec = importlib.util.spec_from_file_location('status_client_test', ROOT/'whisplay_client.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        proxy = module.WhisplayDaemonProxy()
        off = {'wifi':{'enabled':False},'bluetooth':{'enabled':False}}
        on = {'wifi':{'enabled':True,'connected':True,'signal':80},'bluetooth':{'enabled':True}}
        frames = []
        def changed():
            frames.append(proxy.wireless_status)
            if len(frames) == 2:
                proxy._running = False
        proxy.status_update_callback = changed
        connection = Mock()
        connection.makefile.return_value = io.StringIO(json.dumps({'ok':True,'payload':{'wireless_status':off}})+'\n'
            +json.dumps({'event':'device_status','payload':on})+'\n')
        context = Mock()
        context.__enter__ = Mock(return_value=connection)
        context.__exit__ = Mock(return_value=False)
        proxy._running = True
        with patch.object(module.socket, 'socket', return_value=context):
            proxy._event_loop()
        self.assertEqual(frames,[off,on])
        self.assertEqual(json.loads(connection.sendall.call_args.args[0])['cmd'],'events.subscribe')
        self.assertFalse(proxy._button_down, 'status updates cannot become PTT gestures')

    def test_real_terminal_model_and_status_key_include_wireless_changes(self):
        from whisplay_ui.terminal_ui import TerminalUI
        from whisplay_ui.statusbar import StatusBar
        from whisplay_ui import visual_state as vs
        # The status-model uses existing terminal fonts/rendering elsewhere; only
        # exercise its real data path here, without creating GPIO resources.
        terminal = TerminalUI.__new__(TerminalUI)
        terminal.info = SimpleNamespace(raw_status='sleep')
        terminal.body = SimpleNamespace(speaking=lambda _:False)
        terminal.last_now = 0
        clock = SimpleNamespace(wall_hms=lambda:(12,0,0))
        import whisplay_ui.terminal_ui as ui
        state = {'wifi':{'enabled':False},'bluetooth':{'enabled':False}}
        with patch.object(ui, 'clock', clock):
            model = terminal._status_model({'wireless_status':state}, vs.IDLE)
        self.assertEqual(model['wireless_status'],state)
        bar = StatusBar(None)
        key = bar.key(model)
        model['wireless_status'] = {'wifi':{'enabled':True},'bluetooth':{'enabled':False}}
        self.assertNotEqual(bar.key(model),key)


if __name__ == '__main__':
    unittest.main()
