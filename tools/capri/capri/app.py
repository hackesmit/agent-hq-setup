"""Capri listener: mic, keyword spotting, tray icon. Entry: python -m capri [run|record|count].

run     listen for Capri (the logon task runs this with pythonw)
record  SECONDS PREFIX MIC1,MIC2: audio for threshold tuning, one wav per mic; stays on George
count   WAV [THRESHOLDS]: count Capri detections in a recording per threshold
probe   post one wake and log the reply; presses no key
flowcheck [SECONDS]: log the newest Flow History row of the last SECONDS (id, status, length; never text)
route TEXT [--run]: print the tier 0 action for TEXT; --run sends it to hands and prints the timing
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import wave
from pathlib import Path

import numpy as np

from .console import Console
from . import flow, router
from .core import Config, Dictation, claim, handle_wake

RATE = 16000
BLOCK = 1600  # 100 ms
HOME = Path(__file__).resolve().parents[1]
MODEL = HOME / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
STATE = Path(os.environ.get("LOCALAPPDATA", str(HOME))) / "capri"
LOG = STATE / "capri.jsonl"
SETTINGS = HOME / "capri.json"  # optional overrides of Config fields (threshold tuning)


def log(rec: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def load_config() -> Config:
    cfg = Config()
    if SETTINGS.exists():
        for k, v in json.loads(SETTINGS.read_text(encoding="utf-8")).items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
    return cfg


def spotter(keywords: list, threshold: float = 0.25, score: float = 1.0):
    import sherpa_onnx

    kw = STATE / "keywords.txt"
    STATE.mkdir(parents=True, exist_ok=True)
    kw.write_text("\n".join(keywords) + "\n", encoding="utf-8")
    m = "epoch-12-avg-2-chunk-16-left-64.int8.onnx"
    return sherpa_onnx.KeywordSpotter(
        tokens=str(MODEL / "tokens.txt"),
        encoder=str(MODEL / f"encoder-{m}"),
        decoder=str(MODEL / f"decoder-{m}"),
        joiner=str(MODEL / f"joiner-{m}"),
        num_threads=1,
        keywords_file=str(kw),
        keywords_score=score,
        keywords_threshold=threshold,
        provider="cpu",
    )


def detect(kws, stream, samples) -> bool:
    stream.accept_waveform(RATE, samples)
    hit = False
    while kws.is_ready(stream):
        kws.decode_stream(stream)
        if kws.get_result(stream):
            hit = True
            kws.reset_stream(stream)
    return hit


class Mic:
    """A 16 kHz mono stream into a queue, reopened when it stalls (sleep, device change)."""

    def __init__(self, device=None):
        self.device = device
        self.q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=600)
        self.stream = None

    def _cb(self, data, frames, t, status):
        try:
            self.q.put_nowait(data[:, 0].copy())
        except queue.Full:
            pass

    def open(self) -> None:
        import sounddevice as sd

        self.close()
        sd._terminate()  # re-enumerate devices: the default may have changed during sleep
        sd._initialize()
        self.open_shared()

    def open_shared(self) -> None:
        """Open without re-enumerating (a second mic while another stream runs)."""
        import sounddevice as sd

        dev = None
        if self.device:
            dev = next((i for i, d in enumerate(sd.query_devices()) if self.device in d["name"] and d["max_input_channels"] > 0), None)
        self.stream = sd.InputStream(device=dev, samplerate=RATE, channels=1, dtype="float32", blocksize=BLOCK, callback=self._cb)
        self.stream.start()

    def close(self) -> None:
        if self.stream is not None:
            try:
                self.stream.close()
            except Exception:
                pass
            self.stream = None

    def drain(self) -> None:
        while not self.q.empty():
            self.q.get_nowait()

    def block(self, timeout: float = 3.0) -> np.ndarray:
        return self.q.get(timeout=timeout)


class WinIo:
    def __init__(self, cfg: Config, mic: Mic, floor: float):
        from . import win

        self.win, self.cfg, self.mic, self.floor = win, cfg, mic, floor
        self.console = CONSOLE
        self.box = BOX
        self.hands = HANDS
        self.prev = None  # the window the owner had before the Capri window took the focus

    now = staticmethod(time.monotonic)
    wall = staticmethod(time.time)
    sleep = staticmethod(time.sleep)

    def chime(self, kind):
        self.win.chime(kind)

    def post(self, event, **fields):
        if event == "say":
            # Tier 0 (hq-63nvj.4): a common command runs here through hands, no model.
            done = router.dispatch(fields.get("text", ""), self.hands, log, hwnd=self.prev)
            if done is not None:
                return done
        return self.console.post(event, **fields)

    def focus_capri(self, state):
        self.prev = self.box.focus(state)
        return self.prev

    def show(self, state):
        if state is None:
            self.box.hide()
        else:
            self.box.show(state)

    def restore(self, prev):
        self.box.restore(prev)

    def hotkey(self):
        self.win.hotkey()

    def history(self, t0):
        return flow.first_after(t0)

    def row(self, tid):
        return flow.row_by_id(tid)

    def flow_mark(self):
        return flow.last_rowid()

    def flow_busy(self, mark, t0):
        return flow.stopped_since(mark, t0)

    def wait_dictation(self):
        self.mic.drain()
        d = Dictation(self.floor, self.cfg, time.monotonic())
        while True:
            try:
                level = float(np.sqrt(np.mean(self.mic.block() ** 2)))
            except queue.Empty:
                level = 0.0
            end = d.feed(level, time.monotonic())
            if end:
                return end

    def log(self, rec):
        log(rec)


CONSOLE: Console = None  # type: ignore[assignment]
BOX = None  # the Capri window (win.CapriWindow), made once per process
HANDS: router.Hands = None  # type: ignore[assignment]  # Capri hands on 127.0.0.1


def hands_port() -> int:
    """capri.json may set {"hands_port": N}, the port in hands.json beside Capri hands."""
    try:
        return int(json.loads(SETTINGS.read_text(encoding="utf-8")).get("hands_port", 47615))
    except (OSError, ValueError, AttributeError):
        return 47615


def listen(cfg: Config, muted: threading.Event, stop: threading.Event) -> None:
    global CONSOLE, BOX, HANDS
    from . import win

    CONSOLE = Console(cfg.base_url)
    HANDS = router.Hands(port=hands_port())
    BOX = win.CapriWindow()
    kws = spotter(cfg.keywords, cfg.threshold, cfg.score)
    mic = Mic(cfg.device)
    levels: list = []
    log({"ev": "start", "keywords": cfg.keywords})
    while not stop.is_set():
        try:
            mic.open()
            stream = kws.create_stream()
            while not stop.is_set():
                block = mic.block()
                if muted.is_set():
                    continue
                levels.append(float(np.sqrt(np.mean(block**2))))
                del levels[:-50]
                if detect(kws, stream, block):
                    floor = float(np.median(levels))
                    try:
                        handle_wake(WinIo(cfg, mic, floor), cfg)
                    except Exception as e:  # one bad wake must not kill the ear
                        log({"ev": "error", "where": "wake", "error": repr(e)})
                    mic.drain()
                    stream = kws.create_stream()
        except queue.Empty:
            log({"ev": "reopen", "why": "no audio for 3 s"})
        except Exception as e:
            log({"ev": "reopen", "why": repr(e)})
            time.sleep(2)
    mic.close()


def tray(muted: threading.Event, stop: threading.Event):
    import pystray
    from PIL import Image, ImageDraw

    def image(off: bool):
        im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        ImageDraw.Draw(im).ellipse((6, 6, 58, 58), fill=(110, 110, 110) if off else (226, 60, 120))
        return im

    def toggle(icon, item):
        if muted.is_set():
            muted.clear()
        else:
            muted.set()
        icon.icon = image(muted.is_set())
        log({"ev": "mute" if muted.is_set() else "unmute"})

    def quit_(icon, item):
        stop.set()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Mute", toggle, checked=lambda item: muted.is_set()),
        pystray.MenuItem("Quit", quit_),
    )
    return pystray.Icon("capri", image(False), "Capri", menu)


def single_instance() -> bool:
    import ctypes

    k32 = ctypes.windll.kernel32
    k32.CreateMutexW.restype = ctypes.c_void_p
    k32.CloseHandle.argtypes = [ctypes.c_void_p]

    def try_once() -> bool:
        h = k32.CreateMutexW(None, False, "Local\\hq-capri-listener")
        if h and k32.GetLastError() != 183:  # ERROR_ALREADY_EXISTS
            return True  # the handle stays open for the life of the process
        if h:
            k32.CloseHandle(h)  # our handle would keep the mutex alive after the old run dies
        return False

    return claim(try_once, time.sleep)


def run() -> None:
    if not single_instance():
        return
    cfg = load_config()
    muted, stop = threading.Event(), threading.Event()
    t = threading.Thread(target=listen, args=(cfg, muted, stop), daemon=True)
    t.start()
    tray(muted, stop).run()
    stop.set()


def record(seconds: float, prefix: str, names: list) -> None:
    """Record every named mic at once to PREFIX-<name>.wav (tuning only; files stay on George)."""
    mics = {n: Mic(n) for n in names}
    files = {}
    for n, m in mics.items():
        m.open() if not files else m.open_shared()
        w = wave.open(f"{prefix}-{n}.wav", "wb")
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        files[n] = w
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        for n, m in mics.items():
            while not m.q.empty():
                files[n].writeframes((np.clip(m.q.get_nowait(), -1, 1) * 32767).astype("<i2").tobytes())
        time.sleep(0.05)
    for n, m in mics.items():
        m.close()
        files[n].close()


def count(path: str, thresholds: list) -> None:
    cfg = load_config()
    with wave.open(path, "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    hours = len(audio) / RATE / 3600
    for th in thresholds:
        kws = spotter(cfg.keywords, th, cfg.score)
        s = kws.create_stream()
        hits = []
        for i in range(0, len(audio), BLOCK):
            if detect(kws, s, audio[i : i + BLOCK]):
                hits.append(round(i / RATE, 1))
        print(json.dumps({"threshold": th, "hits": len(hits), "per_hour": round(len(hits) / hours, 2), "at_s": hits[:20]}))


def probe() -> None:
    """Post one wake and log the reply; presses no key."""
    cfg = load_config()
    log({"ev": "probe", "reply": Console(cfg.base_url).post("wake")})


def flowcheck(seconds: float) -> None:
    """Can the listener read Flow's history? Logs id, status and length, never the text."""
    row = flow.newest_after(time.time() - seconds)
    text = flow.pick_text(row, allow_raw=True)
    rec = {"ev": "flowcheck", "db": flow.FLOW_DB.exists(), "found": row is not None}
    if row:
        rec.update(transcriptId=row.get("transcriptEntityId"), status=row.get("status"), chars=len(text or ""))
    log(rec)
    print(json.dumps(rec))


def route_cmd(text: str, run_it: bool) -> None:
    """Live probe of tier 0: the routed action, and with --run the hands reply and ms."""
    r = router.route(text)
    out: dict = {"tier": 0 if r else 2, "kind": r.kind if r else None, "action": r.action if r else None}
    if r and run_it:
        t0 = time.perf_counter()
        out["reply"] = router.dispatch(text, router.Hands(port=hands_port()), log)
        out["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    print(json.dumps(out, ensure_ascii=False))


def main(argv: list) -> None:
    cmd = argv[0] if argv else "run"
    if cmd == "run":
        run()
    elif cmd == "probe":
        probe()
    elif cmd == "flowcheck":
        flowcheck(float(argv[1]) if len(argv) > 1 else 600)
    elif cmd == "route" and len(argv) >= 2:
        route_cmd(argv[1], "--run" in argv[2:])
    elif cmd == "record":
        record(float(argv[1]), argv[2], argv[3].split(","))
    elif cmd == "count":
        count(argv[1], [float(x) for x in (argv[2].split(",") if len(argv) > 2 else ["0.25"])])
    else:
        print(__doc__)
