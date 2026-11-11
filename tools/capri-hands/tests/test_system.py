"""hq-63nvj.13: audio devices and volume, monitors and window placement, settings pages,
and the powershell action. Pure logic plus the Backend paths against a fake user32."""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hands import core  # noqa: E402
from test_hands import TOKEN, hands, log, req  # noqa: E402,F401  (hands is a fixture)


# ---- schema ----------------------------------------------------------------

@pytest.mark.parametrize("body", [
    {"action": "audio_devices"},
    {"action": "audio_output", "name": "speakers"},
    {"action": "audio_output", "name": "speakers", "fuzzy": False},
    {"action": "audio_input", "name": "hyperx"},
    {"action": "audio_output", "name": "speakers", "role": 0},
    {"action": "audio_input", "name": "hyperx", "role": 2},
    {"action": "volume"},
    {"action": "volume", "level": 0},
    {"action": "volume", "level": 100},
    {"action": "volume", "command": "up", "step": 5},
    {"action": "volume", "command": "mute"},
    {"action": "monitors"},
    {"action": "move_window", "title": "Notepad", "monitor": 2, "maximize": True},
    {"action": "move_window", "hwnd": 5, "monitor": 1},
    {"action": "open_url", "url": "https://example.com", "monitor": 2},
    {"action": "open_url", "url": "https://example.com", "new_window": True, "maximize": False},
    {"action": "settings", "page": "bluetooth"},
    {"action": "settings", "page": "ms-settings:nightlight"},
    {"action": "powershell", "script": "Get-Date"},
    {"action": "powershell", "script": "Get-Date", "timeout_s": 60},
])
def test_new_actions_accepted(hands, body):
    cfg, be = hands
    assert req(cfg, body=body)[0] == 200 and be.ran[-1]["action"] == body["action"]


@pytest.mark.parametrize("body,status", [
    ({"action": "audio_output"}, 400),
    ({"action": "audio_output", "name": " "}, 400),
    ({"action": "audio_output", "name": "x", "fuzzy": "yes"}, 400),
    ({"action": "audio_input", "name": 3}, 400),
    ({"action": "audio_output", "name": "x", "role": 3}, 400),
    ({"action": "audio_output", "name": "x", "role": -1}, 400),
    ({"action": "audio_input", "name": "x", "role": True}, 400),
    ({"action": "audio_input", "name": "x", "role": "console"}, 400),
    ({"action": "volume", "level": 101}, 400),
    ({"action": "volume", "level": -1}, 400),
    ({"action": "volume", "level": True}, 400),
    ({"action": "volume", "level": 30, "command": "up"}, 400),
    ({"action": "volume", "command": "loud"}, 400),
    ({"action": "volume", "command": "mute", "step": 5}, 400),
    ({"action": "volume", "command": "up", "step": 0}, 400),
    ({"action": "move_window", "monitor": 2}, 400),
    ({"action": "move_window", "title": "x"}, 400),
    ({"action": "move_window", "title": "x", "monitor": 0}, 400),
    ({"action": "open_url", "url": "https://example.com", "monitor": 0}, 400),
    ({"action": "open_url", "url": "file:///C:/x", "monitor": 2}, 400),
    ({"action": "settings", "page": "self destruct"}, 404),
    ({"action": "settings", "page": "ms-settings:../../x"}, 404),
    ({"action": "settings", "page": "file:///C:/Windows"}, 404),
    ({"action": "powershell", "script": "  "}, 400),
    ({"action": "powershell", "script": "Get-Date", "timeout_s": 61}, 400),
    ({"action": "powershell", "script": "Get-Date", "timeout_s": 0}, 400),
    ({"action": "powershell", "script": "Get-Date", "cwd": "C:/"}, 400),
])
def test_new_actions_refused(hands, body, status):
    cfg, be = hands
    assert req(cfg, body=body)[0] == status and be.ran == []


def test_powershell_defaults_timeout_and_log_keeps_length_only(hands):
    cfg, be = hands
    script = "$secret = 'hunter2'; Get-Date"
    assert req(cfg, body={"action": "powershell", "script": script})[0] == 200
    assert be.ran[-1]["timeout_s"] == core.PS_TIMEOUT_DEFAULT
    assert "hunter2" not in cfg.log_file.read_text()
    assert log(cfg)[-1]["target"] == len(script)


