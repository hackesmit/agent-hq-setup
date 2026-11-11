"""Tier 0 router (hq-63nvj.4): a dictated command that matches a small grammar runs on
George through Capri hands, with no model; everything else goes to the orchestrator.

route(text) is pure: it returns one hands action or None. A phrase runs only when the
whole utterance matches one rule and every name in it is on a fixed list; anything
else, a question, two commands, an unknown app, returns None (a slow answer from the
orchestrator is better than a wrong action). Spanish and English, with Wispr Flow's
capitals and punctuation.

dispatch(text, hands, log) runs the action and logs tier, kind, status and ms, never text.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

MAX_CHARS = 200  # longer is not a short command

# Spoken name (folded: lowercase, no accents) -> exact Get-StartApps name on George (2026-11-04).
APPS = {
    "spotify": "Spotify",
    "brave": "Brave",
    "edge": "Microsoft Edge",
    "microsoft edge": "Microsoft Edge",
    "discord": "Discord",
    "whatsapp": "WhatsApp",
    "signal": "Signal",
    "telegram": None,  # not installed: never guess
    "vs code": "Visual Studio Code",
    "vscode": "Visual Studio Code",
    "visual studio code": "Visual Studio Code",
    "word": "Word",
    "excel": "Excel",
    "powerpoint": "PowerPoint",
    "power point": "PowerPoint",
    "outlook": "Outlook (classic)",
    "onenote": "OneNote",
    "teams": "Microsoft Teams",
    "microsoft teams": "Microsoft Teams",
    "zoom": "Zoom Workplace",
    "notepad": "Notepad",
    "bloc de notas": "Notepad",
    "calculator": "Calculator",
    "calculadora": "Calculator",
    "file explorer": "File Explorer",
    "explorer": "File Explorer",
    "explorador de archivos": "File Explorer",
    "explorador": "File Explorer",
    "obsidian": "Obsidian",
    "steam": "Steam",
    "terminal": "Terminal",
    "paint": "Paint",
    "settings": "Settings",
    "configuracion": "Settings",
    "task manager": "Task Manager",
    "administrador de tareas": "Task Manager",
    "obs": "OBS Studio",
    "claude": "Claude",
    "docker": "Docker Desktop",
    "proton pass": "Proton Pass",
    "anki": "Anki",
    "power bi": "Power BI Desktop",
}
APPS = {k: v for k, v in APPS.items() if v}

# Spoken site -> url. A name both here and in APPS opens the app.
SITES = {
    "youtube": "https://www.youtube.com",
    "gmail": "https://mail.google.com",
    "google": "https://www.google.com",
    "google drive": "https://drive.google.com",
    "drive": "https://drive.google.com",
    "google maps": "https://maps.google.com",
    "maps": "https://maps.google.com",
    "google calendar": "https://calendar.google.com",
    "netflix": "https://www.netflix.com",
    "github": "https://github.com",
    "chatgpt": "https://chatgpt.com",
    "chat gpt": "https://chatgpt.com",
    "linkedin": "https://www.linkedin.com",
    "instagram": "https://www.instagram.com",
    "facebook": "https://www.facebook.com",
    "reddit": "https://www.reddit.com",
    "wikipedia": "https://www.wikipedia.org",
    "amazon": "https://www.amazon.com.mx",
    "mercado libre": "https://www.mercadolibre.com.mx",
    "twitch": "https://www.twitch.tv",
    "vercel": "https://vercel.com",
}

TLDS = "com|net|org|io|dev|app|ai|mx|com\\.mx|co|tv|me|gg"
DOMAIN = re.compile(rf"(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:{TLDS})")

# Bare media words run at once (the owner 2026-11-04, efficiency over caution): a misfire on
# "continua" or "siguiente" only toggles the music, and the owner presses it again.
MEDIA = {
    # Explicit pause and play (hands hq-63nvj.9), never a toggle: "pausa" while paused stays paused.
    "pause": [
        "pausa", "pausar", "pausa la musica", "pausa la cancion", "pausa spotify", "pon pausa",
        "pause", "pause the music", "pause music", "pause the song", "pause spotify",
    ],
    "play": [
        "reanuda la musica", "continua la musica", "dale play",
        "continua", "reanuda", "resume", "play", "unpause",
        "resume the music", "resume music",
    ],
    "next": [
        "siguiente", "la siguiente", "next", "skip", "siguiente cancion", "la siguiente cancion", "pasa la cancion",
        "salta la cancion", "salta esta cancion", "cambia la cancion", "otra cancion",
        "next song", "next track", "skip song", "skip this song", "skip the song",
    ],
    "prev": [
        "anterior", "la anterior", "previous", "cancion anterior", "la cancion anterior", "regresa la cancion",
        "previous song", "previous track", "last song", "go back a song",
    ],
}
MEDIA_PHRASES = {p: cmd for cmd, ps in MEDIA.items() for p in ps}

# System volume (hands `volume`): explicit up, down, mute and unmute, never a toggle.
VOLUME = {
    "up": [
        "sube el volumen", "sube volumen", "mas volumen", "subele",
        "volume up", "turn it up", "turn up the volume", "louder", "raise the volume",
        "increase the volume", "turn the volume up", "make it louder", "up the volume",
    ],
    "down": [
        "baja el volumen", "baja volumen", "menos volumen", "bajale",
        "volume down", "turn it down", "turn down the volume", "quieter", "lower the volume",
        "decrease the volume", "turn the volume down", "make it quieter", "softer",
    ],
    "mute": [
        "silencio", "silencia", "mutea", "mute", "mute the volume", "mute the sound",
        "mute the audio", "mute it", "mute sound", "mute audio", "mute the computer",
    ],
    "unmute": [
        "quita el silencio", "quitale el silencio", "desmutea", "unmute", "unmute the volume",
        "unmute the sound", "unmute the audio", "unmute it", "unmute sound", "unmute audio",
    ],
}
VOLUME_PHRASES = {p: cmd for cmd, ps in VOLUME.items() for p in ps}
SET_VOLUME = re.compile(
    r"(?:(?:set|put|change|turn|pon|ponme|pon me|cambia|ajusta)\s+)?(?:the\s+|el\s+)?(?:volume|volumen)\s+"
    r"(?:to|at|a|al|en)\s+(?P<n>\d{1,3})(?:\s*(?:%|percent|por ciento))?"
)

# Spoken output device (folded) -> the fuzzy word hands matches against George's outputs
# (2026-11-05: Speakers (2- Realtek(R) Audio), Speakers (HyperX Cloud Flight Wireless)).
# "speakers" matches both and hands takes the shortest name, the Realtek one.
AUDIO_DEVICES = {
    "speakers": "speakers", "speaker": "speakers", "bocinas": "speakers", "altavoces": "speakers",
    "headphones": "hyperx", "headset": "hyperx", "hyperx": "hyperx", "hyper x": "hyperx",
    "audifonos": "hyperx", "auriculares": "hyperx", "diadema": "hyperx",
}
DEVICE_ARTICLE = r"(?:(?:the|my|los|las|mis|el|la|mi)\s+)?"
AUDIO_SWITCH = re.compile(
    r"(?:(?:switch|change|set|move|route|send|put|cambia|cambiar|pasa|pon|ponme)\s+(?:the\s+|el\s+|mi\s+|my\s+)?"
    r"(?:audio output|sound output|audio|sound|output|sonido|salida de audio|salida)\s+(?:over\s+)?(?:to|a|al|en|hacia)"
    r"|(?:switch|change|cambia|cambiar)\s+(?:over\s+)?(?:to|a|al))\s+"
    + DEVICE_ARTICLE + r"(?P<name>[a-z0-9 ]+?)(?:\s+(?:audio|output|sound|salida))?"
)

# Settings pages hands knows by short name; anything else goes to the orchestrator.
SETTINGS_PAGES = {
    "bluetooth": "bluetooth", "sound": "sound", "sounds": "sound", "audio": "sound", "sonido": "sound",
    "display": "display", "screen": "display", "pantalla": "display", "night light": "night light",
    "wifi": "wifi", "wi fi": "wifi", "network": "wifi", "update": "update", "windows update": "update",
    "actualizaciones": "update",
}

OPEN = r"(?:abre|abrir|abreme|abrime|abre me|open|open up|launch|inicia|ejecuta|ve a|vete a|go to)"
ARTICLE = r"(?:(?:el|la|los|las|mi|the|my)\s+)?"
APP_WORD = r"(?:(?:app|aplicacion|programa)\s+(?:de\s+)?)?"
PLAY = r"(?:pon|ponme|pon me|reproduce|reproduceme|toca|tocame|play|put on)"
SONG = r"(?:(?:la cancion|el tema|la rola|the song|el disco|el album|the album)\s+)?"
TYPE = r"(?:escribe|teclea|type out|type)"
SETTINGS_OPEN = re.compile(
    rf"{OPEN}\s+{ARTICLE}(?P<page>[a-z0-9 -]+?)\s+(?:settings|setting|configuracion|ajustes)"
)
SETTINGS_OPEN_ES = re.compile(rf"{OPEN}\s+(?:la\s+|el\s+)?(?:configuracion|ajustes)\s+(?:de\s+|del\s+)?(?P<page>[a-z0-9 ]+)")
# "on my second screen": monitor 1 is the primary, then left to right.
ORDINALS = {
    "first": 1, "primary": 1, "main": 1, "primera": 1, "principal": 1,
    "second": 2, "secondary": 2, "segunda": 2, "third": 3, "tercera": 3, "fourth": 4, "cuarta": 4,
    "1": 1, "2": 2, "3": 3, "4": 4, "one": 1, "two": 2, "three": 3, "four": 4,
}
SCREEN_TAIL = re.compile(
    r"\s+(?:on|in|onto|to|en|a)\s+(?:the\s+|my\s+|mi\s+|la\s+)?(?:(?P<o1>[a-z0-9]+)\s+(?:screen|monitor|display|pantalla)"
    r"|(?:screen|monitor|display|pantalla|monitor)\s+(?P<o2>[a-z0-9]+))$"
)
# A Spotify query made only of these words names no song ("pon la musica", "play something").
FILLER = {
    "la", "el", "los", "las", "the", "a", "an", "this", "esta", "este", "that", "esa", "ese",
    "lo", "de", "of", "que", "one", "una", "uno", "cancion", "song", "track", "tema", "rola",
    "musica", "music", "algo", "something", "vez", "misma", "same", "para", "it", "eso", "esto",
    "cosa", "cosas", "thing", "things",
}
# A Spotify query made only of these words and FILLER is a media command or a position, not a
# search ("pon lo siguiente", "play it again", "pon shuffle"). One real word beside them makes
# it a title (Otra Vez de Zion, Back in Black, Don't Stop Me Now) and it runs.
MEDIA_WORD = {
    "pausa", "pausar", "pause", "play", "stop", "deten", "resume", "reanuda", "continua",
    "skip", "mute", "silencio", "volumen", "volume", "siguiente", "siguientes", "sigue",
    "anterior", "antes", "proxima", "proximo", "next", "previous", "prev", "following",
    "before", "after", "despues", "last", "otra", "otro", "another", "else", "again", "nuevo",
    "repeat", "repetir", "repite", "shuffle", "aleatorio", "random", "back", "atras", "up", "down",
}
# Typed text must be delimited: "Escribe: hola" or "Escribe "hola"". Wispr writes straight
# double quotes and a colon before quoted speech (flow.sqlite, 2026-11-04).
OPENQ, CLOSEQ = "\"“«", "\"”»"

LEAD = re.compile(r"^(?:(?:capri|oye|hey|ok|okay|porfa|por favor|please)\b[\s,.:;!]*)+")
TAIL = re.compile(r"(?:[\s,]+(?:por favor|porfa|please))?[\s.!]*$")


def fold(text: str) -> str:
    """Lowercase without accents, one char per char, so spans index the original too."""
    out = []
    for c in text:
        f = "".join(x for x in unicodedata.normalize("NFKD", c) if not unicodedata.combining(x)).lower()
        out.append(f if len(f) == 1 else c.lower())
    return "".join(out)


def _key(s: str) -> str:
    """A spoken name as a lookup key: folded, inner punctuation to spaces."""
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


@dataclass(frozen=True)
class Route:
    kind: str  # open_app | open_url | media | spotify_play | type_text
    action: dict


def route(text: str) -> Optional[Route]:
    """One hands action for a short, unambiguous command, else None (orchestrator)."""
    if not isinstance(text, str):
        return None
    orig = text.strip()
    if not orig or len(orig) > MAX_CHARS or "\n" in orig or "\r" in orig:
        return None
    f = fold(orig).lstrip("¡")
    orig = orig[len(orig) - len(f):]
    m = LEAD.match(f)
    s = m.end() if m else 0
    t = TAIL.search(f, s)
    e = t.start() if t else len(f)
    body, raw = f[s:e], orig[s:e]
    if not body:
        return None

    typed = _type(f[s:].rstrip(), orig[s:].rstrip())  # typed text keeps its own ending
    if typed:
        return typed
    if "?" in body or "¿" in body:
        return None  # a question is for the orchestrator
    if body in MEDIA_PHRASES:
        return Route("media", {"action": "media", "command": MEDIA_PHRASES[body]})
    if body in VOLUME_PHRASES:
        return Route("volume", {"action": "volume", "command": VOLUME_PHRASES[body]})
    return _volume_level(body) or _audio(body) or _settings(body) or _open(body) or _spotify(body, raw)


def _volume_level(body: str) -> Optional[Route]:
    m = SET_VOLUME.fullmatch(body)
    if not m or int(m.group("n")) > 100:
        return None
    return Route("volume", {"action": "volume", "level": int(m.group("n"))})


def _audio(body: str) -> Optional[Route]:
    m = AUDIO_SWITCH.fullmatch(body)
    if not m:
        return None
    dev = AUDIO_DEVICES.get(_key(m.group("name")))
    if not dev:
        return None  # an unknown device is the orchestrator's to resolve
    return Route("audio_output", {"action": "audio_output", "name": dev})


def _settings(body: str) -> Optional[Route]:
    m = SETTINGS_OPEN.fullmatch(body) or SETTINGS_OPEN_ES.fullmatch(body)
    if not m:
        return None
    page = SETTINGS_PAGES.get(_key(m.group("page")))
    if not page:
        return None
    return Route("settings", {"action": "settings", "page": page})


def _open(body: str) -> Optional[Route]:
    m = re.fullmatch(rf"{OPEN}\s+{ARTICLE}{APP_WORD}(?P<name>.+)", body)
    if not m:
        return None
    monitor = None
    sm = SCREEN_TAIL.search(m.group("name"))
    if sm:
        monitor = ORDINALS.get(sm.group("o1") or sm.group("o2"))
        if monitor is None:
            return None  # an unknown screen word: not a site name either
        m = re.fullmatch(rf"{OPEN}\s+{ARTICLE}{APP_WORD}(?P<name>.+)", body[:body.rindex(sm.group(0))] if body.endswith(sm.group(0)) else body)
        if not m:
            return None
    raw_name = m.group("name").strip()
    name = _key(raw_name)
    if name in APPS and not monitor:
        return Route("open_app", {"action": "open_app", "name": APPS[name]})
    extra = {"monitor": monitor} if monitor else {}
    if name in SITES:
        return Route("open_url", {"action": "open_url", "url": SITES[name], **extra})
    if DOMAIN.fullmatch(raw_name):
        return Route("open_url", {"action": "open_url", "url": "https://" + raw_name, **extra})
    return None


def _spotify(body: str, raw: str) -> Optional[Route]:
    m = re.fullmatch(rf"{PLAY}\s+{SONG}(?P<q>.+?)[\s,]+(?:en|on|in)\s+spotify", body)
    if not m:
        return None
    q = raw[m.start("q"):m.end("q")].strip(" ,.;:\"'“”")
    qf = _key(fold(q))
    words = qf.split()
    if not qf or len(q) > 100 or "spotify" in words:
        return None
    if qf in MEDIA_PHRASES or set(words) <= FILLER | MEDIA_WORD:
        return None  # "pon pausa en spotify", "pon lo siguiente": a media command, not a search
    return Route("spotify_play", {"action": "spotify_play", "query": q})


def _type(body: str, raw: str) -> Optional[Route]:
    """Literal text only when delimited right after the verb: a colon, or the whole rest quoted.

    "Escribe mi correo", "Type in the search box cats", "Escribe hola a Person B" have no
    delimiter, so they go to the orchestrator: the words may be a request, not text.
    """
    m = re.match(rf"{TYPE}\b", body)
    if not m:
        return None
    rest = raw[m.end():]
    colon = re.match(r"\s*,?\s*:\s*", rest)
    if colon:
        text = rest[colon.end():].strip()
    else:
        text = re.sub(r"^\s*[,:]?\s*", "", rest).strip()
        if not text or text[0] not in OPENQ:
            return None
    if re.search(rf"[{CLOSEQ}]\.$", text):
        text = text[:-1]  # Wispr's period after a closing quote
    quoted = re.fullmatch(rf"[{OPENQ}]([^{OPENQ}{CLOSEQ}]+)[{CLOSEQ}]", text)
    if quoted:
        text = quoted.group(1).strip()
    elif not colon:
        return None  # a quote that does not close the phrase: "Escribe "hola" a Person B"
    elif text.endswith(".") and not text.endswith(".."):
        text = text[:-1].rstrip()  # Wispr closes every sentence with a period
    if not text:
        return None
    return Route("type_text", {"action": "type_text", "text": text})


# ---- hands client ------------------------------------------------------------

# Hands refused before acting: the orchestrator may still do it.
REFUSED_BEFORE_ACTING = {400, 401, 404, 411, 413}


class Hands:
    """POST one action to Capri hands on 127.0.0.1 with the token the owner's user can read."""

    def __init__(self, port: int = 47615, token_file: Optional[Path] = None, timeout: float = 10.0):
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        self.port = port
        self.token_file = token_file or Path(base) / "capri-hands" / "token"
        self.timeout = timeout

    def call(self, action: dict) -> tuple:
        """(status, reply). status 0: not reachable, nothing ran. -1: sent, no answer."""
        try:
            token = self.token_file.read_text(encoding="ascii").strip()
        except (OSError, UnicodeDecodeError):
            return 0, None
        if not token:
            return 0, None
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=self.timeout)
        body = json.dumps(action).encode()
        try:
            try:
                conn.connect()
            except OSError:
                return 0, None
            try:
                conn.request("POST", "/action", body=body, headers={"X-Hands-Token": token, "Content-Type": "application/json"})
                resp = conn.getresponse()
                status, data = resp.status, resp.read()
            except (OSError, socket.timeout, http.client.HTTPException):
                return -1, None
        finally:
            conn.close()
        try:
            return status, json.loads(data.decode("utf-8", "replace"))
        except ValueError:
            return status, None


