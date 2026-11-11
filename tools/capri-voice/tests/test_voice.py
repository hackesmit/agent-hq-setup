import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice import brain, core, tools  # noqa: E402


def call(_tool, **args):
    return {"name": _tool, "arguments": args}


# ---- score -----------------------------------------------------------------------

def test_score_direct_answer_needs_no_tool():
    assert core.score((None, None), []) == (True, "ok")
    ok, why = core.score((None, None), [call("status")])
    assert not ok and "status" in why


def test_score_open_app_case_insensitive():
    p = core.PHRASES[0]
    assert core.score(p["expect"], [call("open_app", name="Spotify")])[0]
    assert not core.score(p["expect"], [call("open_url", url="https://open.spotify.com")])[0]


def test_score_youtube_accepts_app_or_url():
    p = next(p for p in core.PHRASES if p["id"] == "p04")
    assert core.score(p["expect"], [call("open_url", url="https://www.youtube.com")])[0]
    assert core.score(p["expect"], [call("open_app", name="YouTube")])[0]
    assert not core.score(p["expect"], [call("open_app", name="Spotify")])[0]


def test_score_media_exact_command():
    p = next(p for p in core.PHRASES if p["id"] == "p07")
    assert core.score(p["expect"], [call("media", command="volume_up")])[0]
    assert not core.score(p["expect"], [call("media", command="volume_down")])[0]


def test_score_wrong_tool_and_missing_call():
    p = next(p for p in core.PHRASES if p["id"] == "p06")
    assert core.score(p["expect"], [call("ask_orchestrator", task="revisa los correos")])[0]
    assert core.score(p["expect"], [call("open_app", name="Outlook")])[1] == "wrong tool open_app"
    assert core.score(p["expect"], [])[1] == "no tool call"


def test_normalize_media_synonyms_and_url():
    assert core.normalize(call("media", command="Pause")) == call("media", command="play_pause")
    assert core.normalize(call("media", command="volume up")) == call("media", command="volume_up")
    assert core.normalize(call("open_url", url="youtube")) == call("open_url", url="https://www.youtube.com")
    assert core.normalize(call("open_url", url="youtube.com")) == call("open_url", url="https://youtube.com")
    assert core.normalize(call("status")) == call("status")


def test_phrase_set_has_ten_with_the_six_required():
    texts = [p["text"].lower() for p in core.PHRASES]
    assert len(texts) == 10
    for must in ("abre spotify", "pausa la música", "qué hora es", "open youtube",
                 "how many workers are running", "dile al orquestador que revise los correos"):
        assert any(must in t for t in texts), must


# ---- hands mapping and speech --------------------------------------------------------

def test_hands_body_maps_to_capri_hands_schema():
    assert core.hands_body(call("open_app", name="Spotify")) == {"action": "open_app", "name": "Spotify"}
    assert core.hands_body(call("open_url", url="https://x.com")) == {"action": "open_url", "url": "https://x.com"}
    assert core.hands_body(call("media", command="next")) == {"action": "media", "command": "next"}
    # an unknown media word or an empty name is refused, never guessed
    assert core.hands_body(call("media", command="rm -rf")) is None
    assert core.hands_body(call("open_app", name="")) is None
    assert core.hands_body(call("status")) is None


def test_tool_speech_matches_language():
    assert core.tool_speech(call("open_app", name="Spotify"), "es") == "Abro Spotify."
    assert core.tool_speech(call("open_url", url="https://www.youtube.com/"), "en") == "Opening Youtube."
    assert core.tool_speech(call("media", command="volume_up"), "es") == "Subo el volumen."
    assert core.tool_speech(call("status"), "es", {"workers": 4}) == "Hay 4 trabajadores corriendo."
    assert "orchestrator" in core.tool_speech(call("ask_orchestrator", task="x"), "en")
    assert core.tool_speech(call("open_app", name="X"), "es", {"ok": False}) == "No pude hacerlo."


def test_first_sentence():
    assert core.first_sentence("Son las") is None
    assert core.first_sentence("Son las 3. Y algo") == "Son las 3."
    assert core.first_sentence("Hola", done=True) == "Hola"
    assert core.first_sentence("¿Qué tal? Bien") == "¿Qué tal?"


def test_system_prompt_carries_time():
    assert "14:05" in core.system_prompt(dt.datetime(2026, 11, 4, 14, 5))


def test_summary_p50_and_max():
    s = core.summary([{"a": 1}, {"a": 3}, {"a": 2}, {"b": 9}], ["a"])
    assert s["a"] == {"p50": 2, "max": 3, "n": 3}


# ---- tools.run ------------------------------------------------------------------------

def test_run_dry_never_calls_hands():
    def boom(body):
        raise AssertionError("hands called in dry mode")
    res, ms = tools.run(call("media", command="next"), dry=True, hands_fn=boom)
    assert res["dry"] and res["body"] == {"action": "media", "command": "next"} and ms >= 0


def test_run_live_passes_mapped_body():
    seen = []
    res, _ = tools.run(call("open_app", name="Spotify"), dry=False,
                       hands_fn=lambda b: seen.append(b) or {"ok": True})
    assert seen == [{"action": "open_app", "name": "Spotify"}] and res["ok"]


