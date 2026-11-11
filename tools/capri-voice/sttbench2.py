import sys, time; sys.path.insert(0, r"C:\Users\owner\capri-voice")
import soundfile as sf
from voice.ears import Stt
for size in ("large-v3-turbo", "small"):
    s = Stt(size)
    for pid in ("p01","p02","p03","p04","p05","p06","p07","p08","p09","p10"):
        x, _ = sf.read(rf"C:\Users\owner\capri-voice\inputs\{pid}.wav", dtype="float32"); x = x[:-int(1.3*16000)]
        s(x); r = [s(x) for _ in range(3)]
        print(size, pid, round(sorted(z["ms"] for z in r)[1]), r[0]["text"], r[0]["lang"], r[0]["detected"], r[0]["lang_p"])
