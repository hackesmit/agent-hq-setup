import sounddevice as sd, numpy as np, json
out = []
for i, d in enumerate(sd.query_devices()):
    if d["max_input_channels"] < 1 or sd.query_hostapis(d["hostapi"])["name"] != "MME":
        continue
    try:
        a = sd.rec(int(3 * 16000), samplerate=16000, channels=1, dtype="float32", device=i, blocking=True)
        out.append({"i": i, "name": d["name"], "rms": round(float(np.sqrt((a**2).mean())), 5)})
    except Exception as e:
        out.append({"i": i, "name": d["name"], "error": str(e)[:80]})
print(json.dumps(out, indent=0))
