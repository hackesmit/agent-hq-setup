"""Pure logic of the Capri listener: no audio device, no Windows, no network.

One wake runs handle_wake() against an Io object. The real Io (app.py) talks to
Windows, Wispr Flow's history and the console; the tests use a fake. Audio never
leaves George. The console receives wake, done, and say with the dictated text
(read from Flow's local history), which the server types into the orchestrator
terminal. The listener never presses Enter or any key on the desktop except the
Flow start and stop hotkey, and never logs transcript text, only ids and lengths.
"""
from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol

from .flow import pick_text

KEY_RE = re.compile(r'name="console-boot-key"\s+content="([0-9a-f]{16,128})"')


def boot_key(html: str) -> Optional[str]:
    """The per-boot console key from the served page, or None."""
    m = KEY_RE.search(html or "")
    return m.group(1) if m else None


@dataclass
class Config:
    base_url: str = "https://hqbox.example.ts.net:8790"
    end_silence_s: float = 2.0  # silence after speech that ends the dictation
    no_speech_s: float = 6.0  # no speech at all this long: stop, send nothing
    max_s: float = 60.0  # hard stop
    history_wait_s: float = 12.0  # Flow transcribes in the cloud, then writes its History row
    nospeech_wait_s: float = 3.0  # our mic check heard no speech: still wait this long for Flow's row
    format_wait_s: float = 10.0  # raw_transcript to formatted; after this, asrText
    paste_settle_s: float = 1.0  # Flow's paste lands in the Capri window, then focus goes back
    say_retry_s: float = 15.0  # one retry of a say the console refused (no orchestrator)
    speech_factor: float = 3.0  # speech is this many times the room floor
    min_floor: float = 0.003  # RMS floor in float32 full scale
    keywords: list = field(default_factory=lambda: ["▁CA P RI @CAPRI"])  # BPE tokens of CAPRI
    threshold: float = 0.25  # sherpa-onnx keywords_threshold: higher means fewer wakes
    score: float = 1.0  # sherpa-onnx keywords_score (boost)
    device: Optional[str] = None  # input device name part; None = the Windows default, as Flow uses


def claim(try_once: Callable[[], bool], sleep: Callable[[float], None], timeout_s: float = 10.0, step_s: float = 0.5) -> bool:
    """Take the single-instance lock, retrying while an ended listener still dies.

    schtasks /End then /Run starts the new pythonw before the old one releases the
    mutex; one try made the new run exit at once (hq-ymxzt.12). A listener that
    really runs keeps the lock, so the new run gives up after timeout_s.
    """
    waited = 0.0
    while not try_once():
        if waited >= timeout_s:
            return False
        sleep(step_s)
        waited += step_s
    return True


def rms(samples) -> float:
    if not len(samples):
        return 0.0
    return math.sqrt(sum(float(x) * float(x) for x in samples) / len(samples))


class Dictation:
    """Decides when a hands-free dictation is over, from mic loudness alone.

    feed() takes one block's RMS and the time; it returns None while the
    dictation goes on, else "end" (speech then silence), "nospeech" or "max".
    """

    def __init__(self, floor: float, cfg: Config, start: float):
        self.cfg = cfg
        self.level = max(floor, cfg.min_floor) * cfg.speech_factor
        self.start = start
        self.last_speech: Optional[float] = None

    def feed(self, level: float, t: float) -> Optional[str]:
        if level >= self.level:
            self.last_speech = t
        if t - self.start >= self.cfg.max_s:
            return "max"
        if self.last_speech is None:
            return "nospeech" if t - self.start >= self.cfg.no_speech_s else None
        if t - self.last_speech >= self.cfg.end_silence_s:
            return "end"
        return None


class Io(Protocol):
    def now(self) -> float: ...  # monotonic s
    def wall(self) -> float: ...  # epoch s, the clock Flow stamps its History rows with
    def sleep(self, s: float) -> None: ...
    def chime(self, kind: str) -> None: ...  # heard | none | done
    def post(self, event: str, **fields) -> Optional[dict]: ...  # None: console unreachable
    def focus_capri(self, state: str) -> object: ...  # show the Capri window, focus it, return the previous window
    def show(self, state: Optional[str]) -> None: ...  # Capri window text; None hides it
    def restore(self, prev: object) -> None: ...  # give the focus back to the previous window
    def hotkey(self) -> None: ...  # Wispr Flow hands-free, Ctrl+Win+Space
    def wait_dictation(self) -> str: ...  # end | nospeech | max
    def history(self, t0: float) -> Optional[dict]: ...  # first Flow History row after t0, or None
    def row(self, tid: str) -> Optional[dict]: ...  # the Flow History row with this transcriptEntityId, or None
    def flow_mark(self) -> object: ...  # where Flow's History ends now (its last rowid)
    def flow_busy(self, mark: object, t0: float) -> bool: ...  # a row written after mark was stamped before t0
    def log(self, rec: dict) -> None: ...


CANCEL_PHRASES = frozenset({
    "cancel", "never mind", "nevermind", "forget it", "stop listening", "scratch that", "ignore that",
    "cancela", "cancelar", "olvidalo", "dejalo", "no importa",
})


def is_cancel(text: str) -> bool:
    """True when the whole transcript, or its final clause (after the last sentence
    break or comma), is only a cancel phrase. A leading 'Capri' and punctuation are
    ignored; a phrase inside a longer clause ('cancel my 3pm meeting') is not a cancel."""
    folded = unicodedata.normalize("NFD", text.lower())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    clauses = [" ".join(re.sub(r"[^\w\s]", " ", c).split()) for c in re.split(r"[.!?,;:\u2026\n]+", folded)]
    clauses = [c for c in clauses if c]
    if clauses and clauses[0] == "capri" and len(clauses) > 1:
        clauses = clauses[1:]
    elif clauses and clauses[0].startswith("capri "):
        clauses[0] = clauses[0][6:]
    return bool(clauses) and clauses[-1] in CANCEL_PHRASES


