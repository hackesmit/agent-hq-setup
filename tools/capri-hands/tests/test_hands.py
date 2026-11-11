import http.client
import json
import struct
import sys
import threading
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hands import core  # noqa: E402
from hands.server import HandsServer  # noqa: E402

TOKEN = "t0ken-abc"


class FakeBackend:
    def __init__(self):
        self.ran = []

    def run(self, action):
        self.ran.append(action)
        if action["action"] == "open_app" and action["name"] == "nope":
            raise core.Refused(404, "no app by that name")
        if action["action"] == "click" and action["x"] == 666:
            raise RuntimeError("boom")
        return {"echo": action["action"]}


@pytest.fixture
def hands(tmp_path):
    cfg = core.Config(home=tmp_path, port=0)
    cfg.token_file.write_text(TOKEN + "\n")
    backend = FakeBackend()
    srv = HandsServer(cfg, backend)
    cfg.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    yield cfg, backend
    srv.shutdown()
    srv.server_close()


def req(cfg, method="POST", path="/action", body=b"", headers=None, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", cfg.port, timeout=5)
    h = {} if token is None else {core.TOKEN_HEADER: token}
    h.update(headers or {})
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
    conn.request(method, path, body=body if method == "POST" else None, headers=h)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r.status, data


def log(cfg):
    return [json.loads(x) for x in cfg.log_file.read_text().splitlines()] if cfg.log_file.exists() else []


# ---- token ---------------------------------------------------------------

def test_good_token_runs(hands):
    cfg, be = hands
    s, d = req(cfg, body={"action": "list_windows"})
    assert s == 200 and json.loads(d) == {"ok": True, "echo": "list_windows"}
    assert be.ran == [{"action": "list_windows"}]


@pytest.mark.parametrize("token", [None, "", "wrong", TOKEN + "x", TOKEN[:-1]])
def test_wrong_or_missing_token_refused(hands, token):
    cfg, be = hands
    s, _ = req(cfg, body={"action": "list_windows"}, token=token)
    assert s == 401 and be.ran == []


def test_missing_token_file_refuses_everything(hands):
    cfg, be = hands
    cfg.token_file.unlink()
    assert req(cfg, body={"action": "list_windows"})[0] == 401
    assert be.ran == []


@pytest.mark.parametrize("content", ["", "   \n", "\n"])
def test_empty_token_file_refuses_even_empty_header(hands, content):
    cfg, be = hands
    cfg.token_file.write_text(content)
    assert req(cfg, body={"action": "list_windows"}, token="")[0] == 401
    assert req(cfg, body={"action": "list_windows"}, token=content.strip() or " ")[0] == 401
    assert be.ran == []


def test_token_in_query_string_refused(hands):
    cfg, be = hands
    s, _ = req(cfg, path=f"/action?token={TOKEN}", body={"action": "list_windows"})
    assert s == 400
    s, _ = req(cfg, path=f"/action?token={TOKEN}", body={"action": "list_windows"}, token=None)
    assert s == 400 and be.ran == []


def test_browser_origin_refused(hands):
    cfg, be = hands
    s, _ = req(cfg, body={"action": "list_windows"}, headers={"Origin": "https://evil.example"})
    assert s == 403 and be.ran == []


def test_token_compare_is_constant_time_helper():
    assert core.token_ok("a", "a") and not core.token_ok("a", "b")
    assert not core.token_ok(None, "") and not core.token_ok("", "") and not core.token_ok("a", None)


def test_read_token(tmp_path):
    assert core.read_token(tmp_path / "missing") is None
    (tmp_path / "t").write_bytes(b"\xff\xfe")
    assert core.read_token(tmp_path / "t") is None
    (tmp_path / "t").write_text(" abc \n")
    assert core.read_token(tmp_path / "t") == "abc"


# ---- body ----------------------------------------------------------------

@pytest.mark.parametrize("body", [b"not json", b"{", b"\xff\xfe", b"[1,2]", b'"x"', b"null"])
def test_bad_json_refused(hands, body):
    cfg, be = hands
    assert req(cfg, body=body)[0] == 400 and be.ran == []


def test_oversized_body_refused_without_reading(hands):
    cfg, be = hands
    conn = http.client.HTTPConnection("127.0.0.1", cfg.port, timeout=5)
    conn.putrequest("POST", "/action")
    conn.putheader(core.TOKEN_HEADER, TOKEN)
    conn.putheader("Content-Length", str(core.MAX_BODY + 1))
    conn.endheaders()
    r = conn.getresponse()
    assert r.status == 413
    conn.close()
    big = json.dumps({"action": "type_text", "text": "x" * core.MAX_BODY}).encode()
    assert req(cfg, body=big)[0] == 413 and be.ran == []


def test_chunked_and_missing_length_refused(hands):
    cfg, be = hands
    for extra in ({"Transfer-Encoding": "chunked"}, {}):
        conn = http.client.HTTPConnection("127.0.0.1", cfg.port, timeout=5)
        conn.putrequest("POST", "/action", skip_accept_encoding=True)
        conn.putheader(core.TOKEN_HEADER, TOKEN)
        for k, v in extra.items():
            conn.putheader(k, v)
        conn.endheaders()
        assert conn.getresponse().status == 411
        conn.close()
    assert be.ran == []


def test_exactly_64k_accepted(hands):
    cfg, be = hands
    pad = core.MAX_BODY - len(json.dumps({"action": "type_text", "text": ""}))
    body = json.dumps({"action": "type_text", "text": "x" * pad}).encode()
    assert len(body) == core.MAX_BODY
    assert req(cfg, body=body)[0] == 200


# ---- actions -------------------------------------------------------------

@pytest.mark.parametrize("body", [{"action": "rm_rf"}, {"action": 3}, {}, {"action": "run"}, {"action": "__class__"}])
def test_unknown_action_refused(hands, body):
    cfg, be = hands
    assert req(cfg, body=body)[0] == 404 and be.ran == []


@pytest.mark.parametrize("body", [
    {"action": "open_url", "url": "file:///C:/Windows/System32/calc.exe"},
    {"action": "open_url", "url": "javascript:alert(1)"},
    {"action": "open_url", "url": "ms-settings:"},
    {"action": "open_url", "url": "https://"},
    {"action": "open_url"},
    {"action": "open_url", "url": "https://example.com", "extra": 1},
    {"action": "click", "x": True, "y": 3},
    {"action": "click", "x": "1", "y": 3},
    {"action": "click", "x": 1, "y": 3, "button": "side"},
    {"action": "key", "combo": "ctrl+nosuchkey"},
    {"action": "key", "combo": "ctrl++"},
    {"action": "key", "combo": "a+b"},
    {"action": "media", "command": "shutdown"},
    {"action": "focus_window"},
    {"action": "open_app", "name": "  "},
    {"action": "type_text", "text": 5},
    {"action": "type_text", "text": "x", "hwnd": "12"},
    {"action": "key", "combo": "enter", "hwnd": True},
])
def test_bad_fields_refused(hands, body):
    cfg, be = hands
    assert req(cfg, body=body)[0] == 400 and be.ran == []


def test_backend_refusal_and_crash_reported(hands):
    cfg, be = hands
    assert req(cfg, body={"action": "open_app", "name": "nope"})[0] == 404
    s, d = req(cfg, body={"action": "click", "x": 666, "y": 1})
    assert s == 500 and "boom" in json.loads(d)["error"]
    assert req(cfg, body={"action": "list_windows"})[0] == 200  # still serving


def test_log_never_keeps_typed_text(hands):
    cfg, _ = hands
    secret = "my password is hunter2"
    assert req(cfg, body={"action": "type_text", "text": secret})[0] == 200
    assert req(cfg, body={"action": "open_url", "url": "https://example.com"})[0] == 200
    text = cfg.log_file.read_text()
    assert "hunter2" not in text
    recs = log(cfg)
    assert recs[0]["action"] == "type_text" and recs[0]["target"] == len(secret)
    assert recs[1]["target"] == "https://example.com"


def test_refusals_logged_without_body(hands):
    cfg, _ = hands
    req(cfg, body={"action": "type_text", "text": "hunter2"}, token="bad")
    assert "hunter2" not in cfg.log_file.read_text()
    assert log(cfg)[-1]["status"] == 401


# ---- shots ---------------------------------------------------------------

def test_shot_get(hands):
    cfg, _ = hands
    cfg.shots.mkdir()
    (cfg.shots / "shot-20261104-120000-001.png").write_bytes(b"PNGDATA")
    s, d = req(cfg, "GET", "/shot/shot-20261104-120000-001.png")
    assert s == 200 and d == b"PNGDATA"
    assert req(cfg, "GET", "/shot/shot-20261104-120000-001.png", token="bad")[0] == 401


@pytest.mark.parametrize("path", ["/shot/../token", "/shot/..%2ftoken", "/shot/token", "/token", "/shot/", "/"])
def test_shot_paths_refused(hands, path):
    cfg, _ = hands
    s, d = req(cfg, "GET", path)
    assert s == 404 and TOKEN.encode() not in d


def test_other_methods_refused(hands):
    cfg, _ = hands
    assert req(cfg, "PUT", "/action")[0] == 405
    assert req(cfg, "DELETE", "/action", token="bad")[0] == 401


# ---- bind ----------------------------------------------------------------

@pytest.mark.parametrize("host", ["0.0.0.0", "", "localhost", "::", "100.64.0.1", "127.0.0.2"])
def test_non_loopback_bind_refused(tmp_path, host):
    with pytest.raises(ValueError):
        HandsServer(core.Config(home=tmp_path, port=0), FakeBackend(), host=host)


def test_bound_to_loopback(hands):
    cfg, _ = hands
    # The fixture server is the default: its socket address is 127.0.0.1.
    srv = HandsServer(core.Config(home=cfg.home, port=0), FakeBackend())
    try:
        assert srv.server_address[0] == "127.0.0.1"
    finally:
        srv.server_close()


# ---- pure helpers --------------------------------------------------------

def test_parse_combo():
    assert core.parse_combo("ctrl+l") == [0xA2, ord("L")]
    assert core.parse_combo("L+Ctrl") == [0xA2, ord("L")]
    assert core.parse_combo("alt+f4") == [0xA4, 0x73]
    assert core.parse_combo("enter") == [0x0D]
    assert core.parse_combo("ctrl+shift+t") == [0xA2, 0xA0, ord("T")]
    assert core.parse_combo("win+r") == [0x5B, ord("R")]
    for bad in ("", "+", "ctrl+ctrl", "a+b", "ctrl+bogus"):
        with pytest.raises(core.Refused):
            core.parse_combo(bad)


APPS = [("Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), ("Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"),
        ("Notepad++", "{6D809377}\\Notepad++\\notepad++.exe"), ("Microsoft Edge", "MSEdge"),
        ("Brave", "Brave"), ("Visual Studio Code", "Microsoft.VisualStudioCode"), ("WhatsApp", "5319275A.WhatsAppDesktop!App")]


@pytest.mark.parametrize("q,name", [
    ("notepad", "Notepad"), ("Notepad", "Notepad"), ("spotify", "Spotify"), ("edge", "Microsoft Edge"),
    ("visual studio", "Visual Studio Code"), ("whats app", "WhatsApp"), ("whatsap", "WhatsApp"),
    ("spotfy", "Spotify"), ("excel", None), ("", None),
])
def test_match_app(q, name):
    hit = core.match_app(q, APPS)
    assert (hit[0] if hit else None) == name


def test_png_roundtrip():
    w, h = 3, 2
    bgra = bytes([0, 0, 255, 255] * (w * h))  # red
    png = core.bgra_to_png(bgra, w, h)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    ihdr_w, ihdr_h = struct.unpack(">II", png[16:24])
    assert (ihdr_w, ihdr_h) == (w, h)
    idat_len = struct.unpack(">I", png[33:37])[0]
    raw = zlib.decompress(png[41:41 + idat_len])
    assert raw == (b"\x00" + b"\xff\x00\x00" * w) * h


def test_bind_retries_then_gives_up():
    from hands.app import bind

    calls = []

    def make():
        calls.append(1)
        if len(calls) < 3:
            raise OSError(10048, "in use")
        return "srv"

    assert bind(make, tries=5, sleep=lambda s: None) == "srv" and len(calls) == 3
    calls.clear()
    with pytest.raises(OSError):
        bind(lambda: (_ for _ in ()).throw(OSError("in use")), tries=2, sleep=lambda s: None)


def test_log_targets_with_hwnd_keep_no_text():
    assert core.log_target({"action": "type_text", "text": "secret", "hwnd": 5}) == 6
    assert core.log_target({"action": "screenshot", "hwnd": 5}) == 5
    assert core.log_target({"action": "screenshot"}) is None
    assert core.log_target({"action": "key", "combo": "enter", "hwnd": 5}) == "enter"


# ---- lucy round 1 (hq-63nvj.6) --------------------------------------------

def test_exact_start_menu_name_beats_normalized_collision():
    assert core.match_app("Notepad++", APPS)[0] == "Notepad++"
    assert core.match_app("notepad++", APPS)[0] == "Notepad++"
    assert core.match_app("  NOTEPAD++ ", APPS)[0] == "Notepad++"
    assert core.match_app("Notepad", APPS)[0] == "Notepad"


def test_send_guarded_stops_on_focus_loss():
    sent, checks = [], iter([True, True, True, False, True])
    with pytest.raises(core.Refused) as e:
        core.send_guarded(["a", "b", "c", "d", "e"], sent.append, lambda: next(checks), 5)
    assert sent == ["a", "b", "c"] and e.value.status == 409 and "after 3 of 5" in e.value.reason


def test_send_guarded_checks_before_first_char():
    sent = []
    with pytest.raises(core.Refused, match="after 0 of 2"):
        core.send_guarded(["a", "b"], sent.append, lambda: False, 2)
    assert sent == [] and core.send_guarded(["a", "b"], sent.append, lambda: True, 2) == 2


@pytest.fixture
def win(monkeypatch):
    """hands.win imported on hqbox against a fake user32: GetForegroundWindow answers from
    a script, SendInput counts what went out. Exercises the real typing path."""
    import ctypes
    import importlib
    from unittest import mock

    fake = mock.MagicMock()
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **kw: fake, raising=False)
    monkeypatch.setattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 0, raising=False)
    sys.modules.pop("hands.win", None)
    mod = importlib.import_module("hands.win")
    monkeypatch.setattr(mod, "bring", lambda hwnd: True)
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)
    fake.SendInput.side_effect = lambda n, arr, size: n
    yield mod, fake
    sys.modules.pop("hands.win", None)


