import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from capri.router import Hands, dispatch, fold, route  # noqa: E402

# (dictated text as Wispr Flow writes it, expected hands action)
RUNS = [
    # open an app
    ("Abre Spotify.", {"action": "open_app", "name": "Spotify"}),
    ("abre spotify", {"action": "open_app", "name": "Spotify"}),
    ("Open Spotify.", {"action": "open_app", "name": "Spotify"}),
    ("Capri, abre Spotify, por favor.", {"action": "open_app", "name": "Spotify"}),
    ("Ábreme el Spotify.", {"action": "open_app", "name": "Spotify"}),
    ("Abre la app de WhatsApp.", {"action": "open_app", "name": "WhatsApp"}),
    ("Open VS Code.", {"action": "open_app", "name": "Visual Studio Code"}),
    ("Abre Outlook.", {"action": "open_app", "name": "Outlook (classic)"}),
    ("Abre el bloc de notas.", {"action": "open_app", "name": "Notepad"}),
    ("Abre la calculadora.", {"action": "open_app", "name": "Calculator"}),
    ("Launch Discord!", {"action": "open_app", "name": "Discord"}),
    ("Please open Excel.", {"action": "open_app", "name": "Excel"}),
    ("Abre configuración.", {"action": "open_app", "name": "Settings"}),
    # open a site
    ("Open YouTube.", {"action": "open_url", "url": "https://www.youtube.com"}),
    ("Abre YouTube.", {"action": "open_url", "url": "https://www.youtube.com"}),
    ("Ve a Gmail.", {"action": "open_url", "url": "https://mail.google.com"}),
    ("Go to GitHub.", {"action": "open_url", "url": "https://github.com"}),
    ("Abre Mercado Libre.", {"action": "open_url", "url": "https://www.mercadolibre.com.mx"}),
    ("Open example.com.", {"action": "open_url", "url": "https://example.com"}),
    ("Abre studiocodigital.com", {"action": "open_url", "url": "https://studiocodigital.com"}),
    # media
    ("Pausa.", {"action": "media", "command": "pause"}),
    ("pausa", {"action": "media", "command": "pause"}),
    ("Pause.", {"action": "media", "command": "pause"}),
    ("Pausa la música.", {"action": "media", "command": "pause"}),
    ("Dale play.", {"action": "media", "command": "play"}),
    ("Siguiente canción.", {"action": "media", "command": "next"}),
    ("Siguiente canción, por favor.", {"action": "media", "command": "next"}),
    ("Next song.", {"action": "media", "command": "next"}),
    ("Skip the song.", {"action": "media", "command": "next"}),
    ("Continúa la música.", {"action": "media", "command": "play"}),
    ("Resume the music.", {"action": "media", "command": "play"}),
    ("Pon pausa.", {"action": "media", "command": "pause"}),
    ("Previous song.", {"action": "media", "command": "prev"}),
    ("Canción anterior.", {"action": "media", "command": "prev"}),
    ("Sube el volumen.", {"action": "volume", "command": "up"}),
    ("Baja el volumen.", {"action": "volume", "command": "down"}),
    ("Turn it down.", {"action": "volume", "command": "down"}),
    ("Silencio.", {"action": "volume", "command": "mute"}),
    ("Mute.", {"action": "volume", "command": "mute"}),
    # English first (hq-63nvj.14)
    ("Pause the song.", {"action": "media", "command": "pause"}),
    ("Play.", {"action": "media", "command": "play"}),
    ("Resume.", {"action": "media", "command": "play"}),
    ("Next.", {"action": "media", "command": "next"}),
    ("Skip.", {"action": "media", "command": "next"}),
    ("Previous.", {"action": "media", "command": "prev"}),
    ("Volume up.", {"action": "volume", "command": "up"}),
    ("Volume down.", {"action": "volume", "command": "down"}),
    ("Turn the volume up.", {"action": "volume", "command": "up"}),
    ("Lower the volume, please.", {"action": "volume", "command": "down"}),
    ("Set volume to 40.", {"action": "volume", "level": 40}),
    ("Set the volume to 40%.", {"action": "volume", "level": 40}),
    ("Set the volume to 100 percent.", {"action": "volume", "level": 100}),
    ("Volume to 0.", {"action": "volume", "level": 0}),
    ("Capri, set volume to 25.", {"action": "volume", "level": 25}),
    ("Unmute.", {"action": "volume", "command": "unmute"}),
    ("Mute the sound.", {"action": "volume", "command": "mute"}),
    ("Quita el silencio.", {"action": "volume", "command": "unmute"}),
    ("Switch audio to speakers.", {"action": "audio_output", "name": "speakers"}),
    ("Switch audio to headphones.", {"action": "audio_output", "name": "hyperx"}),
    ("Switch to headphones.", {"action": "audio_output", "name": "hyperx"}),
    ("Switch to the speakers.", {"action": "audio_output", "name": "speakers"}),
    ("Change the audio output to my headset.", {"action": "audio_output", "name": "hyperx"}),
    ("Switch audio to HyperX.", {"action": "audio_output", "name": "hyperx"}),
    ("Cambia el audio a las bocinas.", {"action": "audio_output", "name": "speakers"}),
    ("Cambia el audio a los audífonos.", {"action": "audio_output", "name": "hyperx"}),
    ("Open YouTube on my second screen.", {"action": "open_url", "url": "https://www.youtube.com", "monitor": 2}),
    ("Open GitHub on the second monitor.", {"action": "open_url", "url": "https://github.com", "monitor": 2}),
    ("Open example.com on my first screen.", {"action": "open_url", "url": "https://example.com", "monitor": 1}),
    ("Abre YouTube en la segunda pantalla.", {"action": "open_url", "url": "https://www.youtube.com", "monitor": 2}),
    ("Open Bluetooth settings.", {"action": "settings", "page": "bluetooth"}),
    ("Open sound settings.", {"action": "settings", "page": "sound"}),
    ("Open the display settings.", {"action": "settings", "page": "display"}),
    ("Open Wi-Fi settings.", {"action": "settings", "page": "wifi"}),
    ("Abre la configuración de bluetooth.", {"action": "settings", "page": "bluetooth"}),
    ("Abre la configuración de sonido.", {"action": "settings", "page": "sound"}),
    # spotify
    ("Pon Bohemian Rhapsody en Spotify.", {"action": "spotify_play", "query": "Bohemian Rhapsody"}),
    ("Ponme Bohemian Rhapsody de Queen en Spotify.", {"action": "spotify_play", "query": "Bohemian Rhapsody de Queen"}),
    ("Play Bohemian Rhapsody on Spotify.", {"action": "spotify_play", "query": "Bohemian Rhapsody"}),
    ("Reproduce la canción Despacito en Spotify.", {"action": "spotify_play", "query": "Despacito"}),
    ("Toca \"La Bamba\" en Spotify.", {"action": "spotify_play", "query": "La Bamba"}),
    ("Pon Café Tacvba en Spotify.", {"action": "spotify_play", "query": "Café Tacvba"}),
    ("Pon Hotel California en Spotify.", {"action": "spotify_play", "query": "Hotel California"}),
    ("Play Blinding Lights on Spotify.", {"action": "spotify_play", "query": "Blinding Lights"}),
    ("Pon Despacito en Spotify.", {"action": "spotify_play", "query": "Despacito"}),
    ("Pon La Bamba en Spotify.", {"action": "spotify_play", "query": "La Bamba"}),
    ("Pon Como la Flor en Spotify.", {"action": "spotify_play", "query": "Como la Flor"}),
    # type: only delimited text, a colon after the verb or the whole rest quoted
    ("Escribe: hola mundo.", {"action": "type_text", "text": "hola mundo"}),
    ("Escribe: Nos vemos mañana.", {"action": "type_text", "text": "Nos vemos mañana"}),
    ("Type: hello world.", {"action": "type_text", "text": "hello world"}),
    ("Type out: hello world.", {"action": "type_text", "text": "hello world"}),
    ("Escribe: ¿cómo estás?", {"action": "type_text", "text": "¿cómo estás?"}),
    ("Escribe \"un abrazo\".", {"action": "type_text", "text": "un abrazo"}),
    ("Escribe, \"Nos vemos.\"", {"action": "type_text", "text": "Nos vemos."}),
    ("Type “see you soon”.", {"action": "type_text", "text": "see you soon"}),
    ("Escribe: \"hola\".", {"action": "type_text", "text": "hola"}),
    ("Capri, escribe: un correo a Person B.", {"action": "type_text", "text": "un correo a Person B"}),
]