def test_run_stubs_and_unknown():
    assert tools.run(call("ask_orchestrator", task="x"))[0]["reply"] == "on it"
    assert tools.run(call("status"))[0]["workers"] == 3
    assert not tools.run(call("nope"))[0]["ok"]
    res, _ = tools.run(call("media", command="explode"), dry=False, hands_fn=lambda b: 1 / 0)
    assert not res["ok"]


# ---- brain.parse_stream ---------------------------------------------------------------

class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        self.t += 0.1
        return self.t


def lines(*msgs):
    return [json.dumps(m) for m in msgs]


def test_parse_stream_tool_call_timed_at_call_chunk():
    stream = lines(
        {"message": {"content": "", "tool_calls": [{"function": {"name": "media", "arguments": {"command": "pause"}}}]}, "done": False},
        {"message": {"content": ""}, "done": True},
    )
    r = brain.parse_stream(stream, 0.0, clock=Clock())
    assert r["calls"] == [call("media", command="play_pause")]
    assert r["raw_calls"] == [call("media", command="pause")]
    assert round(r["first_ms"]) == 100 and r["total_ms"] > r["first_ms"]


def test_parse_stream_text_first_sentence_and_string_args():
    stream = lines(
        {"message": {"content": "Son las "}, "done": False},
        {"message": {"content": "3. Y "}, "done": False},
        {"message": {"content": "algo"}, "done": True},
    )
    r = brain.parse_stream(stream, 0.0, clock=Clock())
    assert r["text"] == "Son las 3. Y algo" and not r["calls"]
    assert r["first_ms"] < r["total_ms"]
    s = lines({"message": {"tool_calls": [{"function": {"name": "status", "arguments": "{}"}}]}, "done": True})
    assert brain.parse_stream(s, 0.0, clock=Clock())["calls"] == [call("status")]


def test_parse_stream_error_raises():
    import pytest
    with pytest.raises(RuntimeError):
        brain.parse_stream(lines({"error": "model not found"}), 0.0)


def test_pick_lang_es_en_only():
    pick_lang = core.pick_lang
    assert pick_lang("en", {"en": 0.98, "es": 0.01}) == "en"
    assert pick_lang("es", {"es": 0.5, "en": 0.1}) == "es"
    # low-confidence English over a close Spanish: Spanish wins
    assert pick_lang("en", {"en": 0.27, "es": 0.25, "pt": 0.2}) == "es"
    # Whisper picked a third language: the likelier of es/en
    assert pick_lang("pt", {"pt": 0.6, "en": 0.3, "es": 0.05}) == "en"
    assert pick_lang("gl", {"gl": 0.6, "es": 0.3, "en": 0.05}) == "es"


def test_report_groups_and_counts():
    rows = []
    for i, e2e in enumerate([800, 900, 1000]):
        rows.append({"model": "m", "stt": "small", "silence_ms": 300, "phrase": f"p0{i}", "vad_tail_ms": 288,
                     "stt_ms": 90, "llm_first_ms": 150, "tool_ms": 0.1, "tts_ms": 100, "e2e_ms": e2e,
                     "tool_ok": i != 2, "strict_ok": i == 0, "vram_mb": 4000 + i})
    rows.append(dict(rows[0], model="other", e2e_ms=5))
    out = core.report(rows).splitlines()
    assert len(out) == 4
    assert "| m | small | 300 | 288 | 90 | 150 | 0 | 100 | 900 | 1000 (p02) | 2/3 (1) | 4002 |" == out[2]
    assert out[3].startswith("| other |")


def test_reply_gaps_pairs_phrase_and_reply():
    segs = [(1.0, 2.0), (2.8, 3.5),            # phrase, reply after 800 ms
            (10.0, 11.0), (11.9, 12.2), (12.5, 13.0),  # reply split by a 300 ms pause
            (20.0, 21.0),                       # no reply
            (30.0, 31.0), (31.7, 32.0)]
    assert core.reply_gaps(segs) == [800, 900, 700]


def test_english_set_covers_the_bead_phrases():
    en = core.phrase_set("en")
    assert len(en) == 10 and all(p["lang"] == "en" for p in en)
    assert len({p["id"] for p in en}) == 10 and not {p["id"] for p in en} & {p["id"] for p in core.PHRASES}
    # the six bead phrases, in English, keep the same expected tool
    for es_id, en_id in [("p01", "e01"), ("p02", "e02"), ("p03", "e03"), ("p04", "e04"), ("p05", "e05"), ("p06", "e06")]:
        es = next(p for p in core.PHRASES if p["id"] == es_id)
        e = next(p for p in en if p["id"] == en_id)
        assert es["expect"][0] == e["expect"][0]


def test_english_scoring_examples():
    e = {p["id"]: p for p in core.phrase_set("en")}
    assert core.score(e["e06"]["expect"], [{"name": "ask_orchestrator", "arguments": {"task": "check email"}}])[0]
    assert core.score(e["e08"]["expect"], [core.normalize({"name": "media", "arguments": {"command": "skip"}})])[0]
    assert not core.score(e["e10"]["expect"], [{"name": "status", "arguments": {}}])[0]


def test_inputs_dir_per_set():
    assert core.inputs_dir_name("mixed") == "inputs"
    assert core.inputs_dir_name("en") == "inputs-en"