@pytest.mark.parametrize("page,uri", [
    ("bluetooth", "ms-settings:bluetooth"),
    ("Bluetooth settings", "ms-settings:bluetooth"),
    ("night light", "ms-settings:nightlight"),
    ("Luz nocturna", "ms-settings:nightlight"),
    ("configuración de sonido", "ms-settings:sound"),
    ("Display", "ms-settings:display"),
    ("wi-fi", "ms-settings:network-wifi"),
    ("settings", "ms-settings:"),
    ("MS-Settings:Privacy-Microphone", "ms-settings:privacy-microphone"),
])
def test_settings_uri(page, uri):
    assert core.settings_uri(page) == uri


# ---- audio -----------------------------------------------------------------

OUTS = [
    {"name": "Realtek Digital Output (2- Realtek(R) Audio)", "id": "{a}", "default": False},
    {"name": "Speakers (2- Realtek(R) Audio)", "id": "{b}", "default": True},
    {"name": "Speakers (HyperX Cloud Flight Wireless)", "id": "{c}", "default": False},
    {"name": "Q27G41ZDF (NVIDIA High Definition Audio)", "id": "{d}", "default": False},
]


@pytest.mark.parametrize("q,want", [
    ("my speaker", "{b}"),
    ("speakers", "{b}"),
    ("hyperx", "{c}"),
    ("HyperX Cloud Flight", "{c}"),
    ("digital output", "{a}"),
    ("q27", "{d}"),
    ("nvidia", "{d}"),
    ("{c}", "{c}"),
    ("speakers (hyperx cloud flight wireless)", "{c}"),
])
def test_match_device(q, want):
    dev, matches = core.match_device(q, OUTS)
    assert dev["id"] == want and dev["name"] in matches


def test_match_device_reports_ambiguity_and_misses():
    dev, matches = core.match_device("speaker", OUTS)
    assert dev["id"] == "{b}" and set(matches) == {OUTS[1]["name"], OUTS[2]["name"]}
    assert core.match_device("bluetooth earbuds", OUTS) == (None, [])
    assert core.match_device("speakers", OUTS, fuzzy=False) == (None, [])
    assert core.match_device("Speakers (2- Realtek(R) Audio)", OUTS, fuzzy=False)[0]["id"] == "{b}"


@pytest.mark.parametrize("cur,a,want", [
    (60, {"level": 30}, (30, False)),
    (60, {"command": "up"}, (70, False)),
    (95, {"command": "up"}, (100, False)),
    (60, {"command": "down", "step": 25}, (35, None)),
    (5, {"command": "down"}, (0, None)),
    (60, {"command": "mute"}, (None, True)),
    (60, {"command": "unmute"}, (None, False)),
    (60, {}, (None, None)),
])
def test_volume_target(cur, a, want):
    assert core.volume_target(cur, a) == want


# ---- monitors --------------------------------------------------------------

RAW = [
    {"device": r"\\.\DISPLAY2", "bounds": [2560, 0, 4480, 1080], "work": [2560, 0, 4480, 1040], "primary": False},
    {"device": r"\\.\DISPLAY1", "bounds": [0, 0, 2560, 1440], "work": [0, 0, 2560, 1392], "primary": True},
    {"device": r"\\.\DISPLAY3", "bounds": [-1920, 0, 0, 1080], "work": [-1920, 0, 0, 1040], "primary": False},
]


def test_order_monitors_primary_then_left_to_right():
    ms = core.order_monitors(RAW)
    assert [(m["index"], m["device"][-1]) for m in ms] == [(1, "1"), (2, "3"), (3, "2")]


def test_pick_monitor_falls_back_to_primary_and_says_so():
    ms = core.order_monitors(RAW[1:2])
    assert core.pick_monitor(ms, 1) == (ms[0], False)
    assert core.pick_monitor(ms, 2) == (ms[0], True)
    with pytest.raises(core.Refused):
        core.pick_monitor([], 1)


def test_place_centers_and_clamps():
    assert core.place((0, 0, 800, 600), (2560, 0, 4480, 1040)) == (2560 + 560, 220, 800, 600)
    assert core.place((0, 0, 3000, 2000), (2560, 0, 4480, 1040)) == (2560, 0, 1920, 1040)


