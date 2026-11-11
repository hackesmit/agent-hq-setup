"""Pure logic for Capri hands: token, request checks, action schema, key combos, app match.

No Windows calls here, so every refusal path is testable on hqbox.
"""
from __future__ import annotations

import difflib
import hmac
import json
import ntpath
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

MAX_BODY = 64 * 1024
LOOPBACK = "127.0.0.1"
DEFAULT_PORT = 47615
TOKEN_HEADER = "X-Hands-Token"


def home() -> Path:
    """%LOCALAPPDATA%\\capri-hands on George; CAPRI_HANDS_HOME overrides (tests)."""
    env = os.environ.get("CAPRI_HANDS_HOME")
    if env:
        return Path(env)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "capri-hands"


@dataclass
class Config:
    home: Path
    port: int = DEFAULT_PORT

    @property
    def token_file(self) -> Path:
        return self.home / "token"

    @property
    def log_file(self) -> Path:
        return self.home / "hands.jsonl"

    @property
    def shots(self) -> Path:
        return self.home / "shots"


def read_token(path: Path) -> str | None:
    """The token, or None when the file is missing, unreadable or empty (fail closed)."""
    try:
        tok = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return tok or None


def token_ok(expected: str | None, given: str | None) -> bool:
    if not expected or not given:
        return False
    return hmac.compare_digest(expected.encode(), given.encode())


