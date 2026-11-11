"""Live loop: mic, VAD, STT, LLM with tools, TTS to speakers. Half duplex: the mic is ignored while Capri speaks.

Run in the owner's interactive session (scheduled task /IT); audio never leaves George.
--play-inputs plays the synthesized phrases through the speakers so the mic hears them: an acoustic
end to end measurement with no person in the loop. e2e = reply playback start minus the moment the
phrase's speech ended on the speaker (both on the same clock; device latencies on both ends cancel
except for the input buffer, which is counted).
"""
from __future__ import annotations

import json
import queue
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import brain, core, tools
from .ears import FRAME, SR, Endpointer, Stt, Vad
from .mouth import Tts

HERE = Path(__file__).resolve().parents[1]


def find_device(name: str | None, kind: str) -> int | None:
    import sounddevice as sd

    if not name:
        return None
    for i, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d[f"max_{kind}_channels"] > 0 and d["hostapi"] == 0:
            return i
    return None


def speech_bounds(path: Path, vad: Vad) -> tuple[np.ndarray, int, float]:
    """Trim a phrase file and return (audio, sr, seconds from play start to end of speech)."""
    x, sr = sf.read(path, dtype="float32")
    vad.reset()
    last = 0
    for i in range(0, len(x) - FRAME + 1, FRAME):
        if vad.feed(x[i:i + FRAME]) >= 0.5:
            last = i + FRAME
    x = x[: last + int(0.2 * sr)]
    return x, sr, last / sr


def run(model: str, stt_size: str, silence_ms: int, out: Path, *, mic: str | None, speaker: str | None,
        seconds: float, play_inputs: bool, dry: bool, set_name: str = "mixed", stt_lang: str | None = None) -> None:
    import sounddevice as sd

    out.mkdir(parents=True, exist_ok=True)
    log = (out / "live.jsonl").open("a", encoding="utf-8")
    phrases = core.phrase_set(set_name)
    inputs = HERE / core.inputs_dir_name(set_name)
    vad, ep, stt, tts = Vad(), Endpointer(silence_ms=silence_ms), Stt(stt_size, lang=stt_lang), Tts()
    stt(np.zeros(SR, dtype=np.float32))
    brain.chat(model, "hola")
    tts("Listo.", "es")
    in_dev, out_dev = find_device(mic, "input"), find_device(speaker, "output")

    frames: queue.Queue = queue.Queue()
    mic_rec: list[np.ndarray] = []
    speaking = threading.Event()
    marks: list[dict] = []  # phrase end times from the player thread

    def on_mic(indata, n, t, status):
        frames.put((time.perf_counter(), indata[:, 0].copy()))

    reply_out = sd.OutputStream(samplerate=24000, channels=1, dtype="float32", device=out_dev)
    reply_out.start()

    def player():
        pv = Vad()
        time.sleep(2.0)
        for p in phrases:
            x, sr, end_s = speech_bounds(inputs / f"{p['id']}.wav", pv)
            while speaking.is_set():
                time.sleep(0.05)
            t0 = time.perf_counter()
            sd.play(x, sr, device=out_dev)
            marks.append({"phrase": p["id"], "said": p["text"], "speech_end": t0 + end_s})
            sd.wait()
            time.sleep(7.0)

    info = {"model": model, "stt": stt_size, "silence_ms": silence_ms, "mic": mic, "in_dev": in_dev,
            "out_dev": out_dev, "out_latency_s": reply_out.latency, "play_inputs": play_inputs, "dry": dry,
            "set": set_name, "stt_lang": stt_lang}
    log.write(json.dumps({"session": info}) + "\n")
    print("listening", info, flush=True)

    buf: list[np.ndarray] = []
    pre: list[np.ndarray] = []
    last_voiced_t = None
    with sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=FRAME, device=in_dev,
                        callback=on_mic):
        if play_inputs:
            threading.Thread(target=player, daemon=True).start()
        t_stop = time.perf_counter() + seconds
        while time.perf_counter() < t_stop:
            try:
                t_frame, fr = frames.get(timeout=0.5)
            except queue.Empty:
                continue
            mic_rec.append(fr)
            if speaking.is_set():
                continue
            prob = vad.feed(fr)
            ev = ep.step(prob)
            if ep.in_speech or ev == "end":
                buf.append(fr)
                if prob >= ep.th:
                    last_voiced_t = t_frame
            else:
                pre = (pre + [fr])[-6:]
            if ev == "start":
                buf = pre + buf
            if ev != "end":
                continue
            t_end = time.perf_counter()
            audio = np.concatenate(buf)
            buf, pre = [], []
            speaking.set()
            heard = stt(audio)
            said = brain.chat(model, heard["text"]) if heard["text"] else {"calls": [], "text": "", "first_ms": 0, "total_ms": 0}
            if said["calls"]:
                result, tool_ms = tools.run(said["calls"][0], dry=dry)
                speech = core.tool_speech(said["calls"][0], heard["lang"], result)
            else:
                result, tool_ms = None, 0.0
                speech = core.first_sentence(said["text"], done=True) or ""
            row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "heard": heard["text"], "lang": heard["lang"],
                   "stt_ms": round(heard["ms"]), "llm_first_ms": round(said["first_ms"]),
                   "calls": said["calls"], "tool_ms": round(tool_ms, 1), "tool_result": result, "speech": speech,
                   "vad_tail_ms": round((t_end - last_voiced_t) * 1000) if last_voiced_t else None}
            if speech:
                wav, sr, tts_ms = tts(speech, heard["lang"])
                t_play = time.perf_counter()
                row["tts_ms"] = round(tts_ms)
                row["detect_to_play_ms"] = round((t_play - t_end) * 1000)
                if marks:
                    m = marks[-1]
                    row.update(phrase=m["phrase"], said=m["said"],
                               e2e_acoustic_ms=round((t_play - m["speech_end"]) * 1000))
                    row["tool_ok"], row["tool_why"] = core.score(
                        next(p["expect"] for p in phrases if p["id"] == m["phrase"]), said["calls"])
                reply_out.write(wav.astype(np.float32).reshape(-1, 1))
                # write() returns once the audio is queued; wait until it has played, or the mic hears Capri
                left = len(wav) / sr + reply_out.latency + 0.3 - (time.perf_counter() - t_play)
                time.sleep(max(0.0, left))
            # drain what the mic heard while we were busy or speaking
            while not frames.empty():
                mic_rec.append(frames.get_nowait()[1])
            vad.reset()
            ep.reset()
            speaking.clear()
            log.write(json.dumps(row, ensure_ascii=False) + "\n")
            log.flush()
            print(row, flush=True)
    reply_out.stop()
    sf.write(out / "session-mic.wav", np.concatenate(mic_rec) if mic_rec else np.zeros(1), SR)
    log.close()
