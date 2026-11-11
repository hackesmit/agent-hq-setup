import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from capri.console import Console  # noqa: E402
from capri.core import Config, Dictation, boot_key, handle_wake  # noqa: E402


LIVE = {"ok": True, "pages": 1, "focused": 1, "orchestrator": True}
ROW = {"transcriptEntityId": "tr-1", "timestamp": 1000.0, "status": "formatted", "asrText": "raw", "formattedText": "Formatted.", "editedText": None}


class FakeIo:
    """A fake George: History rows appear `rows_at` seconds after the stop hotkey."""

    def __init__(self, *, reply=LIVE, end="end", rows=None, rows_at=2.0, say=None, busy=False):
        self.t = 0.0
        self.busy = busy  # Flow was already dictating when the wake came
        self.calls = []
        self.reply, self.end = reply, end
        self.rows = [dict(ROW)] if rows is None else rows  # one row per history poll after rows_at; last repeats
        self.rows_at = rows_at
        self.say = list(say) if say else [{"ok": True, "event": "say"}]
        self.stopped_at = None
        self.stops = 0
        self.logs = []
        self.box = None  # the Capri window state

    def now(self):
        return self.t

    def wall(self):
        return 999.0 + self.t

    def sleep(self, s):
        self.t += s

    def chime(self, kind):
        self.calls.append(("chime", kind))

    def post(self, event, **fields):
        self.calls.append(("post", event))
        if event == "wake":
            return self.reply
        if event == "say":
            self.calls[-1] = ("post", "say", fields)
            return self.say.pop(0) if len(self.say) > 1 else self.say[0]
        return {"ok": True}

    def focus_capri(self, state):
        self.calls.append(("focus_capri", state))
        self.box = state
        return "owners-window"

    def show(self, state):
        self.calls.append(("show", state))
        self.box = state

    def restore(self, prev):
        self.calls.append(("restore", prev))

    def hotkey(self):
        self.calls.append(("hotkey",))
        self.stops += 1
        if self.stops == 2:
            self.stopped_at = self.t

    def wait_dictation(self):
        self.t += 5
        return self.end

    def history(self, t0):
        assert t0 == 999.0, "rows are looked up after the chime time"
        if self.stopped_at is None or self.t - self.stopped_at < self.rows_at or not self.rows:
            return None
        return self.rows.pop(0) if len(self.rows) > 1 else self.rows[0]

    def row(self, tid):
        """Polls of the pinned id walk the same row sequence; a row with another id is not it."""
        self.calls.append(("row", tid))
        r = self.history(999.0)
        return r if r is not None and r.get("transcriptEntityId") == tid else None

    def flow_mark(self):
        self.calls.append(("flow_mark",))
        return 41

    def flow_busy(self, mark, t0):
        assert (mark, t0) == (41, 999.0)
        self.calls.append(("flow_busy",))
        return self.busy

    def log(self, rec):
        self.logs.append(rec)


def names(io):
    return [c[0] if c[0] != "chime" else "chime:" + c[1] for c in io.calls if c[0] not in ("row", "flow_mark", "flow_busy")]


def says(io):
    return [c[2] for c in io.calls if c[:2] == ("post", "say")]


def keys_sent(io):
    """Every key the listener sent to the desktop: only the Flow hotkey may appear."""
    return [c for c in io.calls if c[0] in ("hotkey", "enter", "key")]


def test_happy_path_focuses_capri_reads_flow_history_and_says():
    io = FakeIo()
    assert handle_wake(io, Config()) == "sent"
    assert names(io) == ["chime:heard", "post", "focus_capri", "hotkey", "hotkey", "show", "restore", "post", "show", "post", "chime:done"]
    assert io.calls[1] == ("post", "wake")
    assert says(io) == [{"text": "Formatted.", "transcriptId": "tr-1"}]
    assert ("restore", "owners-window") in io.calls and io.box is None
    assert keys_sent(io) == [("hotkey",), ("hotkey",)], "no Enter, no other key on the desktop"
    last = io.logs[-1]
    assert last["outcome"] == "sent" and last["transcriptId"] == "tr-1" and last["chars"] == 10


def test_focus_goes_back_only_after_the_paste_had_time_to_land():
    io = FakeIo()
    handle_wake(io, Config(paste_settle_s=1.0))
    i_restore = io.calls.index(("restore", "owners-window"))
    i_say = next(i for i, c in enumerate(io.calls) if c[:2] == ("post", "say"))
    assert i_restore < i_say
    assert io.t >= io.stopped_at + io.rows_at + 1.0


def test_edited_text_wins_over_formatted():
    io = FakeIo(rows=[{**ROW, "editedText": "Edited."}])
    handle_wake(io, Config())
    assert says(io)[0]["text"] == "Edited."


