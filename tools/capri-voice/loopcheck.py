import numpy as np, sounddevice as sd, soundfile as sf, time
x, sr = sf.read(r"C:\Users\owner\capri-voice\inputs\p01.wav", dtype="float32")
x = x[int(0.3*sr):int(1.3*sr)]
buf = []
with sd.InputStream(samplerate=sr, channels=1, device=2, callback=lambda d, n, t, s: buf.append(d[:, 0].copy())):
    time.sleep(1.0)
    for out in (7, 5):
        buf.clear(); time.sleep(1.0); sd.play(x, sr, device=out); sd.wait(); time.sleep(1.0)
        r = np.concatenate(buf); w = lambda a, b: round(float(np.sqrt(np.mean(r[int(a*sr):int(b*sr)] ** 2))), 5)
        print(out, "before", w(0.1, 0.9), "during", w(1.1, 2.0), "after", w(2.2, 2.9), flush=True)