def test_type_text_stops_when_focus_moves_mid_text(win, tmp_path):
    mod, user32 = win
    fg = iter([42] * 4 + [99] * 100)  # _aim check, then chars 1..3 in front, then the owner switched
    user32.GetForegroundWindow.side_effect = lambda: next(fg)
    b = mod.Backend(core.Config(home=tmp_path))
    with pytest.raises(core.Refused) as e:
        b.run({"action": "type_text", "hwnd": 42, "text": "hello world"})
    assert e.value.status == 409 and "after 3 of 11" in e.value.reason
    assert user32.SendInput.call_count == 3


def test_type_text_full_when_focus_stays(win, tmp_path):
    mod, user32 = win
    user32.GetForegroundWindow.return_value = 42
    user32.GetForegroundWindow.side_effect = None
    assert mod.Backend(core.Config(home=tmp_path)).run({"action": "type_text", "hwnd": 42, "text": "a\r\nb"}) == {"chars": 3}
    assert user32.SendInput.call_count == 3


def test_key_refused_when_focus_moves_after_aim(win, tmp_path):
    mod, user32 = win
    fg = iter([42, 99, 99])
    user32.GetForegroundWindow.side_effect = lambda: next(fg)
    with pytest.raises(core.Refused, match="before the key"):
        mod.Backend(core.Config(home=tmp_path)).run({"action": "key", "hwnd": 42, "combo": "ctrl+w"})
    assert user32.SendInput.call_count == 0