def test_raw_row_waits_for_formatted():
    raw = {**ROW, "status": "raw_transcript", "formattedText": None}
    io = FakeIo(rows=[raw, raw, raw, dict(ROW)])
    assert handle_wake(io, Config()) == "sent"
    assert says(io)[0]["text"] == "Formatted."


def test_raw_row_falls_back_to_asr_text_after_the_format_wait():
    raw = {**ROW, "status": "raw_transcript", "formattedText": None}
    io = FakeIo(rows=[raw])
    assert handle_wake(io, Config(format_wait_s=10.0)) == "sent"
    assert says(io)[0]["text"] == "raw"
    assert io.t >= io.stopped_at + io.rows_at + 10.0


def test_no_history_row_sends_nothing():
    io = FakeIo(rows=[])
    assert handle_wake(io, Config(history_wait_s=3.0)) == "no-transcript"
    assert not says(io) and ("post", "done") in io.calls and ("chime", "none") in io.calls
    assert ("restore", "owners-window") in io.calls and io.box is None


def test_no_orchestrator_is_no_target_and_never_presses_the_hotkey():
    io = FakeIo(reply={"ok": True, "pages": 2, "focused": 2, "orchestrator": False})
    assert handle_wake(io, Config()) == "no-target"
    assert not keys_sent(io) and ("chime", "none") in io.calls and ("focus_capri", "listening") not in io.calls


def test_a_hidden_console_page_does_not_matter_when_an_orchestrator_is_live():
    io = FakeIo(reply={"ok": True, "pages": 1, "focused": 0, "orchestrator": True})
    assert handle_wake(io, Config()) == "sent"


def test_console_unreachable_is_no_target():
    io = FakeIo(reply=None)
    assert handle_wake(io, Config()) == "no-target"
    assert ("hotkey",) not in io.calls
    assert ("post", "done") not in io.calls


def test_a_refused_wake_is_no_target():
    io = FakeIo(reply={"ok": False, "status": 403})
    assert handle_wake(io, Config()) == "no-target"
    assert not keys_sent(io) and ("post", "done") not in io.calls


def test_no_speech_stops_flow_and_says_nothing():
    io = FakeIo(end="nospeech", rows=[])
    assert handle_wake(io, Config()) == "no-speech"
    assert io.stops == 2 and not says(io) and ("post", "done") in io.calls
    assert ("restore", "owners-window") in io.calls and io.box is None


def test_no_speech_with_a_flow_row_still_sends():
    for words in ("Pause.", "Pause the song.", "Next."):
        io = FakeIo(end="nospeech", rows=[{**ROW, "formattedText": words}], rows_at=1.0)
        assert handle_wake(io, Config()) == "sent"
        assert says(io) == [{"text": words, "transcriptId": "tr-1"}]
        assert io.logs[-1]["end"] == "nospeech"


def test_no_speech_row_after_the_short_window_is_ignored():
    io = FakeIo(end="nospeech", rows_at=5.0)
    assert handle_wake(io, Config()) == "no-speech"
    assert not says(io) and io.t < 5 + 5 + 4


def test_409_shows_not_running_and_retries_once():
    io = FakeIo(say=[{"ok": False, "status": 409}, {"ok": True}])
    assert handle_wake(io, Config()) == "sent"
    assert len(says(io)) == 2 and says(io)[0] == says(io)[1]
    assert ("show", "orchestrator not running") in io.calls
    io = FakeIo(say=[{"ok": False, "status": 409}, {"ok": False, "status": 409}])
    assert handle_wake(io, Config()) == "not-delivered"
    assert len(says(io)) == 2 and io.logs[-1]["say_status"] == 409


def test_text_is_capped_at_4000_characters():
    io = FakeIo(rows=[{**ROW, "formattedText": "x" * 4100}])
    handle_wake(io, Config())
    assert len(says(io)[0]["text"]) == 4000 and io.logs[-1]["truncated"] is True


def test_the_log_never_holds_transcript_text():
    io = FakeIo(rows=[{**ROW, "formattedText": "secret words here"}])
    handle_wake(io, Config())
    assert "secret" not in json.dumps(io.logs)


def test_dictation_ends_after_silence_following_speech():
    cfg = Config(end_silence_s=2.0, no_speech_s=6.0, max_s=60.0)
    d = Dictation(floor=0.01, cfg=cfg, start=0.0)
    assert d.feed(0.005, 1.0) is None  # room noise
    assert d.feed(0.2, 2.0) is None  # speech
    assert d.feed(0.005, 3.9) is None  # a pause
    assert d.feed(0.005, 4.0) == "end"