class Refused(Exception):
    """A request refused before any action runs: HTTP status plus a short reason."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def check_bind(host: str) -> None:
    if host != LOOPBACK:
        raise ValueError(f"hands binds {LOOPBACK} only, not {host!r}")


def check_request(*, path: str, headers, expected_token: str | None) -> str:
    """Refuse a bad request before reading the body. Returns the path without query."""
    parts = urlsplit(path)
    if parts.query:
        # A token in a URL ends up in logs and history; any query is refused.
        raise Refused(400, "query string refused")
    if headers.get("Origin") is not None:
        raise Refused(403, "browser origin refused")
    if not token_ok(expected_token, headers.get(TOKEN_HEADER)):
        raise Refused(401, "token refused")
    return parts.path


def body_length(headers) -> int:
    if headers.get("Transfer-Encoding"):
        raise Refused(411, "chunked body refused")
    raw = headers.get("Content-Length")
    if raw is None:
        raise Refused(411, "content-length required")
    try:
        n = int(raw)
    except ValueError:
        raise Refused(400, "bad content-length") from None
    if n < 0:
        raise Refused(400, "bad content-length")
    if n > MAX_BODY:
        raise Refused(413, "body over 64 KB")
    return n


# ---- action schema -------------------------------------------------------

MEDIA = {"play_pause": 0xB3, "next": 0xB0, "prev": 0xB1, "volume_up": 0xAF, "volume_down": 0xAE, "mute": 0xAD}
# Explicit pause and play: WM_APPCOMMAND to the Spotify window, never the play_pause toggle,
# so pause while paused stays paused (hq-63nvj.9). Measured on George 2026-11-04: Spotify
# honors both, a repeat is a no-op, the send takes about 0.1 ms (SMTC through PowerShell: 210 ms).
APPCOMMAND = {"pause": 47, "play": 46}  # APPCOMMAND_MEDIA_PAUSE, APPCOMMAND_MEDIA_PLAY
PLAYER_EXE = "spotify.exe"
PLAYER_CLASS = "Chrome_WidgetWin_1"  # Spotify's main window; its other top-level windows are helpers

# Field name -> (type, required). Unknown fields are refused so a typo never runs half an action.
SCHEMA: dict[str, dict[str, tuple[type | tuple, bool]]] = {
    "open_url": {"url": (str, True)},
    "open_app": {"name": (str, True)},
    "focus_window": {"title": (str, False), "hwnd": (int, False)},
    "list_windows": {},
    "type_text": {"text": (str, True), "hwnd": (int, False)},
    "key": {"combo": (str, True), "hwnd": (int, False)},
    "click": {"x": (int, True), "y": (int, True), "button": (str, False), "double": (bool, False)},
    "screenshot": {"hwnd": (int, False)},
    "media": {"command": (str, True)},
    "media_status": {},
    "spotify_play": {"query": (str, True)},
    # hq-63nvj.13: audio, monitors, settings, powershell
    "audio_devices": {},
    "audio_output": {"name": (str, True), "fuzzy": (bool, False), "role": (int, False)},
    "audio_input": {"name": (str, True), "fuzzy": (bool, False), "role": (int, False)},
    "volume": {"level": (int, False), "command": (str, False), "step": (int, False)},
    "monitors": {},
    "move_window": {"hwnd": (int, False), "title": (str, False), "monitor": (int, True), "maximize": (bool, False)},
    "settings": {"page": (str, True)},
    "powershell": {"script": (str, True), "timeout_s": (int, False)},
}
SCHEMA["open_url"] = {"url": (str, True), "monitor": (int, False), "new_window": (bool, False),
                      "maximize": (bool, False)}

VOLUME_COMMANDS = ("up", "down", "mute", "unmute")
PS_TIMEOUT_DEFAULT, PS_TIMEOUT_MAX = 30, 60


def parse_action(raw: bytes) -> dict:
    """Body bytes -> a validated action dict. Raises Refused(400/404)."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Refused(400, "body is not JSON") from None
    if not isinstance(data, dict):
        raise Refused(400, "body must be a JSON object")
    name = data.get("action")
    if not isinstance(name, str) or name not in SCHEMA:
        raise Refused(404, "unknown action")
    fields = SCHEMA[name]
    for key, value in data.items():
        if key == "action":
            continue
        if key not in fields:
            raise Refused(400, f"unknown field {key}")
        typ = fields[key][0]
        # bool is an int in Python; never accept true as a coordinate.
        if not isinstance(value, typ) or (typ is int and isinstance(value, bool)):
            raise Refused(400, f"bad type for {key}")
    for key, (_, required) in fields.items():
        if required and key not in data:
            raise Refused(400, f"missing {key}")
    if "monitor" in data and data["monitor"] < 1:
        raise Refused(400, "monitor counts from 1")
    if name == "open_url":
        check_url(data["url"])
    elif name == "key":
        parse_combo(data["combo"])
    elif name == "media" and data["command"] not in MEDIA and data["command"] not in APPCOMMAND:
        raise Refused(400, "unknown media command")
    elif name == "click" and data.get("button", "left") not in ("left", "right", "middle"):
        raise Refused(400, "unknown button")
    elif name == "focus_window" and not (data.get("title") or "hwnd" in data):
        raise Refused(400, "focus_window needs title or hwnd")
    elif name in ("open_app",) and not data["name"].strip():
        raise Refused(400, "empty name")
    elif name in ("audio_output", "audio_input"):
        if not data["name"].strip():
            raise Refused(400, "empty name")
        if data.get("role", 0) not in (0, 1, 2):  # absent: all three roles
            raise Refused(400, "role must be 0 console, 1 multimedia or 2 communications")
    elif name == "volume":
        check_volume(data)
    elif name == "move_window" and not (data.get("title") or "hwnd" in data):
        raise Refused(400, "move_window needs title or hwnd")
    elif name == "settings":
        data["uri"] = settings_uri(data["page"])
    elif name == "powershell":
        if not data["script"].strip():
            raise Refused(400, "empty script")
        t = data.setdefault("timeout_s", PS_TIMEOUT_DEFAULT)
        if not 1 <= t <= PS_TIMEOUT_MAX:
            raise Refused(400, f"timeout_s must be 1 to {PS_TIMEOUT_MAX}")
    elif name == "spotify_play":
        from .spotify import clean_query  # spotify imports core: import here, not at the top
        data["query"] = clean_query(data["query"])
    return data


def check_url(url: str) -> None:
    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise Refused(400, "only http and https urls")


# ---- key combos ----------------------------------------------------------

VK = {
    "ctrl": 0xA2, "control": 0xA2, "shift": 0xA0, "alt": 0xA4, "win": 0x5B,
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "backspace": 0x08, "delete": 0x2E, "del": 0x2E, "insert": 0x2D, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    **{f"f{i}": 0x6F + i for i in range(1, 13)},
    **{chr(c): c - 32 for c in range(ord("a"), ord("z") + 1)},
    **{str(d): 0x30 + d for d in range(10)},
    **{k: v for k, v in MEDIA.items()},
}
MODIFIERS = {0xA2, 0xA0, 0xA4, 0x5B}
# Keys that need KEYEVENTF_EXTENDEDKEY so they are not read as their numpad twins.
EXTENDED = {0x5B, 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, *MEDIA.values()}