def test_browser_argv():
    assert core.browser_argv(r"C:\x\msedge.exe", " https://e.com ") == [r"C:\x\msedge.exe", "--new-window", "https://e.com"]
    assert core.browser_argv(r"C:\Mozilla Firefox\firefox.exe", "https://e.com")[1] == "-new-window"


def test_clip_keeps_the_tail():
    assert core.clip("abc", 5) == ("abc", False)
    assert core.clip("0123456789", 4) == ("6789", True)


# ---- backend against a fake user32 -------------------------------------------

@pytest.fixture
def win(monkeypatch):
    import ctypes
    import importlib
    from unittest import mock

    fake = mock.MagicMock()
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **kw: fake, raising=False)
    monkeypatch.setattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 0, raising=False)
    for m in ("hands.win", "hands.audio"):
        sys.modules.pop(m, None)
    mod = importlib.import_module("hands.win")
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)
    yield mod, fake
    for m in ("hands.win", "hands.audio"):
        sys.modules.pop(m, None)


def test_audio_output_sets_the_match_and_names_the_previous(win, tmp_path, monkeypatch):
    mod, _ = win
    set_to = []
    monkeypatch.setattr(mod.audio, "devices", lambda: {"outputs": OUTS, "inputs": []})
    monkeypatch.setattr(mod.audio, "set_default", lambda i, roles: set_to.append((i, roles)))
    r = mod.Backend(core.Config(home=tmp_path)).run({"action": "audio_output", "name": "hyperx"})
    assert set_to == [("{c}", (0, 1, 2))] and r["device"] == OUTS[2]["name"] and r["previous"] == OUTS[1]["name"]
    assert r["roles"] == ["console", "multimedia", "communications"]


def test_audio_output_with_a_role_sets_only_that_role(win, tmp_path, monkeypatch):
    """Per role defaults (lucy 4): role 2 sets communications alone and names the device
    that held that role, not the console default."""
    mod, _ = win
    set_to = []
    found = {"outputs": OUTS, "inputs": [],
             "defaults": {"output": {"console": "{b}", "multimedia": "{b}", "communications": "{a}"},
                          "input": {"console": None, "multimedia": None, "communications": None}}}
    monkeypatch.setattr(mod.audio, "devices", lambda: found)
    monkeypatch.setattr(mod.audio, "set_default", lambda i, roles: set_to.append((i, roles)))
    r = mod.Backend(core.Config(home=tmp_path)).run({"action": "audio_output", "name": "{c}", "role": 2})
    assert set_to == [("{c}", (2,))] and r["previous"] == OUTS[0]["name"] and r["roles"] == ["communications"]


def test_audio_devices_reports_the_default_per_role(win, monkeypatch):
    mod, _ = win
    a = mod.audio
    asked = []
    monkeypatch.setattr(a, "_create", lambda c, i: 1)
    monkeypatch.setattr(a, "_release", lambda o: None)
    monkeypatch.setattr(a, "_list", lambda e, f: [])
    monkeypatch.setattr(a, "_default_id", lambda e, f, r: asked.append((f, r)) or f"{f}:{r}")
    d = a.devices()
    assert d["defaults"] == {"output": {"console": "0:0", "multimedia": "0:1", "communications": "0:2"},
                             "input": {"console": "1:0", "multimedia": "1:1", "communications": "1:2"}}
    assert sorted(asked) == [(f, r) for f in (0, 1) for r in (0, 1, 2)]


def test_audio_miss_lists_what_exists_and_sets_nothing(win, tmp_path, monkeypatch):
    mod, _ = win
    set_to = []
    monkeypatch.setattr(mod.audio, "devices", lambda: {"outputs": OUTS, "inputs": []})
    monkeypatch.setattr(mod.audio, "set_default", set_to.append)
    with pytest.raises(core.Refused) as e:
        mod.Backend(core.Config(home=tmp_path)).run({"action": "audio_input", "name": "hyperx"})
    assert e.value.status == 404 and set_to == []


def test_volume_sets_then_reports_previous(win, tmp_path, monkeypatch):
    mod, _ = win
    calls = []

    def vol(level=None, mute=None):
        calls.append((level, mute))
        return {"level": 61 if level is None else level, "muted": bool(mute), "device": "Speakers"}

    monkeypatch.setattr(mod.audio, "volume", vol)
    b = mod.Backend(core.Config(home=tmp_path))
    r = b.run({"action": "volume", "level": 30})
    assert calls == [(None, None), (30, False)] and r["level"] == 30 and r["previous"] == 61
    calls.clear()
    assert b.run({"action": "volume"}) == {"level": 61, "muted": False, "device": "Speakers"} and len(calls) == 1


