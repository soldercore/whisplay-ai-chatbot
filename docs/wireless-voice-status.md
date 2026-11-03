# Wireless voice and shared status candidate

Development only; no production deployment or permission changes.

The daemon samples actual cached NetworkManager radio/connection/signal state and
BlueZ Powered state. One owned D-Bus observer invalidates a coalesced cache; a
60-second fallback handles missed events. There are no scans in the observer.
Reads run away from the button/render loop. Home receives the snapshot directly;
GLaDOS receives the same data in the authenticated subscription acknowledgement
and device_status events. Unknown readings are marked, never displayed as Off.
The small wireless_icons.py renderer is vendored identically in both repositories
and stays usable when the optional cyber UI fails.

Clear wireless/status/power requests use the existing fast tool path. Unfamiliar
wireless requests retain Qwen interpretation and host validation. Status questions,
observations, troubleshooting, negation and conditional requests cannot authorize
changes. Exit GLaDOS/Home, screen-off and full-system shutdown remain distinct.
Bare power ability questions read capabilities; ambiguous targets get clarification.

Bluetooth idle radio toggles and paired reconnection reuse existing BlueZ controls
and verify readback. Pairing uses the existing local authorization flow. Disabling
connected radios, disconnecting and forgetting devices check the scoped SSH guard;
the backend rechecks too, including button operations. A missing guard fails closed.

Wi-Fi disable/join/switch/disconnect remain disabled in the shared client and helper.
Automatic NM rollback stays finite (120 seconds); failed verification retains its
automatic timer and never claims recovery. Offline Wi-Fi recovery is not accepted.
Wi-Fi enabling/scanning still depend on existing permissions/the optional helper.
Shutdown/reboot stay unavailable without the trusted helper. When supported, the
existing Cancel-first, expiring dialog requires fresh physical gestures after PTT
and owned GLaDOS cleanup; speech cannot accept it.

The installed account currently reports NetworkManager Wi-Fi enable=no, scan=auth;
/usr/lib/whisplay/control-action is absent. Broad NOPASSWD: ALL was not changed and
is not used as a new action grant. Helper installation/administrative recovery and
sudo reduction remain separate approvals. No real disruptive operation was tested.

Validation: Pi Node suite 593/593, followed by 60/60 final focused cases including
one additional public Ollama-entry test (594 distinct Node tests in total); daemon
160/160; two chatbot status tests; full UI self-tests; source/test typechecks.
Actual read-only Pi status: Wi-Fi connected, signal 73%, Bluetooth off. Four rendered
states have identical indicator pixels in Home/GLaDOS. The temporary observer exited.
No physical acceptance or new voice-latency measurement is claimed. Existing persona,
model/context, memory, ASR, TTS, PTT and four-click exit code paths are preserved.

Deployment must pair both candidates, copy only reviewed runtime files, preserve
backups and existing overlays, and keep helper activation out of this change.
The production Wi-Fi backend differs from the daemon branch parent; deploy the
reviewed wifi_control.py as a whole to retain its helper-only mutation path.
Production services_app.py also differs from the parent; it is not part of this
limited change, so future helper/service activation needs separate compatibility
verification. Do not deploy the entire daemon branch or run its installers blindly.