def parse_combo(combo: str) -> list[int]:
    """'ctrl+shift+t' -> virtual keys, modifiers first. One non-modifier key at most."""
    names = [p.strip().lower() for p in combo.split("+")]
    if not names or any(not n for n in names):
        raise Refused(400, "bad key combo")
    keys = []
    for n in names:
        if n not in VK:
            raise Refused(400, f"unknown key {n}")
        keys.append(VK[n])
    mods = [k for k in keys if k in MODIFIERS]
    rest = [k for k in keys if k not in MODIFIERS]
    if len(rest) > 1 or len(set(keys)) != len(keys):
        raise Refused(400, "bad key combo")
    return mods + rest


# ---- app match -----------------------------------------------------------

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def match_app(query: str, apps: list[tuple[str, str]]) -> tuple[str, str] | None:
    """Best (name, appid) for a spoken app name: the exact Start menu name (any case) first,
    then exact, prefix, word and close spelling on a normalized name. Normalizing drops
    punctuation, so "Notepad++" must win on the raw name before it turns into "notepad"."""
    raw = query.strip().casefold()
    for name, aid in apps:
        if raw and name.strip().casefold() == raw:
            return name, aid
    q = _norm(query)
    if not q:
        return None
    named = [(_norm(n), n, a) for n, a in apps]
    for test in (
        lambda n: n == q,
        lambda n: n.startswith(q),
        lambda n: q in n.split(),
        lambda n: q in n,
    ):
        hits = [(n, name, aid) for n, name, aid in named if test(n)]
        if hits:
            n, name, aid = min(hits, key=lambda h: (len(h[0]), h[1]))
            return name, aid
    close = difflib.get_close_matches(q, [n for n, _, _ in named], n=1, cutoff=0.75)
    if close:
        for n, name, aid in named:
            if n == close[0]:
                return name, aid
    return None


def pick_player(windows: list[dict]) -> int | None:
    """The Spotify main window from top-level windows (hwnd, exe, cls, title, visible, owned):
    unowned, the main window class, a title; a visible one first. None when Spotify has none."""
    hits = [w for w in windows if w["exe"].lower() == PLAYER_EXE and w["cls"] == PLAYER_CLASS
            and w["title"] and not w["owned"]]
    if not hits:
        return None
    return min(hits, key=lambda w: not w["visible"])["hwnd"]


# ---- guarded typing ------------------------------------------------------

def send_guarded(batches: list, send, aimed, total: int, pause: float = 0.0, sleep=time.sleep) -> int:
    """Send each batch (one character's keystrokes) only while aimed() says the target window
    is still in front; checked before every batch, so focus loss mid-text stops the rest.
    Raises Refused(409) naming how many of total characters went out. Best effort: the check
    and send() are not atomic, so one batch can land in a window that took the focus between
    them; a caller resends only the rest, never the whole text."""
    sent = 0
    for batch in batches:
        if not aimed():
            raise Refused(409, f"target window lost the focus after {sent} of {total} characters")
        send(batch)
        sent += 1
        if pause:
            sleep(pause)
    return sent


# ---- audio (hq-63nvj.13) ---------------------------------------------------

def check_volume(a: dict) -> None:
    level, cmd, step = a.get("level"), a.get("command"), a.get("step")
    if level is not None and cmd is not None:
        raise Refused(400, "volume takes level or command, not both")
    if level is not None and not 0 <= level <= 100:
        raise Refused(400, "level must be 0 to 100")
    if cmd is not None and cmd not in VOLUME_COMMANDS:
        raise Refused(400, "unknown volume command")
    if step is not None and (cmd not in ("up", "down") or not 1 <= step <= 100):
        raise Refused(400, "step goes with up or down, 1 to 100")


def volume_target(current: int, a: dict) -> tuple[int | None, bool | None]:
    """(level to set, mute to set) for a volume action; None means leave it. A level or an
    up unmutes, as the Windows volume flyout does, so "volume 30" is audible."""
    cmd = a.get("command")
    if "level" in a:
        return a["level"], False
    if cmd == "up":
        return min(100, current + a.get("step", 10)), False
    if cmd == "down":
        return max(0, current - a.get("step", 10)), None
    if cmd == "mute":
        return None, True
    if cmd == "unmute":
        return None, False
    return None, None  # no field: read only


FILLER = {"my", "the", "a", "to", "mi", "mis", "el", "la", "los", "las", "de", "del", "al"}


