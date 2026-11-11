#!/usr/bin/env python3
# Run from the repo root: python3 ops/console/v2/web/public/cues/generate.py
# Writes the nine console cues here and the five Capri-ear cues into
# archive/jarvis-ear/cues/. Edit a shape below and re-run to retune a sound; a
# hand-recorded file dropped in with the same name overrides the generated one.
"""Generate the console + Capri cue sounds as 16-bit mono WAVs (stdlib only).
Shapes match cuePlayer.ts TONES / live.py BEEPS so the browser fallback, the
shipped files, and the desk beeps all speak the same vocabulary."""
import math, struct, wave, os

SR = 44100

def env(n, total, attack=0.008, release=0.05):
    """Short attack, hold, exponential-ish release: no clicks."""
    a = int(attack*SR); r = int(release*SR)
    out = []
    for i in range(n):
        if i < a: g = i/max(1,a)
        elif i > n-r: g = max(0.0, (n-i)/max(1,r))
        else: g = 1.0
        out.append(g)
    return out

def tone(freqs, dur, gain=0.5, wave_kind="sine", glide=False, harmonics=(1.0,)):
    """freqs: list of segment frequencies. dur: seconds per segment (glide=one span)."""
    if glide:
        n = int(dur*SR)
        f0, f1 = freqs[0], freqs[-1]
        samples = []
        for i in range(n):
            t = i/SR
            # exponential glide
            f = f0 * (f1/f0)**(i/max(1,n-1))
            s = 0.0
            for k,amp in enumerate(harmonics, start=1):
                s += amp*math.sin(2*math.pi*f*k*t)
            samples.append(s/sum(harmonics))
        e = env(n, n)
        return [samples[i]*e[i]*gain for i in range(n)]
    out = []
    for f in freqs:
        n = int(dur*SR)
        seg = []
        for i in range(n):
            t = i/SR
            if wave_kind == "square":
                base = 1.0 if math.sin(2*math.pi*f*t) >= 0 else -1.0
            elif wave_kind == "triangle":
                base = 2/math.pi*math.asin(math.sin(2*math.pi*f*t))
            else:
                base = 0.0
                for k,amp in enumerate(harmonics, start=1):
                    base += amp*math.sin(2*math.pi*f*k*t)
                base /= sum(harmonics)
            seg.append(base)
        e = env(n, n)
        out += [seg[i]*e[i]*gain for i in range(n)]
    return out

def write_wav(path, samples):
    # normalize to -1..1 then to int16 with a little headroom
    peak = max(1e-6, max(abs(s) for s in samples))
    scale = 0.89/peak
    frames = b"".join(struct.pack("<h", int(max(-32767,min(32767, s*scale*32767)))) for s in samples)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(frames)
    return len(samples)/SR

# --- the nine cues, shapes from the design memo ---------------------------
CUES = {
  # two rising tones with a warm harmonic: the one that must not be missed
  "needs-you":  tone([660, 880], 0.13, 0.5, harmonics=(1.0,0.3,0.12)),
  # three insistent square-ish tones, brighter and a touch louder
  "urgent":     tone([880, 660, 880], 0.12, 0.55, "square"),
  # a single soft high tick
  "answered":   tone([1180], 0.06, 0.32, harmonics=(1.0,0.2)),
  # warm two-note fall: the reward
  "done":       tone([740, 494], 0.16, 0.46, harmonics=(1.0,0.35,0.15)),
  # short quiet click, low salience
  "dispatched": tone([1000], 0.032, 0.18, harmonics=(1.0,0.15)),
  # dull low thud, must not resemble done
  "failed":     tone([196, 147], 0.15, 0.5, "triangle", harmonics=(1.0,0.4)),
  # rising blip: the ear opened
  "listening":  tone([520, 1040], 0.16, 0.42, glide=True, harmonics=(1.0,0.25)),
  # confirming chirp: it took
  "committed":  tone([780, 1170, 780], 0.055, 0.42, harmonics=(1.0,0.3)),
  # descending blip: nothing happened
  "cancel":     tone([780, 390], 0.15, 0.4, glide=True, harmonics=(1.0,0.25)),
}

def main():
    web = "ops/console/v2/web/public/cues"
    ear = "archive/jarvis-ear/cues"
    os.makedirs(web, exist_ok=True); os.makedirs(ear, exist_ok=True)
    ear_set = {"listening","committed","cancel","done","failed"}
    for name, samples in CUES.items():
        dur = write_wav(os.path.join(web, name+".wav"), samples)
        print("%-12s %.3fs -> %s/%s.wav" % (name, dur, web, name))
        if name in ear_set:
            write_wav(os.path.join(ear, name+".wav"), samples)
    print("done")

if __name__ == "__main__":
    main()
