"""Terminal-style renderer for the 240x280 Whisplay display.

The classic renderer in chatbot-ui.py stays available with WHISPLAY_UI=classic.
Any other value (or no value) selects this package.
"""
import os


def ui_mode(env=None):
    """Return "classic" or "terminal" from the WHISPLAY_UI environment variable."""
    env = os.environ if env is None else env
    value = str(env.get("WHISPLAY_UI", "") or "").strip().lower()
    return "classic" if value == "classic" else "terminal"


def create_terminal_ui(*args, **kwargs):
    from .terminal_ui import TerminalUI
    return TerminalUI(*args, **kwargs)