def wait_transcript(io: Io, cfg: Config, t0: float, row_wait_s: Optional[float] = None) -> tuple:
    """(row, text) once Flow wrote this dictation, or (row or None, None) on timeout.

    The first row after t0 is this wake's dictation: it is pinned by its
    transcriptEntityId and from then on only that row is read, so a dictation the owner
    starts by hand meanwhile is never sent instead. A formatted row is used at once;
    a raw_transcript row falls back to asrText format_wait_s after it appeared.
    """
    start = io.now()
    row_wait = cfg.history_wait_s if row_wait_s is None else row_wait_s
    seen_at: Optional[float] = None
    tid: Optional[str] = None
    row: Optional[dict] = None
    while True:
        if tid is None:
            row = io.history(t0)
            if row is not None:
                tid = str(row.get("transcriptEntityId") or "")
                seen_at = io.now()
                if not tid:
                    return row, None  # a row with no id cannot be pinned or sent
        else:
            again = io.row(tid)
            if again is not None and again.get("transcriptEntityId") == tid:
                row = again
        allow_raw = seen_at is not None and io.now() - seen_at >= cfg.format_wait_s
        text = pick_text(row, allow_raw)
        if text:
            return row, text
        if seen_at is None and io.now() - start >= row_wait:
            return None, None
        if allow_raw:
            return row, None  # a row with no text at all
        io.sleep(0.25)


def handle_wake(io: Io, cfg: Config) -> str:
    """One wake, start to finish. Returns the outcome it logged."""
    t0, t0_wall = io.now(), io.wall()
    rec: dict = {"ev": "wake"}
    prev: list = []

    def finish(outcome: str, done: bool, chime: Optional[str]) -> str:
        if prev:
            io.restore(prev.pop())
        io.show(None)
        if done:
            io.post("done")
        if chime:
            io.chime(chime)
        rec.update(outcome=outcome, ms=round((io.now() - t0) * 1000))
        io.log(rec)
        return outcome

    io.chime("heard")
    r = io.post("wake")
    rec["pages"] = (r or {}).get("pages")
    rec["focused"] = (r or {}).get("focused")
    rec["orchestrator"] = (r or {}).get("orchestrator")
    if not r or not r.get("ok") or not r.get("orchestrator"):
        # No console, or no live orchestrator to type into: never press the Flow hotkey.
        return finish("no-target", bool(r and r.get("ok")), "none")
    # Flow pastes into whatever has focus: give it the Capri window, never the owner's.
    prev.append(io.focus_capri("listening"))
    mark = io.flow_mark()
    io.hotkey()
    end = io.wait_dictation()
    rec["end"] = end
    if io.flow_busy(mark, t0_wall):
        # A row written since the mark that was still recording at this wake means
        # Flow was already dictating and our press stopped it: Flow is idle now, and
        # a second press would start a recording nobody stops. Its paste lands in
        # the Capri window; the text stays in Flow's History.
        io.sleep(cfg.paste_settle_s)
        return finish("flow-busy", True, "none")
    io.hotkey()  # second press stops Flow; it transcribes, writes History, pastes
    if end == "max":
        # The hard stop cancels: a dictation cut off at max_s may be half a sentence.
        # The stop still makes Flow paste, so the Capri window keeps the focus until
        # this wake's row is written and its paste had time to land.
        row, text = wait_transcript(io, cfg, t0_wall)
        if row is not None:
            rec["transcriptId"] = row.get("transcriptEntityId")
        if text:
            io.sleep(cfg.paste_settle_s)
        return finish("max-cancel", True, "none")
    io.show("sending")
    # Our end detection can miss short commands that Flow heard: on "nospeech" the
    # pinned Flow row still counts; only no row at all means nothing is sent.
    short = cfg.nospeech_wait_s if end == "nospeech" else None
    row, text = wait_transcript(io, cfg, t0_wall, short)
    if end == "nospeech" and row is None:
        return finish("no-speech", True, "none")
    if row is not None:
        rec["transcriptId"] = row.get("transcriptEntityId")
        rec["status"] = row.get("status")
    if not text:
        return finish("no-transcript", True, "none")
    rec["chars"] = len(text)
    io.sleep(cfg.paste_settle_s)  # let Flow's paste land in the Capri window
    if is_cancel(text):
        # the owner changed his mind or woke Capri by accident: nothing is sent.
        io.show("cancelled")
        io.sleep(1.0)
        return finish("cancelled", True, "none")
    io.restore(prev.pop())
    tid = str(row.get("transcriptEntityId") or "")
    reply = io.post("say", text=text[:4000], transcriptId=tid)
    rec["truncated"] = len(text) > 4000
    if reply is None or reply.get("status") == 409:
        # Refused before anything was typed (409), or the console was never reached
        # (None): one retry. A say that reached it with no answer is "lost" and never
        # retried, since a console restart forgets the transcript ids it typed.
        rec["say_status"] = (reply or {}).get("status")
        io.show("orchestrator not running")
        io.sleep(cfg.say_retry_s)
        reply = io.post("say", text=text[:4000], transcriptId=tid)
        rec["retried"] = True
    if not (reply and reply.get("ok")):
        rec["say_status"] = (reply or {}).get("status")
        # 502: the console tried to type it and cannot say whether it landed; lost:
        # it reached the console and no answer came back. Neither is sent again;
        # the owner checks the orchestrator terminal.
        uncertain = rec["say_status"] in (502, "lost")
        return finish("uncertain" if uncertain else "not-delivered", True, "none")
    rec["say_status"] = 200
    return finish("sent", True, "done")
