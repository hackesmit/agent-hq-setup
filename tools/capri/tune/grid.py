import sys, json, wave
sys.path.insert(0, r"C:\Users\owner\capri")
import numpy as np, sentencepiece as spm
from capri import app
sp = spm.SentencePieceProcessor(model_file=str(app.MODEL / "bpe.model"))
def kw(words): return [" ".join(sp.encode(w, out_type=str)) + " @CAPRI" for w in words]
def load(p):
    with wave.open(p, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
files = sys.argv[1].split(",")
audio = {f: load(f) for f in files}
sets = {"capri": ["CAPRI"], "variants": ["CAPRI", "CAPREE", "KAPRI", "CAPRY", "COPPRY"], "v2": ["CAPRI", "CAPREE", "CAPRIE", "KAPREE"]}
for name, words in sets.items():
    print(name, kw(words))
    for score in (1.0, 2.0, 3.0):
        for th in [float(x) for x in sys.argv[2].split(",")]:
            row = {"set": name, "score": score, "th": th}
            for f, a in audio.items():
                k = app.spotter(kw(words), th, score); s = k.create_stream(); hits = []
                for i in range(0, len(a), 1600):
                    if app.detect(k, s, a[i:i+1600]): hits.append(round(i/16000, 1))
                row[f.split("-")[-1]] = (len(hits), hits) if len(a) < 16000 * 120 else len(hits)
            print(json.dumps(row))