def test_idle_connection_does_not_block_calls(hands):
    import socket
    import time

    cfg, _ = hands
    stall = socket.create_connection(("127.0.0.1", cfg.port))
    stall.sendall(b"POST /action HTTP/1.1\r\n")  # never finishes the request
    silent = socket.create_connection(("127.0.0.1", cfg.port))  # sends nothing at all
    try:
        t0 = time.monotonic()
        status, _ = req(cfg, body={"action": "list_windows"})
        assert status == 200 and time.monotonic() - t0 < 1.0
    finally:
        stall.close()
        silent.close()


def test_handler_read_timeout_is_finite():
    from hands.server import Handler, HandsServer
    assert 0 < Handler.timeout <= 10 and HandsServer.daemon_threads and not HandsServer.allow_reuse_address


def test_readme_install_copies_every_helper():
    readme = (Path(__file__).resolve().parents[1] / "README.md").read_text()
    install = next(line for line in readme.splitlines() if "mkdir -p /mnt/george/Users/owner/capri-hands/hands" in line)
    helpers = {p.suffix for p in (Path(__file__).resolve().parents[1] / "hands").iterdir() if p.is_file()}
    for suffix in helpers:
        assert f"hands/*{suffix}" in install, f"install line does not copy hands/*{suffix}"


