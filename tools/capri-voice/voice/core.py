"""Pure logic of the Capri voice loop: tools, prompt, phrase set, scoring, speech templates, stats.

Stdlib only, so the tests run on hqbox without the audio stack.
"""
from __future__ import annotations

import datetime as _dt
import re
import statistics

# ---- tools the small model may call ------------------------------------------------

MEDIA_COMMANDS = ["play_pause", "next", "prev", "volume_up", "volume_down", "mute"]

MEDIA_SYNONYMS = {"pause": "play_pause", "play": "play_pause", "resume": "play_pause", "stop": "play_pause",
                  "skip": "next", "previous": "prev", "back": "prev", "louder": "volume_up", "quieter": "volume_down",
                  "unmute": "mute"}
HANDS_TOOLS = {"open_app", "open_url", "media"}


def _fn(name: str, desc: str, props: dict, required: list[str]) -> dict:
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props, "required": required}}}


# Flat tools, one per capri-hands action. A single "hands" tool with action+target made
# qwen2.5:7b emit a call Ollama 0.40.14 could not parse (empty reply, no tool_calls) on 5 of 10 phrases.
TOOLS = [
    _fn("open_app", "Open a program on the owner's PC by name.",
        {"name": {"type": "string", "description": "program name, e.g. Spotify"}}, ["name"]),
    _fn("open_url", "Open a web page.", {"url": {"type": "string", "description": "full https URL"}}, ["url"]),
    _fn("media", "Control music and volume.", {"command": {"type": "string", "enum": MEDIA_COMMANDS}}, ["command"]),
    _fn("ask_orchestrator",
        "Hand real work to the orchestrator (a stronger agent): email, code, workers, research, anything that "
        "takes more than one desktop action. task = the request in the owner's words.",
        {"task": {"type": "string"}}, ["task"]),
    _fn("status", "Read the current HQ status: how many workers run, open questions, last merge.", {}, []),
]

SYSTEM = (
    "You are Capri, the owner's voice assistant on his Windows PC. the owner speaks Spanish or English. "
    "Reply in the language he used, in one short sentence. "
    "Use a tool when he asks for a desktop action (hands), for HQ status (status), or for real work "
    "(ask_orchestrator). For small talk or simple facts answer directly without a tool. "
    "For the time or date, answer from the time below; status is only for HQ workers and questions. "
    "The current local time is {now}."
)


def system_prompt(now: _dt.datetime | None = None) -> str:
    now = now or _dt.datetime.now()
    return SYSTEM.format(now=now.strftime("%H:%M, %A %d %B %Y"))


# ---- the phrase set ----------------------------------------------------------------
# expect: (tool, {arg: substring-or-set}) or (None, None) for a direct answer.

PHRASES = [
    {"id": "p01", "lang": "es", "text": "Abre Spotify.", "expect": ("open_app", {"name": "spotify"})},
    {"id": "p02", "lang": "es", "text": "Pausa la música.", "expect": ("media", {"command": "play_pause"})},
    {"id": "p03", "lang": "es", "text": "¿Qué hora es?", "expect": (None, None)},
    {"id": "p04", "lang": "en", "text": "Open YouTube.", "expect": ({"open_app", "open_url"}, {"*": "youtube"})},
    {"id": "p05", "lang": "en", "text": "How many workers are running?", "expect": ("status", {})},
    {"id": "p06", "lang": "es", "text": "Dile al orquestador que revise los correos.", "expect": ("ask_orchestrator", {"task": "correo"})},
    {"id": "p07", "lang": "es", "text": "Sube el volumen.", "expect": ("media", {"command": "volume_up"})},
    {"id": "p08", "lang": "en", "text": "Next song.", "expect": ("media", {"command": "next"})},
    {"id": "p09", "lang": "en", "text": "Ask the orchestrator to review the acme branch.", "expect": ("ask_orchestrator", {"task": "acme"})},
    {"id": "p10", "lang": "es", "text": "Hola Capri, ¿cómo estás?", "expect": (None, None)},
]