def match_device(query: str, devices: list[dict], fuzzy: bool = True) -> tuple[dict | None, list[str]]:
    """The device a spoken name means, plus every name that matched (so a caller sees an
    ambiguous pick). Exact name or id first; fuzzy then uses match_app on the name, then the
    same with filler words ("my speaker") dropped. Ties go to the shortest name."""
    raw = query.strip().casefold()
    for d in devices:
        if raw in (d["name"].casefold(), d["id"].casefold()):
            return d, [d["name"]]
    if not fuzzy:
        return None, []
    pairs = [(d["name"], d["id"]) for d in devices]
    words = [w for w in _norm(query).split() if w not in FILLER]
    for q in dict.fromkeys([query, " ".join(words)]):
        hit = match_app(q, pairs) if q.strip() else None
        if hit:
            qn = _norm(q)
            also = [n for n, _ in pairs if qn and qn in _norm(n)] or [hit[0]]
            return next(d for d in devices if d["id"] == hit[1]), sorted(set(also) | {hit[0]})
    return None, []


# ---- monitors and placement ------------------------------------------------

def order_monitors(raw: list[dict]) -> list[dict]:
    """Number monitors from 1: the primary first, then left to right, top to bottom, so
    "monitor 2" is the other screen on a two-screen desk."""
    ordered = sorted(raw, key=lambda m: (not m["primary"], m["bounds"][0], m["bounds"][1]))
    return [{"index": i, **m} for i, m in enumerate(ordered, 1)]


def pick_monitor(monitors: list[dict], index: int) -> tuple[dict, bool]:
    """(monitor, fell_back): an index past the last monitor falls back to the primary and
    says so, so "the second screen" on a one-screen desk still opens, reported."""
    for m in monitors:
        if m["index"] == index:
            return m, False
    if not monitors:
        raise Refused(503, "no monitors found")
    return monitors[0], True