def dispatch(text: str, hands, log: Callable[[dict], None], clock: Callable[[], float] = time.monotonic,
             hwnd: Optional[int] = None) -> Optional[dict]:
    """Tier 0 when the text routes and hands runs it: the say reply. None: send to the orchestrator.

    A refusal before acting (hands down, unknown action, no such app) falls through to the
    orchestrator; a failure after hands may have acted (409, 500, no answer) never does, so an
    action is never run twice. hwnd: the window the focus went back to; typed text goes only there.
    """
    t0 = clock()
    r = route(text)
    if r is None:
        log({"ev": "route", "tier": 2, "ms": round((clock() - t0) * 1000, 1)})
        return None
    action = dict(r.action)
    if r.kind == "type_text" and isinstance(hwnd, int) and hwnd:
        action["hwnd"] = hwnd  # hands types only while the owner's window is still in front
    status, reply = hands.call(action)
    rec = {"ev": "route", "tier": 0, "kind": r.kind, "hands": status, "ms": round((clock() - t0) * 1000, 1)}
    if status == 200 and (reply or {}).get("ok"):
        log(rec)
        return {"ok": True, "tier": 0, "kind": r.kind}
    if status in REFUSED_BEFORE_ACTING or status == 0:
        rec["fallback"] = True
        log(rec)
        return None
    log(rec)
    return {"ok": False, "status": f"tier0-{status}", "tier": 0, "kind": r.kind}