@pytest.mark.parametrize("rc,out,err,msg", [
    (1, "", "Unable to find type", "exit 1"),
    (0, "", "", "exit 0"),
    (0, "not json\n", "", "no JSON"),
    (0, '{"current": null}', "", "no sessions"),
    (1, '{"current": null, "sessions": []}', "boom", "exit 1"),
])
def test_media_status_helper_failure_is_explicit(rc, out, err, msg):
    with pytest.raises(RuntimeError, match=msg):
        core.parse_media_status(rc, out, err)


def test_media_status_parses_reply():
    assert core.parse_media_status(0, 'noise\n{"current": "Spotify.exe", "sessions": []}\n', "") == \
        {"current": "Spotify.exe", "sessions": []}
    one = core.parse_media_status(0, '{"current": null, "sessions": {"app": "x", "status": "Paused"}}', "")
    assert one["sessions"] == [{"app": "x", "status": "Paused"}]


def test_media_status_missing_helper_is_500(win, tmp_path, monkeypatch):
    mod, _ = win
    monkeypatch.setattr(mod.Path, "is_file", lambda self: False)
    with pytest.raises(RuntimeError, match="helper missing"):
        mod.Backend(core.Config(home=tmp_path)).run({"action": "media_status"})


# ---- explicit pause and play (hq-63nvj.9) --------------------------------