def place(rect: tuple[int, int, int, int], work: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Window (left, top, right, bottom) -> the same size, clamped to fit, centered in the
    target work area. Returns (x, y, w, h) for SetWindowPos."""
    wl, wt, wr, wb = work
    w = min(rect[2] - rect[0], wr - wl)
    h = min(rect[3] - rect[1], wb - wt)
    return wl + (wr - wl - w) // 2, wt + (wb - wt - h) // 2, w, h


# ---- settings pages --------------------------------------------------------

SETTINGS = {
    "home": "", "settings": "", "configuracion": "",
    "bluetooth": "bluetooth", "devices": "bluetooth", "dispositivos": "bluetooth",
    "display": "display", "screen": "display", "monitor": "display", "pantalla": "display",
    "sound": "sound", "audio": "sound", "sonido": "sound",
    "volume mixer": "apps-volume", "mixer": "apps-volume", "mezclador": "apps-volume",
    "night light": "nightlight", "nightlight": "nightlight", "luz nocturna": "nightlight",
    "wifi": "network-wifi", "wi fi": "network-wifi", "network": "network-status", "red": "network-status",
    "internet": "network-status", "vpn": "network-vpn", "proxy": "network-proxy",
    "apps": "appsfeatures", "aplicaciones": "appsfeatures", "default apps": "defaultapps",
    "startup apps": "startupapps", "startup": "startupapps",
    "update": "windowsupdate", "windows update": "windowsupdate", "actualizaciones": "windowsupdate",
    "power": "powersleep", "sleep": "powersleep", "energia": "powersleep", "battery": "batterysaver",
    "mouse": "mousetouchpad", "raton": "mousetouchpad", "keyboard": "typing", "teclado": "typing",
    "typing": "typing", "notifications": "notifications", "notificaciones": "notifications",
    "focus": "quiethours", "do not disturb": "quiethours", "no molestar": "quiethours",
    "personalization": "personalization", "background": "personalization-background",
    "wallpaper": "personalization-background", "fondo": "personalization-background",
    "colors": "colors", "dark mode": "colors", "colores": "colors", "themes": "themes", "temas": "themes",
    "taskbar": "taskbar", "barra de tareas": "taskbar", "privacy": "privacy", "privacidad": "privacy",
    "microphone": "privacy-microphone", "microfono": "privacy-microphone",
    "camera": "privacy-webcam", "camara": "privacy-webcam", "storage": "storagesense",
    "almacenamiento": "storagesense", "about": "about", "acerca de": "about",
    "printers": "printers", "impresoras": "printers", "date": "dateandtime", "time": "dateandtime",
    "date and time": "dateandtime", "fecha y hora": "dateandtime", "language": "regionlanguage",
    "idioma": "regionlanguage", "region": "regionlanguage", "accounts": "yourinfo", "cuentas": "yourinfo",
    "clipboard": "clipboard", "portapapeles": "clipboard", "multitasking": "multitasking",
    "gaming": "gaming-gamebar", "game mode": "gaming-gamemode", "accessibility": "easeofaccess",
    "accesibilidad": "easeofaccess", "mobile devices": "mobile-devices", "phone": "mobile-devices",
}
SETTINGS_URI = re.compile(r"^ms-settings:[a-z0-9-]*$", re.I)
SETTINGS_WORDS = re.compile(r"\b(settings|setting|page|configuracion|ajustes|de|del|la|el)\b")


def settings_uri(page: str) -> str:
    """A short name ("bluetooth", "night light", "sonido") or an ms-settings: uri -> the uri.
    Unknown names are refused rather than guessed."""
    p = page.strip()
    if SETTINGS_URI.match(p):
        return p.lower()
    import unicodedata
    folded = "".join(c for c in unicodedata.normalize("NFKD", p.lower()) if not unicodedata.combining(c))
    key = _norm(folded)
    for k in (key, " ".join(SETTINGS_WORDS.sub(" ", key).split())):
        if k in SETTINGS:
            return "ms-settings:" + SETTINGS[k]
    raise Refused(404, "unknown settings page: use a short name or an ms-settings: uri")


# ---- browser ---------------------------------------------------------------

def browser_argv(exe: str, url: str) -> list[str]:
    """A new browser window on url: Firefox spells it -new-window, Chromium browsers --new-window."""
    flag = "-new-window" if ntpath.basename(exe).lower() == "firefox.exe" else "--new-window"
    return [exe, flag, url.strip()]


# ---- powershell ------------------------------------------------------------

PS_PRELUDE = ("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
              "$OutputEncoding=[Text.Encoding]::UTF8\n")
PS_CLIP = 64 * 1024


def clip(text: str, limit: int = PS_CLIP) -> tuple[str, bool]:
    """Output for the reply: the last `limit` characters (the end holds the error), and whether it was cut."""
    return (text, False) if len(text) <= limit else (text[-limit:], True)


def parse_media_status(returncode: int, stdout: str, stderr: str) -> dict:
    """The media_status.ps1 reply, or an explicit error: a failed helper never reads as
    'no media sessions'."""
    lines = (stdout or "").strip().splitlines()
    if returncode != 0 or not lines:
        why = ((stderr or "").strip().splitlines() or ["no output"])[-1][:200]
        raise RuntimeError(f"media_status helper failed (exit {returncode}): {why}")
    try:
        data = json.loads(lines[-1])
    except ValueError:
        raise RuntimeError("media_status helper printed no JSON") from None
    if not isinstance(data, dict) or "sessions" not in data:
        raise RuntimeError("media_status helper reply has no sessions")
    if isinstance(data["sessions"], dict):  # PowerShell 5.1 may unroll a one-item array
        data["sessions"] = [data["sessions"]]
    return data


# ---- log -----------------------------------------------------------------

def log_target(action: dict) -> str | int | None:
    """What the log keeps for an action: never typed text, only its length."""
    name = action["action"]
    if name == "type_text":
        return len(action["text"])
    if name == "open_url":
        return action["url"]
    if name == "open_app":
        return action["name"]
    if name == "focus_window":
        return action.get("title") or action.get("hwnd")
    if name == "key":
        return action["combo"]
    if name == "click":
        return f"{action['x']},{action['y']}"
    if name == "media":
        return action["command"]
    if name == "spotify_play":
        return action["query"]
    if name in ("audio_output", "audio_input"):
        return action["name"]
    if name == "volume":
        return action.get("level", action.get("command"))
    if name == "move_window":
        return f"{action.get('title') or action.get('hwnd')}@{action['monitor']}"
    if name == "settings":
        return action["uri"]
    if name == "powershell":
        return len(action["script"])  # a script can hold anything: only its length is kept
    if name in ("screenshot", "type_text", "key"):
        return action.get("hwnd")
    return None


def log_line(path: Path, **rec) -> None:
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


SHOT_NAME = re.compile(r"^shot-\d{8}-\d{6}-\d{3}\.png$")


# ---- png -----------------------------------------------------------------

def bgra_to_png(bgra: bytes, width: int, height: int) -> bytes:
    """Top-down 32-bit BGRA (a GDI DIB) -> an RGB PNG, stdlib only."""
    import struct
    import zlib

    rgb = bytearray(width * height * 3)
    rgb[0::3] = bgra[2::4]
    rgb[1::3] = bgra[1::4]
    rgb[2::3] = bgra[0::4]
    stride = width * 3
    raw = b"".join(b"\x00" + bytes(rgb[y * stride:(y + 1) * stride]) for y in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
