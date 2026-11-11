"""File-fed benchmark: synth the phrase set, then run VAD, STT, LLM, tool, TTS per phrase and time each stage.

End to end = VAD tail (end of speech to end detected, audio time) + STT + LLM to first speakable piece
+ tool + TTS of that piece. Speaker output latency is measured by the live run, not here.
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import brain, core, tools
from .ears import FRAME, SR, Endpointer, Stt, Vad
from .mouth import Tts

HERE = Path(__file__).resolve().parents[1]
INPUT_VOICES = {"es": ("em_alex", "es"), "en": ("am_adam", "en-us")}


def resample(x: np.ndarray, sr_in: int, sr_out: int = SR) -> np.ndarray:
    if sr_in == sr_out:
        return x.astype(np.float32)
    n = int(len(x) * sr_out / sr_in)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def synth_inputs(tts: Tts, out: Path, phrases: list[dict] = core.PHRASES) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for p in phrases:
        voice, code = INPUT_VOICES[p["lang"]]
        audio, sr = tts.k.create(p["text"], voice=voice, speed=1.0, lang=code)
        x = resample(audio, sr)
        x = np.concatenate([np.zeros(int(0.3 * SR)), x, np.zeros(int(1.5 * SR))]).astype(np.float32)
        sf.write(out / f"{p['id']}.wav", x, SR)


def vram_mb() -> int:
    r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                       capture_output=True, text=True)
    return int(r.stdout.strip().splitlines()[0])


def segment(vad: Vad, x: np.ndarray, silence_ms: int) -> dict:
    """Stream x through the VAD; return the utterance and the tail (end of speech to end detected)."""
    vad.reset()
    ep = Endpointer(silence_ms=silence_ms)
    start = last_voiced = None
    t_vad = 0.0
    for i in range(0, len(x) - FRAME + 1, FRAME):
        t0 = time.perf_counter()
        prob = vad.feed(x[i:i + FRAME])
        t_vad += time.perf_counter() - t0
        if prob >= ep.th:
            last_voiced = i + FRAME
        ev = ep.step(prob)
        if ev == "start":
            start = max(0, i - 6 * FRAME)
        elif ev == "end":
            end = i + FRAME
            return {"audio": x[start:end], "tail_ms": (end - last_voiced) / SR * 1000,
                    "vad_cpu_ms": t_vad * 1000, "frames": i // FRAME + 1}
    raise RuntimeError("VAD found no end of speech")


def unload_all(keep: str | None = None) -> None:
    import http.client

    conn = http.client.HTTPConnection(brain.HOST, brain.PORT, timeout=30)
    conn.request("GET", "/api/ps")
    running = json.loads(conn.getresponse().read()).get("models", [])
    conn.close()
    for m in running:
        if m["name"] != keep:
            c = http.client.HTTPConnection(brain.HOST, brain.PORT, timeout=60)
            c.request("POST", "/api/generate", body=json.dumps({"model": m["name"], "keep_alive": 0}))
            c.getresponse().read()
            c.close()
    time.sleep(1.5)


def run(models: list[str], stt_sizes: list[str], silence_ms: int, out: Path, set_name: str = "mixed",
        stt_lang: str | None = None) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    log = (out / "timing.jsonl").open("a", encoding="utf-8")
    phrases = core.phrase_set(set_name)
    inputs = HERE / core.inputs_dir_name(set_name)
    base_vram = vram_mb()
    tts = Tts()
    if not (inputs / f"{phrases[0]['id']}.wav").exists():
        synth_inputs(tts, inputs, phrases)
    vad = Vad()
    rows = []
    for size in stt_sizes:
        stt = Stt(size, lang=stt_lang)
        stt(np.zeros(SR, dtype=np.float32))  # warm
        for model in models:
            unload_all()
            brain.chat(model, "hola")  # load and warm
            tts("Listo.", "es")
            vram = vram_mb()
            for p in phrases:
                x, _ = sf.read(inputs / f"{p['id']}.wav", dtype="float32")
                seg = segment(vad, x, silence_ms)
                heard = stt(seg["audio"])
                said = brain.chat(model, heard["text"])
                if said["calls"]:
                    result, tool_ms = tools.run(said["calls"][0], dry=True)
                    speech = core.tool_speech(said["calls"][0], heard["lang"], result)
                else:
                    tool_ms, speech = 0.0, core.first_sentence(said["text"], done=True) or "..."
                audio, sr, tts_ms = tts(speech, heard["lang"])
                ok, why = core.score(p["expect"], said["calls"])
                row = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "phrase": p["id"], "said": p["text"],
                    "model": model, "stt": size, "silence_ms": silence_ms, "set": set_name, "stt_lang": stt_lang,
                    "heard": heard["text"], "lang": heard["lang"], "lang_p": heard["lang_p"], "stt_redo": heard["redo"],
                    "vad_tail_ms": round(seg["tail_ms"]), "stt_ms": round(heard["ms"]),
                    "llm_first_ms": round(said["first_ms"]), "llm_total_ms": round(said["total_ms"]),
                    "tool_ms": round(tool_ms, 1), "tts_ms": round(tts_ms),
                    "calls": said["calls"], "raw_calls": said["raw_calls"],
                    "strict_ok": core.score(p["expect"], said["raw_calls"])[0], "reply_text": said["text"][:200], "speech": speech,
                    "tool_ok": ok, "tool_why": why, "vram_mb": vram, "vram_base_mb": base_vram,
                    "tts_provider": tts.provider,
                }
                row["e2e_ms"] = round(row["vad_tail_ms"] + heard["ms"] + said["first_ms"] + tool_ms + tts_ms)
                rows.append(row)
                log.write(json.dumps(row, ensure_ascii=False) + "\n")
                log.flush()
                sf.write(out / f"reply-{model.replace(':', '_')}-{size}-{p['id']}.wav", audio, sr)
                print(f"{p['id']} {model} {size} e2e={row['e2e_ms']} heard={heard['text']!r} "
                      f"calls={said['calls']} ok={ok}", flush=True)
        del stt
    log.close()
    return rows


def text_accuracy(models: list[str], out: Path, set_name: str = "mixed") -> list[dict]:
    """Tool accuracy on the exact phrase text (no STT errors), one row per model and phrase."""
    rows = []
    with (out / "accuracy.jsonl").open("a", encoding="utf-8") as log:
        for model in models:
            unload_all()
            brain.chat(model, "hola")
            for p in core.phrase_set(set_name):
                said = brain.chat(model, p["text"])
                ok, why = core.score(p["expect"], said["calls"])
                row = {"model": model, "set": set_name, "phrase": p["id"], "ok": ok, "why": why, "calls": said["calls"],
                       "raw_calls": said["raw_calls"], "strict_ok": core.score(p["expect"], said["raw_calls"])[0],
                       "text": said["text"][:200], "first_ms": round(said["first_ms"])}
                rows.append(row)
                log.write(json.dumps(row, ensure_ascii=False) + "\n")
    return rows


def acoustic(path: Path) -> dict:
    """Segment a live session recording with the VAD and measure phrase-end to reply-start gaps."""
    x, sr = sf.read(path, dtype="float32")
    vad = Vad()
    segs, start, last = [], None, None
    for i in range(0, len(x) - FRAME + 1, FRAME):
        t = i / SR
        if vad.feed(x[i:i + FRAME]) >= 0.5:
            if start is None:
                start = t
            last = t + FRAME / SR
        elif start is not None and t - last >= 0.25:
            segs.append((round(start, 3), round(last, 3)))
            start = None
    if start is not None:
        segs.append((round(start, 3), round(last, 3)))
    gaps = core.reply_gaps(segs)
    return {"segments": segs, "gaps_ms": gaps, "p50": round(core.p50(gaps)) if gaps else None,
            "max": max(gaps) if gaps else None}