# Not sure, two commands, a question, an unknown name, or real work: the orchestrator.
MISSES = [
    "Revisa los correos de Person B.",
    "Check Person B's emails.",
    "Abre Spotify y pon Queen.",
    "Open YouTube and search for cats.",
    "¿Abres Spotify?",
    "Can you open Spotify?",
    "Abre el archivo del presupuesto.",
    "Abre Telegram.",
    "Abre la puerta.",
    "No abras Spotify.",
    "Pausa la reunión de mañana.",
    "Siguiente paso: revisa el deploy.",
    "Escribe un correo a Person B diciendo que llego tarde.",
    "Write an email to Person A.",
    "Type a reply to the last message.",
    "Escribe que llego tarde.",
    "Pon Bohemian Rhapsody.",
    "Pon algo en Spotify y abre YouTube en Spotify spotify.",
    "Play.  Next.",
    "Abre ejemplo.xyz.",
    "Escribe.",
    "Abre.",
    "",
    "   ",
    "Pausa\nSiguiente",
    "Abre " + "Spotify " * 40,
    "¿Qué hora es?",
    "Sube el deploy de acme.",
    # type with no delimiter: the words may be a request, never typed (review r1 finding 1)
    "Escribe hola mundo.",
    "Type hello world.",
    "Type my email.",
    "Type my password.",
    "Escribe mi correo.",
    "Escribe en WhatsApp hola.",
    "Escribe en WhatsApp: hola.",
    "Type in the search box cats.",
    "Escribe lo siguiente: hola mundo.",
    "Escribe hola a Person B.",
    "Escribe \"hola\" a Person B.",
    "Escribe \"hola\" y \"adiós\".",
    "Escribe \"hola.",
    "Escribe: .",
    "Escribe \"\".",
    "Escribe 'hola'.",
    # a Spotify query that is a media command or a position (finding 2)
    "Pon pausa en Spotify.",
    "Pon la siguiente en Spotify.",
    "Play the next song on Spotify.",
    "Pon la anterior en Spotify.",
    "Pon otra en Spotify.",
    "Play the next one on Spotify.",
    "Pon la siguiente canción en Spotify.",
    "Pon la música en Spotify.",
    "Play something on Spotify.",
    "Pon play en Spotify.",
    # a Spotify query with any media or position word among real words (hq-63nvj.11)
    "Pon lo siguiente en Spotify.",
    "Pon la que sigue en Spotify.",
    "Play the following song on Spotify.",
    "Pon la de antes en Spotify.",
    "Play the one before on Spotify.",
    "Play something else on Spotify.",
    "Pon la canción de nuevo en Spotify.",
    "Play it again on Spotify.",
    "Pon shuffle en Spotify.",
    "Pon aleatorio en Spotify.",
    "Pon la canción que sigue en Spotify.",
    "Play the previous one on Spotify.",
    "Pon otra cosa en Spotify.",
    "Play the last song again on Spotify.",
    "Pon repetir en Spotify.",
    "Play the song after this on Spotify.",
    "Pon la de después en Spotify.",
    "Play it on Spotify.",
    # English commands that must stay with the orchestrator (hq-63nvj.14)
    "Switch audio to the TV.",
    "Switch audio.",
    "Switch to Slack.",
    "Set volume to 140.",
    "Set volume to loud.",
    "Set the volume to 40 and play music.",
    "What is the volume?",
    "Mute and pause.",
    "Open YouTube on my fifth screen.",
    "Open Spotify on my second screen.",
    "Open the weather settings.",
    "Open privacy settings.",
    "Switch audio to speakers and open Gmail.",
    "Open YouTube on my second screen and play music.",
]

