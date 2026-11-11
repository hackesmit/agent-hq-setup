import sys, time; sys.path.insert(0, r"C:\Users\owner\capri-voice")
import numpy as np, soundfile as sf
from voice.ears import add_cuda_dlls; add_cuda_dlls()
from faster_whisper import WhisperModel
from voice.mouth import Tts
x, _ = sf.read(r"C:\Users\owner\capri-voice\inputs\p07.wav", dtype="float32"); x = x[:int(1.8*16000)]
for size, ct in (("large-v3-turbo","int8_float16"),("large-v3-turbo","float16"),("small","float16"),("small","int8_float16")):
    m = WhisperModel(rf"C:\Users\owner\capri-voice\models\faster-whisper-{size}", device="cuda", compute_type=ct)
    for lang in (None, "es"):
        list(m.transcribe(x, beam_size=1, language=lang)[0])
        ts = []
        for _ in range(5):
            t0 = time.perf_counter(); segs, info = m.transcribe(x, beam_size=1, language=lang, without_timestamps=True); txt = " ".join(s.text for s in segs); ts.append((time.perf_counter()-t0)*1000)
        print(size, ct, lang, round(min(ts)), round(sorted(ts)[2]), txt, info.language, round(info.language_probability,2))
    del m
t = Tts(); print("tts provider", t.provider)
for txt, l in (("Subo el volumen.", "es"), ("Son las 12:55 de la tarde de miércoles 04 de noviembre de 2026.", "es"), ("On it, passing that to the orchestrator.", "en")):
    t(txt, l); ms = sorted(t(txt, l)[2] for _ in range(5)); print("tts", l, round(ms[2]), txt)