SPOTIFY = {"hwnd": 526252, "exe": "spotify.exe", "cls": "Chrome_WidgetWin_1", "title": "Spotify Premium",
           "visible": True, "owned": False}


def _w(**kw):
    return {**SPOTIFY, **kw}


@pytest.mark.parametrize("cmd", ["pause", "play", "play_pause"])
def test_media_explicit_commands_accepted(cmd):
    assert core.parse_action(json.dumps({"action": "media", "command": cmd}).encode())["command"] == cmd


def test_pick_player():
    helpers = [_w(hwnd=1, cls="Chrome_WidgetWin_0", title=""), _w(hwnd=2, cls="GDI+ Hook Window Class"),
               _w(hwnd=3, title=""), _w(hwnd=4, owned=True), _w(hwnd=5, exe="brave.exe")]
    assert core.pick_player(helpers) is None
    assert core.pick_player([]) is None
    assert core.pick_player(helpers + [_w(hwnd=7, visible=False), _w(hwnd=8)]) == 8
    assert core.pick_player([_w(hwnd=7, visible=False)]) == 7  # closed to the tray


@pytest.fixture
def player(win, monkeypatch):
    """win with one Spotify window; SendMessageTimeoutW records (hwnd, msg, lparam) and
    answers handled unless the test sets handled to 0."""
    mod, user32 = win
    state = {"windows": [SPOTIFY], "handled": 1, "sent": []}
    monkeypatch.setattr(mod, "player_windows", lambda: state["windows"])

    def smto(hwnd, msg, wparam, lparam, flags, timeout, res):
        state["sent"].append((hwnd, msg, lparam))
        res._obj.value = state["handled"]
        return 1
    user32.SendMessageTimeoutW.side_effect = smto
    return mod, user32, state