# A real title with a media or position word runs at once (hq-63nvj.12).
TITLES_WITH_MEDIA_WORD = [
    "Pon Dont Stop Me Now en Spotify.",
    "Pon Otra Vez de Zion en Spotify.",
    "Play Back in Black on Spotify.",
    "Play Last Christmas on Spotify.",
    "Play Another One Bites the Dust on Spotify.",
    "Play Don't Stop Me Now on Spotify.",
]


@pytest.mark.parametrize("text,action", RUNS)
def test_runs(text, action):
    r = route(text)
    assert r is not None, text
    assert r.action == action


@pytest.mark.parametrize("text", MISSES)
def test_misses_go_to_orchestrator(text):
    assert route(text) is None, text


@pytest.mark.parametrize("text", TITLES_WITH_MEDIA_WORD)
def test_titles_with_media_word_run(text):
    r = route(text)
    assert r is not None and r.kind == "spotify_play", text


BARE = [
    ("Continúa.", "play"), ("Resume.", "play"), ("Reanuda.", "play"),
    ("Play.", "play"), ("Unpause.", "play"), ("Siguiente.", "next"),
    ("La siguiente.", "next"), ("Next.", "next"), ("Skip.", "next"),
    ("Anterior.", "prev"), ("Previous.", "prev"),
]


@pytest.mark.parametrize("text,cmd", BARE)
def test_bare_media_words_run(text, cmd):
    r = route(text)
    assert r is not None and r.action == {"action": "media", "command": cmd}, text


def test_enough_phrases():
    assert len(RUNS) + len(MISSES) >= 40