def test_settings_opens_the_uri(win, tmp_path, monkeypatch):
    mod, _ = win
    opened = []
    monkeypatch.setattr(mod.os, "startfile", opened.append, raising=False)
    a = core.parse_action(json.dumps({"action": "settings", "page": "bluetooth"}).encode())
    assert mod.Backend(core.Config(home=tmp_path)).run(a) == {"uri": "ms-settings:bluetooth"}
    assert opened == ["ms-settings:bluetooth"]


@pytest.fixture
def browser(win, monkeypatch):
    mod, _ = win
    st = {"windows": [[{"hwnd": 1, "exe": "msedge.exe", "title": "old"}]], "moved": [], "popen": []}

    def windows():
        return st["windows"].pop(0) if len(st["windows"]) > 1 else st["windows"][0]

    monkeypatch.setattr(mod, "list_windows", windows)
    monkeypatch.setattr(mod, "default_browser", lambda: r"C:\Edge\msedge.exe")
    monkeypatch.setattr(mod.subprocess, "Popen", lambda argv, **kw: st["popen"].append(argv))
    monkeypatch.setattr(mod, "monitors", lambda: core.order_monitors(RAW[:2]))
    monkeypatch.setattr(mod, "move_to", lambda h, m, mx: st["moved"].append((h, m["index"], mx)))
    st["front"] = []
    monkeypatch.setattr(mod, "bring", lambda h: st["front"].append(h) or True)
    return mod, st


def test_open_url_on_a_monitor_moves_the_new_window(browser, tmp_path):
    mod, st = browser
    old = {"hwnd": 1, "exe": "msedge.exe", "title": "old"}
    st["windows"] = [[old], [old], [old, {"hwnd": 2, "exe": "msedge.exe", "title": "Example"}]]
    r = mod.Backend(core.Config(home=tmp_path)).run({"action": "open_url", "url": "https://example.com", "monitor": 2})
    assert st["popen"] == [[r"C:\Edge\msedge.exe", "--new-window", "https://example.com"]]
    assert st["moved"] == [(2, 2, True)] and st["front"] == [2]
    assert r == {"browser": "msedge.exe", "hwnd": 2, "monitor": 2, "fallback": False, "front": True}


def test_open_url_monitor_past_the_last_falls_back(browser, tmp_path):
    mod, st = browser
    old = {"hwnd": 1, "exe": "msedge.exe", "title": "old"}
    st["windows"] = [[old], [old, {"hwnd": 3, "exe": "msedge.exe", "title": "x"}]]
    r = mod.Backend(core.Config(home=tmp_path)).run(
        {"action": "open_url", "url": "https://e.com", "monitor": 5, "maximize": False})
    assert st["moved"] == [(3, 1, False)] and r["fallback"] is True and r["monitor"] == 1


def test_open_url_no_new_window_is_504(browser, tmp_path, monkeypatch):
    mod, st = browser
    clock = iter(range(0, 100))
    monkeypatch.setattr(mod.time, "monotonic", lambda: next(clock))
    with pytest.raises(core.Refused) as e:
        mod.Backend(core.Config(home=tmp_path)).run({"action": "open_url", "url": "https://e.com", "new_window": True})
    assert e.value.status == 504 and st["moved"] == []


def test_open_url_plain_still_uses_the_shell(browser, tmp_path, monkeypatch):
    mod, st = browser
    opened = []
    monkeypatch.setattr(mod.os, "startfile", opened.append, raising=False)
    assert mod.Backend(core.Config(home=tmp_path)).run({"action": "open_url", "url": "https://e.com"}) == {}
    assert opened == ["https://e.com"] and st["popen"] == []


def test_move_window_by_title(browser, tmp_path):
    mod, st = browser
    st["windows"] = [[{"hwnd": 9, "exe": "notepad.exe", "title": "Untitled - Notepad"}]]
    mod._title = lambda h: "Untitled - Notepad"
    r = mod.Backend(core.Config(home=tmp_path)).run({"action": "move_window", "title": "notepad", "monitor": 2})
    assert st["moved"] == [(9, 2, False)] and r["monitor"] == 2 and r["fallback"] is False
    assert st["front"] == [9] and r["front"] is True