def test_dictation_no_speech_and_max():
    cfg = Config(no_speech_s=6.0, max_s=10.0)
    d = Dictation(floor=0.01, cfg=cfg, start=0.0)
    assert d.feed(0.01, 5.9) is None
    assert d.feed(0.01, 6.0) == "nospeech"
    d = Dictation(floor=0.01, cfg=cfg, start=0.0)
    for t in range(10):
        assert d.feed(0.5, float(t)) is None
    assert d.feed(0.5, 10.0) == "max"


def test_boot_key_from_the_served_page():
    page = '<head>\n    <meta name="console-boot-key" content="eb981ae5ab4829b28e6c07402a4a5aef52191efe910b3332" />'
    assert boot_key(page) == "eb981ae5ab4829b28e6c07402a4a5aef52191efe910b3332"
    assert boot_key("<html></html>") is None
    assert boot_key('<meta name="console-boot-key" content="__CONSOLE_BOOT_KEY__" />') is None


class FakeServer:
    def __init__(self):
        self.key = "a" * 48
        self.requests = []
        self.bodies = []
        self.no_orchestrator = False

    def __call__(self, req, timeout):
        self.requests.append(req)
        if req.get_method() == "GET":
            return 200, f'<meta name="console-boot-key" content="{self.key}" />'
        if req.get_header("X-console-key") != self.key:
            return 403, json.dumps({"error": "stale page key", "reload": True})
        body = json.loads(req.data)
        self.bodies.append(body)
        if body["event"] == "say" and self.no_orchestrator:
            return 409, json.dumps({"error": "orchestrator not running"})
        return 200, json.dumps({"ok": True, "pages": 1, "focused": 1})


def test_console_fetches_the_key_and_refetches_after_a_restart():
    srv = FakeServer()
    c = Console("https://hq.example:8790", opener=srv)
    assert c.post("wake")["focused"] == 1
    srv.key = "b" * 48  # console restarted
    assert c.post("done")["ok"] is True
    gets = [r for r in srv.requests if r.get_method() == "GET"]
    assert len(gets) == 2
    assert c.key == "b" * 48


def test_console_down_is_none():
    def boom(req, timeout):
        raise OSError("down")

    assert Console("https://x", opener=boom).post("wake") is None


def test_console_say_carries_text_and_id_and_reports_a_409():
    srv = FakeServer()
    c = Console("https://hq.example:8790", opener=srv)
    assert c.post("say", text="hi", transcriptId="t1")["ok"] is True
    assert srv.bodies[-1] == {"event": "say", "text": "hi", "transcriptId": "t1"}
    srv.no_orchestrator = True
    assert c.post("say", text="hi", transcriptId="t1") == {"ok": False, "status": 409}


def test_the_hard_stop_cancels_and_sends_nothing():
    io = FakeIo(end="max")
    assert handle_wake(io, Config()) == "max-cancel"
    assert says(io) == [], "a dictation cut off at 60 s is never sent"
    assert io.stops == 2, "Flow is still stopped"
    assert ("post", "done") in io.calls and ("chime", "none") in io.calls and io.box is None
    assert io.logs[-1]["end"] == "max"


def test_the_hard_stop_keeps_capri_focused_until_flows_paste_landed():
    """lucy r3 finding 1: the stop hotkey makes Flow transcribe and paste; that paste
    must land in the Capri window, never in the owner's (hq-ymxzt.10)."""
    io = FakeIo(end="max", rows_at=4.0)
    handle_wake(io, Config(paste_settle_s=1.0))
    restore_at = [i for i, c in enumerate(io.calls) if c[0] == "restore"]
    assert len(restore_at) == 1
    assert io.t >= io.stopped_at + 4.0 + 1.0, "focus goes back only after the row and the paste settle"
    assert io.logs[-1]["transcriptId"] == "tr-1"


def test_the_hard_stop_with_no_flow_row_still_cancels():
    io = FakeIo(end="max", rows=[])
    assert handle_wake(io, Config()) == "max-cancel"
    assert says(io) == []


def test_a_wake_while_flow_already_dictates_never_starts_a_second_recording():
    """lucy r3 finding 4: the first hotkey stopped the owner's own dictation, so a second
    press would start a recording nobody stops (hq-ymxzt.10)."""
    io = FakeIo(busy=True)
    assert handle_wake(io, Config(paste_settle_s=1.0)) == "flow-busy"
    assert keys_sent(io) == [("hotkey",)], "one press only: Flow is idle again"
    assert says(io) == [], "the owner's own dictation is never sent to the orchestrator"
    assert ("chime", "none") in io.calls and io.box is None
    assert io.calls.index(("flow_mark",)) < io.calls.index(("hotkey",))


def test_a_lost_say_reply_is_uncertain_and_never_retried():
    """lucy r3 finding 2: a say that reached the console with no answer may have been
    typed; a console restart forgets its replay ids, so the listener never resends."""
    io = FakeIo(say=[{"ok": False, "status": "lost"}, {"ok": True}])
    assert handle_wake(io, Config()) == "uncertain"
    assert len(says(io)) == 1
    assert io.logs[-1]["say_status"] == "lost"