@pytest.mark.parametrize("cmd,code", [("pause", 47), ("play", 46)])
def test_pause_and_play_are_explicit_appcommands(player, tmp_path, cmd, code):
    mod, user32, state = player
    b = mod.Backend(core.Config(home=tmp_path))
    for _ in range(2):  # a repeat sends the same explicit command, never a toggle
        assert b.run({"action": "media", "command": cmd}) == {"player": "Spotify", "hwnd": 526252}
    assert state["sent"] == [(526252, 0x0319, code << 16)] * 2
    assert user32.SendInput.call_count == 0  # no keystroke, no focus change


def test_pause_without_player_is_explicit_error(player, tmp_path):
    mod, user32, state = player
    state["windows"] = []
    with pytest.raises(core.Refused) as e:
        mod.Backend(core.Config(home=tmp_path)).run({"action": "media", "command": "pause"})
    assert e.value.status == 404 and "Spotify" in e.value.reason
    assert state["sent"] == [] and user32.SendInput.call_count == 0


def test_pause_not_handled_is_error(player, tmp_path):
    mod, _, state = player
    state["handled"] = 0
    with pytest.raises(RuntimeError, match="did not handle"):
        mod.Backend(core.Config(home=tmp_path)).run({"action": "media", "command": "pause"})


def test_play_pause_still_toggles_with_the_key(player, tmp_path):
    mod, user32, state = player
    mod.Backend(core.Config(home=tmp_path)).run({"action": "media", "command": "play_pause"})
    assert state["sent"] == [] and user32.SendInput.call_count == 2  # key down, key up


# ---- best-effort focus guard (hq-63nvj.7) --------------------------------

def test_focus_change_between_check_and_send_is_not_caught(win, tmp_path):
    """Documents the best-effort contract: the owner switches windows right after the check for
    character 2 passes, so character 2 lands in his window; the check for character 3 stops
    the rest and the 409 counts the 2 that went out."""
    mod, user32 = win
    state = {"fg": 42, "checks": 0, "landed": []}

    def fg():
        state["checks"] += 1
        now = state["fg"]
        if state["checks"] == 3:  # _aim, char 1, char 2: the owner switches after this check
            state["fg"] = 99
        return now

    def send(n, arr, size):
        state["landed"].append(state["fg"])
        return n
    user32.GetForegroundWindow.side_effect = fg
    user32.SendInput.side_effect = send
    with pytest.raises(core.Refused) as e:
        mod.Backend(core.Config(home=tmp_path)).run({"action": "type_text", "hwnd": 42, "text": "hello"})
    assert state["landed"] == [42, 99]  # one character reached the window the owner moved to
    assert e.value.status == 409 and "after 2 of 5" in e.value.reason


def test_409_mid_text_reply_carries_sent_count(win, tmp_path):
    """Through the real server: the 409 body names the count so a caller resends only the
    rest; the log keeps the reason, never the text."""
    mod, user32 = win
    fg = iter([42] * 4 + [99] * 100)
    user32.GetForegroundWindow.side_effect = lambda: next(fg)
    cfg = core.Config(home=tmp_path, port=0)
    cfg.token_file.write_text(TOKEN + "\n")
    srv = HandsServer(cfg, mod.Backend(cfg))
    cfg.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    try:
        status, data = req(cfg, body={"action": "type_text", "hwnd": 42, "text": "secret word"})
    finally:
        srv.shutdown()
        srv.server_close()
    reply = json.loads(data)
    assert status == 409 and reply["ok"] is False and "after 3 of 11" in reply["error"]
    assert "secret" not in cfg.log_file.read_text()
