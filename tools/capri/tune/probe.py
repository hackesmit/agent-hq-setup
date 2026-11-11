import sys, wave, json
from pathlib import Path
sys.path.insert(0, r"C:\Users\owner\capri")
import numpy as np
from capri import app
M = app.MODEL / "test_wavs"
def load(p):
    with wave.open(str(p), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768, w.getframerate()
kw = [l.strip() + " @" + l.strip().replace(" ", "") for l in (M / "test_keywords.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
for f in ["0.wav", "1.wav"]:
    a, r = load(M / f)
    k = app.spotter(kw, 0.25, 1.0); s = k.create_stream()
    hits = []
    for i in range(0, len(a), 1600):
        s.accept_waveform(r, a[i:i+1600])
        while k.is_ready(s):
            k.decode_stream(s); res = k.get_result(s)
            if res: hits.append(res); k.reset_stream(s)
    print(f, r, hits)
a, r = load(Path(r"C:\Users\owner\capri\tune\tts.wav"))
for kws in (["▁CA P RI @CAPRI"], ["▁CA P RI :2.5 #0.05 @CAPRI"]):
    k = app.spotter(kws, 0.05, 2.0); s = k.create_stream(); hits=[]
    for i in range(0, len(a), 1600):
        s.accept_waveform(r, a[i:i+1600])
        while k.is_ready(s):
            k.decode_stream(s); res = k.get_result(s)
            if res: hits.append((round(i/r,1), res)); k.reset_stream(s)
    tail = np.zeros(int(r*0.5), dtype=np.float32); s.accept_waveform(r, tail); s.input_finished()
    while k.is_ready(s):
        k.decode_stream(s); res = k.get_result(s)
        if res: hits.append(("end", res)); k.reset_stream(s)
    print(kws, r, len(a)/r, hits)