def test_console_reports_a_post_with_no_answer_as_lost_and_no_connection_as_none():
    import urllib.error

    srv = FakeServer()
    c = Console("https://hq.example:8790", opener=srv)
    assert c.post("wake")["ok"] is True

    def refused(req, timeout):
        raise urllib.error.URLError(ConnectionRefusedError())

    def timed_out(req, timeout):
        raise TimeoutError("read timed out")  # urlopen raises this unwrapped from getresponse

    c.opener = refused
    assert c.post("say", text="hi", transcriptId="t1") is None, "nothing reached the console"
    c.opener = timed_out
    assert c.post("say", text="hi", transcriptId="t1") == {"ok": False, "status": "lost"}


def test_console_key_fetch_failure_is_none_even_on_a_read_timeout():
    def timed_out(req, timeout):
        raise TimeoutError("read timed out")

    assert Console("https://x", opener=timed_out).post("say", text="hi") is None


def test_the_first_row_after_the_wake_is_pinned_and_a_later_dictation_is_never_sent():
    a = {**ROW, "status": "raw_transcript", "formattedText": None, "asrText": "capri text"}
    b = {**ROW, "transcriptEntityId": "tr-other", "formattedText": "A hand dictation."}
    io = FakeIo(rows=[a, b])
    assert handle_wake(io, Config(format_wait_s=10.0)) == "sent"
    assert says(io) == [{"text": "capri text", "transcriptId": "tr-1"}]
    assert ("row", "tr-1") in io.calls and not any(c == ("row", "tr-other") for c in io.calls)
    # the raw fallback counts from when the pinned row appeared, not from a later row
    assert io.t >= io.stopped_at + io.rows_at + 10.0


def test_a_row_with_no_id_is_never_sent():
    io = FakeIo(rows=[{**ROW, "transcriptEntityId": ""}])
    assert handle_wake(io, Config()) == "no-transcript"
    assert says(io) == []


def test_an_uncertain_delivery_is_never_sent_again():
    io = FakeIo(say=[{"ok": False, "status": 502}, {"ok": True}])
    assert handle_wake(io, Config()) == "uncertain"
    assert len(says(io)) == 1, "no repaste after the console may have typed it"
    assert io.logs[-1]["say_status"] == 502


def test_a_bad_request_is_not_retried():
    io = FakeIo(say=[{"ok": False, "status": 400}, {"ok": True}])
    assert handle_wake(io, Config()) == "not-delivered"
    assert len(says(io)) == 1


def test_no_answer_to_a_say_retries_once_with_the_same_id():
    io = FakeIo(say=[None, {"ok": True, "duplicate": True}])
    assert handle_wake(io, Config()) == "sent"
    assert [s["transcriptId"] for s in says(io)] == ["tr-1", "tr-1"]


def test_claim_waits_for_the_old_listener_to_exit():
    """schtasks /End then /Run: the old pythonw still holds the mutex for a moment (hq-ymxzt.12)."""
    from capri.core import claim

    tries, slept = iter([False, False, True]), []
    assert claim(lambda: next(tries), slept.append, timeout_s=5, step_s=0.5) is True
    assert slept == [0.5, 0.5]


def test_claim_gives_up_when_a_listener_really_runs():
    from capri.core import claim

    slept = []
    assert claim(lambda: False, slept.append, timeout_s=2, step_s=0.5) is False
    assert sum(slept) == 2.0


def _row(text):
    return [{"transcriptEntityId": "tr-1", "status": "formatted", "formattedText": text, "editedText": None}]


import pytest  # noqa: E402


@pytest.mark.parametrize("text", ["Cancel.", "Never mind.", "Capri, forget it.", "Open Spotify. Never mind.", "Olv\u00eddalo.", "Capri cancel", "Scratch that!"])
def test_a_cancel_phrase_sends_nothing(text):
    io = FakeIo(rows=_row(text))
    assert handle_wake(io, Config()) == "cancelled"
    assert not says(io)
    assert ("show", "cancelled") in io.calls
    assert keys_sent(io) == [("hotkey",), ("hotkey",)]
    assert io.logs[-1]["outcome"] == "cancelled" and text not in json.dumps(io.logs[-1])


@pytest.mark.parametrize("text", ["Cancel my 3pm meeting.", "Never mind the cost, buy it.", "Stop."])
def test_a_phrase_inside_a_sentence_or_bare_stop_is_not_a_cancel(text):
    io = FakeIo(rows=_row(text))
    assert handle_wake(io, Config()) == "sent"
    assert says(io)[0]["text"] == text