class Pipe:
    """A pipe a fake child writes: its chunks, then EOF, or (never_closes) a read that blocks
    for good, like a pipe an orphan outside the job keeps open."""

    def __init__(self, chunks, never_closes=False):
        self.chunks, self.never_closes, self.closed, self.read = iter(chunks), never_closes, False, 0

    def read1(self, n):
        for c in self.chunks:
            self.read += len(c)
            return c
        if self.never_closes:
            threading.Event().wait()
        return b""

    def close(self):
        self.closed = True


class FakeProc:
    """hang: powershell itself runs past the timeout. stuck: powershell exits at once but a
    pipe never closes, not even after the kill. flood: stdout writes that many bytes."""

    def __init__(self, argv, script_seen, hang=False, stuck=False, flood=0, **kw):
        self.argv, self.pid, self.returncode, self.hang = argv, 4242, None, hang
        self.kw, self._handle, self.waited = kw, 555, False
        line = b"x" * 99 + b"\n"
        out = (line for _ in range(flood // 100)) if flood else ["Mittwoch, 4. November 2026\r\n".encode()]
        self.stdout, self.stderr = Pipe(out, never_closes=stuck), Pipe([b"warn: \xc3\xa9"])
        script_seen.append(Path(argv[-1]).read_bytes())

    def wait(self, timeout=None):
        self.waited = True
        if self.hang and timeout is not None:
            time.sleep(min(timeout, 0.05))  # a real wait would block the whole timeout
            raise subprocess.TimeoutExpired(self.argv, timeout)
        self.returncode = 3
        return 3


@pytest.fixture
def ps(win, tmp_path, monkeypatch):
    """The win backend with a fake Popen and a working job object (handle 77)."""
    mod, fake = win
    fake.reset_mock()
    fake.CreateJobObjectW.return_value = 77
    fake.SetInformationJobObject.return_value = 1
    fake.AssignProcessToJobObject.return_value = 1
    fake.NtResumeProcess.return_value = 0
    st = {"procs": [], "seen": [], "opts": {}}

    def popen(argv, **kw):
        st["procs"].append(FakeProc(argv, st["seen"], **st["opts"], **kw))
        return st["procs"][-1]
    monkeypatch.setattr(mod.subprocess, "Popen", popen)
    monkeypatch.setattr(mod.subprocess, "run", lambda *a, **kw: pytest.fail("no taskkill: the job kills"))
    return mod, fake, st, lambda a: mod.Backend(core.Config(home=tmp_path)).run({"action": "powershell", **a})


def test_powershell_runs_a_bom_file_and_cleans_up(ps, tmp_path):
    mod, fake, st, run = ps
    r = run({"script": "Get-Date; 'é'", "timeout_s": 5})
    assert r == {"exit_code": 3, "timed_out": False, "stdout": "Mittwoch, 4. November 2026\r\n",
                 "stderr": "warn: é", "truncated": False}
    seen = st["seen"]
    assert seen[0].startswith(b"\xef\xbb\xbf" + core.PS_PRELUDE.encode()) and seen[0].endswith("Get-Date; 'é'".encode())
    assert list((tmp_path / "ps").iterdir()) == []


def test_powershell_starts_suspended_in_the_job_and_closes_it(ps):
    mod, fake, st, run = ps
    run({"script": "Get-Date", "timeout_s": 5})
    proc = st["procs"][0]
    assert proc.kw["creationflags"] & mod.CREATE_SUSPENDED
    fake.AssignProcessToJobObject.assert_called_once_with(77, 555)
    fake.NtResumeProcess.assert_called_once_with(555)
    fake.TerminateJobObject.assert_not_called()
    fake.CloseHandle.assert_called_once_with(77)
    # kill on close while it runs, cleared after a normal exit so what it started survives
    flags = [c.args[2]._obj.BasicLimitInformation.LimitFlags for c in fake.SetInformationJobObject.call_args_list]
    assert flags == [mod.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0]


def test_powershell_timeout_kills_the_job(ps):
    mod, fake, st, run = ps
    st["opts"] = {"hang": True}
    r = run({"script": "sleep 99", "timeout_s": 1})
    assert r["timed_out"] is True and r["exit_code"] is None and r["stdout"].startswith("Mittwoch")
    fake.TerminateJobObject.assert_called_once_with(77, 1)
    fake.CloseHandle.assert_called_once_with(77)


def test_powershell_timeout_is_a_hard_bound_when_an_orphan_keeps_the_pipes(ps, tmp_path, monkeypatch):
    """Start-Process -NoNewWindow with a child outside the job: powershell exits, the pipe
    never closes, even after the kill. The reply still comes back within timeout_s plus
    DRAIN_S, with what was read, from a reader thread that never ends."""
    mod, fake, st, run = ps
    monkeypatch.setattr(mod, "DRAIN_S", 0.3)
    st["opts"] = {"stuck": True}
    t = time.monotonic()
    r = run({"script": "Start-Process -NoNewWindow ping.exe", "timeout_s": 1})
    took = time.monotonic() - t
    assert 1 <= took < 1 + 0.3 + 0.5
    assert r == {"exit_code": None, "timed_out": True, "stdout": "Mittwoch, 4. November 2026\r\n",
                 "stderr": "warn: é", "truncated": False}
    fake.TerminateJobObject.assert_called_once_with(77, 1)
    fake.CloseHandle.assert_called_once_with(77)
    assert st["procs"][0].stderr.closed  # the pipe that ended was closed by its reader
    assert list((tmp_path / "ps").iterdir()) == []


def test_powershell_output_is_bounded_while_it_runs(ps):
    """A script that prints 50 times the clip limit: the daemon keeps at most the limit (the
    tail) and says truncated; the reader read every byte, so the child never blocked."""
    mod, fake, st, run = ps
    st["opts"] = {"flood": 50 * core.PS_CLIP}
    kept = []
    real = mod._Tail._run

    def watch(self):
        real(self)
        kept.append(len(self.buf))
    with mock.patch.object(mod._Tail, "_run", watch):
        r = run({"script": "1..1e6 | % { 'x' * 99 }", "timeout_s": 5})
    assert r["truncated"] is True and r["timed_out"] is False and r["exit_code"] == 3
    assert len(r["stdout"].encode()) <= core.PS_CLIP and r["stdout"].endswith("x\n")
    assert max(kept) <= core.PS_CLIP and st["procs"][0].stdout.read >= 50 * core.PS_CLIP - 100


def test_tail_never_holds_more_than_the_limit(win):
    """The bound holds at every read, not only at the end: the buffer is trimmed per chunk."""
    mod, _ = win
    peak = []

    class Spy(Pipe):
        def read1(self, n):
            peak.append(len(tail.buf))
            return super().read1(n)
    pipe = Spy([b"y" * 4096] * 200)
    tail = mod._Tail.__new__(mod._Tail)
    tail.f, tail.limit, tail.buf, tail.cut = pipe, 10_000, bytearray(), False
    tail._run()
    assert max(peak) <= 10_000 and len(tail.buf) == 10_000 and tail.cut and pipe.closed


@pytest.mark.parametrize("broken", ["CreateJobObjectW", "SetInformationJobObject"])
def test_powershell_without_a_job_refuses_and_starts_nothing(ps, broken, tmp_path):
    mod, fake, st, run = ps
    getattr(fake, broken).return_value = 0
    with pytest.raises(core.Refused) as e:
        run({"script": "Get-Date", "timeout_s": 5})
    assert e.value.status == 500 and st["procs"] == []
    assert fake.CloseHandle.call_count == (broken == "SetInformationJobObject")
    assert not (tmp_path / "ps").exists() or list((tmp_path / "ps").iterdir()) == []


@pytest.mark.parametrize("broken", ["AssignProcessToJobObject", "NtResumeProcess"])
def test_powershell_outside_the_job_is_killed_unstarted(ps, broken, tmp_path):
    mod, fake, st, run = ps
    getattr(fake, broken).return_value = 0 if broken == "AssignProcessToJobObject" else -1
    with pytest.raises(core.Refused) as e:
        run({"script": "Get-Date", "timeout_s": 5})
    proc = st["procs"][0]
    assert e.value.status == 500 and proc.stdout.read == 0 and proc.waited
    fake.TerminateProcess.assert_called_once_with(555, 1)
    fake.CloseHandle.assert_called_once_with(77)
    assert list((tmp_path / "ps").iterdir()) == []