def test_fold_keeps_length():
    for s in ["Canción ¿Qué? Ñandú", "Ábreme", "ﬁ ligature"]:
        assert len(fold(s)) == len(s)


def test_kinds():
    assert route("Abre Spotify.").kind == "open_app"
    assert route("Pausa.").kind == "media"
    assert route("Escribe: hola.").kind == "type_text"


class FakeHands:
    def __init__(self, status, reply=None):
        self.status, self.reply, self.calls = status, reply, []

    def call(self, action):
        self.calls.append(action)
        return self.status, self.reply


def run(text, hands):
    logs = []
    t = iter([0.0, 0.012, 0.5])
    out = dispatch(text, hands, logs.append, clock=lambda: next(t))
    return out, logs


def test_dispatch_tier0_ok_logs_no_text():
    h = FakeHands(200, {"ok": True, "app": "Spotify"})
    out, logs = run("Abre Spotify.", h)
    assert out == {"ok": True, "tier": 0, "kind": "open_app"}
    assert h.calls == [{"action": "open_app", "name": "Spotify"}]
    assert logs == [{"ev": "route", "tier": 0, "kind": "open_app", "hands": 200, "ms": 12.0}]


def test_dispatch_miss_never_calls_hands():
    h = FakeHands(200, {"ok": True})
    out, logs = run("Revisa los correos de Person B.", h)
    assert out is None and h.calls == []
    assert logs == [{"ev": "route", "tier": 2, "ms": 12.0}]
    assert "Person B" not in str(logs)


def test_dispatch_typed_text_not_logged():
    h = FakeHands(200, {"ok": True, "chars": 10})
    out, logs = run("Escribe: secreto123.", h)
    assert out["ok"] and "secreto" not in str(logs)


@pytest.mark.parametrize("status", [0, 400, 401, 404])
def test_refused_before_acting_falls_back(status):
    out, logs = run("Pon Bohemian Rhapsody en Spotify.", FakeHands(status, {"ok": False}))
    assert out is None
    assert logs[0]["fallback"] is True and logs[0]["kind"] == "spotify_play"


@pytest.mark.parametrize("status", [409, 500, -1])
def test_failure_after_acting_never_falls_back(status):
    out, logs = run("Escribe: hola.", FakeHands(status, None))
    assert out == {"ok": False, "status": f"tier0-{status}", "tier": 0, "kind": "type_text"}
    assert "fallback" not in logs[0]


def test_hands_no_token_is_unreachable(tmp_path):
    assert Hands(port=1, token_file=tmp_path / "missing").call({"action": "media_status"}) == (0, None)
    empty = tmp_path / "token"
    empty.write_text("")
    assert Hands(port=1, token_file=empty).call({"action": "media_status"}) == (0, None)


def test_hands_closed_port_is_unreachable(tmp_path):
    tok = tmp_path / "token"
    tok.write_text("abc")
    assert Hands(port=1, token_file=tok, timeout=1).call({"action": "media_status"}) == (0, None)


def test_hands_posts_token_and_action(tmp_path):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    seen = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["token"] = self.headers.get("X-Hands-Token")
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            out = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.handle_request, daemon=True).start()
    tok = tmp_path / "token"
    tok.write_text("tok-1\n")
    try:
        assert Hands(port=srv.server_address[1], token_file=tok).call({"action": "media", "command": "next"}) == (200, {"ok": True})
    finally:
        srv.server_close()
    assert seen == {"token": "tok-1", "body": {"action": "media", "command": "next"}}


def test_typed_text_goes_only_to_owners_window():
    h = FakeHands(200, {"ok": True})
    dispatch("Escribe: hola.", h, lambda r: None, hwnd=4242)
    assert h.calls == [{"action": "type_text", "text": "hola", "hwnd": 4242}]
    h = FakeHands(200, {"ok": True})
    dispatch("Abre Spotify.", h, lambda r: None, hwnd=4242)
    assert "hwnd" not in h.calls[0]


def test_new_kinds():
    assert route("Volume up.").kind == "volume"
    assert route("Switch audio to speakers.").kind == "audio_output"
    assert route("Open bluetooth settings.").kind == "settings"


def test_no_phrase_toggles_mute():
    assert route("Mute.").action != route("Unmute.").action


def test_pause_and_resume_are_distinct_commands():
    # hq-63nvj.10: "pausa" while paused must never start music, so no phrase toggles.
    assert route("Pausa.").action["command"] == "pause"
    assert route("Reanuda la música.").action["command"] == "play"
    assert route("Pausa.").action != route("Reanuda la música.").action
    from capri.router import MEDIA_PHRASES
    assert "play_pause" not in set(MEDIA_PHRASES.values())