# English only: the six bead phrases in English plus four more (the owner 2026-11-05: test phrases in English).
PHRASES_EN = [
    {"id": "e01", "lang": "en", "text": "Open Spotify.", "expect": ("open_app", {"name": "spotify"})},
    {"id": "e02", "lang": "en", "text": "Pause the music.", "expect": ("media", {"command": "play_pause"})},
    {"id": "e03", "lang": "en", "text": "What time is it?", "expect": (None, None)},
    {"id": "e04", "lang": "en", "text": "Open YouTube.", "expect": ({"open_app", "open_url"}, {"*": "youtube"})},
    {"id": "e05", "lang": "en", "text": "How many workers are running?", "expect": ("status", {})},
    {"id": "e06", "lang": "en", "text": "Tell the orchestrator to check my email.", "expect": ("ask_orchestrator", {"task": "mail"})},
    {"id": "e07", "lang": "en", "text": "Turn the volume up.", "expect": ("media", {"command": "volume_up"})},
    {"id": "e08", "lang": "en", "text": "Skip this song.", "expect": ("media", {"command": "next"})},
    {"id": "e09", "lang": "en", "text": "Ask the orchestrator to review the acme branch.", "expect": ("ask_orchestrator", {"task": "acme"})},
    {"id": "e10", "lang": "en", "text": "Hey Capri, how are you?", "expect": (None, None)},
]

PHRASE_SETS = {"mixed": PHRASES, "en": PHRASES_EN}


def phrase_set(name: str) -> list[dict]:
    return PHRASE_SETS[name]


def inputs_dir_name(name: str) -> str:
    """Synthesized inputs per set: inputs/ for the original mixed set, inputs-<set>/ otherwise."""
    return "inputs" if name == "mixed" else f"inputs-{name}"


def normalize(call: dict) -> dict:
    """Tolerate small-model slips that have one clear meaning: 'pause' is play_pause, a bare host gets https.

    A media word with no clear meaning stays as is, and hands_body() refuses it."""
    name, args = call.get("name"), dict(call.get("arguments") or {})
    if name == "media":
        cmd = str(args.get("command", "")).strip().lower().replace(" ", "_")
        args["command"] = MEDIA_SYNONYMS.get(cmd, cmd)
    elif name == "open_url":
        url = str(args.get("url", "")).strip()
        if url and not re.match(r"^https?://", url):
            url = "https://" + (url if "." in url else f"www.{url.lower()}.com")
        args["url"] = url
    elif name == "open_app":
        args["name"] = str(args.get("name", "")).strip()
    return {"name": name, "arguments": args}


def score(expect: tuple, calls: list[dict]) -> tuple[bool, str]:
    """Did the model do what the phrase asks? calls = [{"name":..., "arguments": {...}}], already normalized.

    expect = (tool or set of tools, {arg: substring}) ; arg "*" matches any argument value."""
    tool, args = expect
    if tool is None:
        return (not calls, "ok" if not calls else f"unexpected tool {calls[0]['name']}")
    if not calls:
        return False, "no tool call"
    call = calls[0]
    tools = tool if isinstance(tool, set) else {tool}
    if call.get("name") not in tools:
        return False, f"wrong tool {call.get('name')}"
    got = call.get("arguments") or {}
    for key, want in (args or {}).items():
        vals = [str(v).lower() for v in got.values()] if key == "*" else [str(got.get(key, "")).lower()]
        if not any(want in v for v in vals):
            return False, f"{key}={vals!r}"
    return True, "ok"


# ---- tool results become speech without a second model turn ---------------------------

ES_MEDIA = {"play_pause": "Listo.", "next": "Siguiente.", "prev": "Anterior.",
            "volume_up": "Subo el volumen.", "volume_down": "Bajo el volumen.", "mute": "Silencio."}
EN_MEDIA = {"play_pause": "Done.", "next": "Next.", "prev": "Previous.",
            "volume_up": "Volume up.", "volume_down": "Volume down.", "mute": "Muted."}


def tool_speech(call: dict, lang: str, result: dict | None = None) -> str:
    """One short sentence that confirms a tool call, in the owner's language."""
    es = lang == "es"
    name = call.get("name")
    a = call.get("arguments") or {}
    result = result or {}
    if name in HANDS_TOOLS and not result.get("ok", True):
        return "No pude hacerlo." if es else "That did not work."
    if name == "media":
        return (ES_MEDIA if es else EN_MEDIA).get(a.get("command"), "Listo." if es else "Done.")
    if name in ("open_app", "open_url"):
        label = _label(str(a.get("name") or a.get("url") or ""))
        return f"Abro {label}." if es else f"Opening {label}."
    if name == "ask_orchestrator":
        return "Va, se lo paso al orquestador." if es else "On it, passing that to the orchestrator."
    if name == "status":
        n = result.get("workers", 0)
        return f"Hay {n} trabajadores corriendo." if es else f"{n} workers are running."
    return "Listo." if es else "Done."


