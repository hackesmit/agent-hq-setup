"""The round 1 reviewer probes (state/review/hq-ymxzt.3/r1/probe_wake.py), ported to the
listener's Io after the 2026-11-04 08:47 design change. The original fake had post(event)
with one argument and no Flow history, so it cannot carry a say; every assertion is kept.
test_A asserted the defect (a foreign clipboard change led to a desktop Enter); it now
asserts the fix: nothing the clipboard does can press Enter, because no Enter exists."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from capri.core import Config, handle_wake  # noqa: E402

ROW = {"transcriptEntityId": "tr-9", "timestamp": 5.0, "status": "formatted", "asrText": "a", "formattedText": "Hello.", "editedText": None}


class Io:
    def __init__(self, reply, clip_changes_at=None, fg=True, end="end"):
        self.t = 0.0; self.reply = reply; self.calls = []; self.clip = 0
        self.clip_changes_at = clip_changes_at; self.fg = fg; self.end = end; self.logs = []
    def now(self): return self.t
    def wall(self): return self.t
    def sleep(self, s):
        self.t += s
        if self.clip_changes_at is not None and self.t >= self.clip_changes_at and self.clip == 0:
            self.clip = 1
    def chime(self, k): self.calls.append(("chime", k))
    def focus_capri(self, state): self.calls.append(("focus_capri",)); return "prev"
    def show(self, state): pass
    def restore(self, prev): self.calls.append(("restore",))
    def post(self, ev, **fields):
        self.calls.append(("post", ev)); return self.reply if ev == "wake" else {"ok": True}
    def hotkey(self): self.calls.append(("hotkey",))
    def enter(self): self.calls.append(("enter",))
    def clipboard_seq(self): return self.clip
    def wait_dictation(self): self.t += 3; return self.end
    def history(self, t0): return ROW
    def row(self, tid): return ROW
    def flow_mark(self): return 0
    def flow_busy(self, mark, t0): return False
    def log(self, r): self.logs.append(r)

LIVE = {"ok": True, "pages": 1, "focused": 1, "orchestrator": True}

def test_A_clipboard_changed_for_other_reason_sends_no_enter():
    io = Io(LIVE, clip_changes_at=0.3, fg=True)
    out = handle_wake(io, Config())
    assert ("enter",) not in io.calls and out == "sent"

def test_B_any_sent_outcome_presses_no_enter_on_desktop():
    io = Io(LIVE, clip_changes_at=1.0)
    handle_wake(io, Config())
    assert ("enter",) not in io.calls, "listener pressed Enter on the desktop"

def test_C_text_reaches_hqbox_as_say():
    io = Io(LIVE, clip_changes_at=1.0)
    handle_wake(io, Config())
    assert ("post", "say") in io.calls, "no say event: delivery depends on focus and Flow's paste"

def test_D_403_or_timeout_reply_none_no_hotkey():
    io = Io(None); out = handle_wake(io, Config())
    assert ("hotkey",) not in io.calls and out == "no-target" and ("post", "done") not in io.calls

def test_E_no_orchestrator_no_hotkey_low_chime():
    io = Io({"ok": True, "pages": 2, "focused": 0, "orchestrator": False}); out = handle_wake(io, Config())
    assert ("hotkey",) not in io.calls and ("chime", "none") in io.calls and out == "no-target"

def test_F_focus_lost_still_delivers_and_no_enter():
    # the owner clicks away mid-dictation: the paste may land there, but the say still goes.
    io = Io(LIVE, clip_changes_at=1.0, fg=False)
    assert handle_wake(io, Config()) == "sent" and ("enter",) not in io.calls and ("post", "say") in io.calls

def test_the_windows_module_sends_no_key_but_the_flow_hotkey():
    """win.py is Windows-only; read its source: every key it can send, and no Enter."""
    import ast
    src = (Path(__file__).resolve().parents[1] / "capri" / "win.py").read_text(encoding="utf-8")
    keys = {a.args[0].id for a in ast.walk(ast.parse(src))
            if isinstance(a, ast.Call) and getattr(a.func, "id", "") == "_key" and isinstance(a.args[0], ast.Name)}
    assert keys == {"VK_LCONTROL", "VK_LWIN", "VK_SPACE"}
    assert "VK_RETURN" not in src and "def enter" not in src and "keybd_event" not in src