def _label(target: str) -> str:
    t = re.sub(r"^https?://(www\.)?", "", target).split("/")[0]
    t = re.sub(r"\.(com|org|net|tv|io)$", "", t)
    return t[:1].upper() + t[1:] if t else target


def hands_body(call: dict) -> dict | None:
    """A normalized open_app/open_url/media call as one capri-hands action body; None if it is not runnable."""
    name, a = call.get("name"), call.get("arguments") or {}
    if name == "media":
        return {"action": "media", "command": a["command"]} if a.get("command") in MEDIA_COMMANDS else None
    if name == "open_url":
        return {"action": "open_url", "url": a["url"]} if a.get("url") else None
    if name == "open_app":
        return {"action": "open_app", "name": a["name"]} if a.get("name") else None
    return None


# ---- streaming text to the first speakable piece -------------------------------------

_SENT_END = re.compile(r"[.!?¡¿…]\s|[.!?…]$|\n")


def first_sentence(text: str, done: bool = False) -> str | None:
    """The first complete sentence of a growing reply, or None while it is still open."""
    m = _SENT_END.search(text)
    if m and m.end() >= 3:
        return text[: m.end()].strip()
    return text.strip() if done and text.strip() else None


def pick_lang(detected: str, probs: dict[str, float], margin: float = 0.5) -> str:
    """es or en. Keep Whisper's pick when it is es/en and clearly ahead of the other; else the likelier one,
    leaning to Spanish (the owner's default)."""
    es, en = probs.get("es", 0.0), probs.get("en", 0.0)
    if detected in ("es", "en"):
        other = en if detected == "es" else es
        if probs.get(detected, 0.0) >= other + margin * probs.get(detected, 0.0):
            return detected
    return "en" if en > es * 1.5 else "es"


# ---- stats --------------------------------------------------------------------------

def p50(xs: list[float]) -> float:
    return statistics.median(xs) if xs else float("nan")


def summary(rows: list[dict], keys: list[str]) -> dict:
    out = {}
    for k in keys:
        xs = [r[k] for r in rows if isinstance(r.get(k), (int, float))]
        out[k] = {"p50": round(p50(xs)), "max": round(max(xs)) if xs else None, "n": len(xs)}
    return out


STAGES = ["vad_tail_ms", "stt_ms", "llm_first_ms", "tool_ms", "tts_ms", "e2e_ms"]


def report(rows: list[dict]) -> str:
    """Markdown table, one line per (model, stt, silence): stage p50s, e2e p50 and worst, accuracy, VRAM."""
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        groups.setdefault((r["model"], r["stt"], r["silence_ms"]), []).append(r)
    head = ("| model | STT | silence | VAD tail | STT | LLM first | tool | TTS | e2e p50 | e2e worst "
            "| tools ok (strict) | VRAM MB |")
    lines = [head, "|" + " --- |" * 12]
    for (model, stt, sil), rs in groups.items():
        s = summary(rs, STAGES)
        ok = sum(bool(r.get("tool_ok")) for r in rs)
        strict = sum(bool(r.get("strict_ok")) for r in rs)
        vram = max((r.get("vram_mb") or 0) for r in rs)
        worst = max(rs, key=lambda r: r["e2e_ms"])
        lines.append(
            f"| {model} | {stt} | {sil} | " + " | ".join(str(s[k]["p50"]) for k in STAGES[:-1])
            + f" | {s['e2e_ms']['p50']} | {s['e2e_ms']['max']} ({worst['phrase']}) | {ok}/{len(rs)} ({strict}) | {vram} |")
    return "\n".join(lines)


def reply_gaps(segments: list[tuple[float, float]], max_gap_s: float = 3.0) -> list[float]:
    """Speech segments heard by the mic, alternating phrase then reply: the silence (ms) between each
    phrase's end and the reply's start. A gap over max_gap_s means no reply, and the next segment is a
    new phrase. A reply split by a short pause is one reply."""
    gaps, i = [], 0
    while i + 1 < len(segments):
        gap = segments[i + 1][0] - segments[i][1]
        if gap <= max_gap_s:
            gaps.append(round(gap * 1000))
            i += 2
            while i < len(segments) and segments[i][0] - segments[i - 1][1] < 0.6:
                i += 1  # rest of a reply split by a pause
        else:
            i += 1
    return gaps
