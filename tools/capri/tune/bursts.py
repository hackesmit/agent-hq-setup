import sys, numpy as np
for f in sys.argv[1:]:
    d = np.fromfile(f, dtype="<i2", offset=44).astype(np.float32) / 32768
    b = d[: len(d) // 1600 * 1600].reshape(-1, 1600)
    r = np.sqrt((b**2).mean(1)); floor = np.median(r); on = r > floor * 4
    segs = []; start = None
    for i, v in enumerate(on):
        if v and start is None: start = i
        if not v and start is not None:
            if i - start >= 2: segs.append((round(start/10, 1), round(i/10, 1), round(float(r[start:i].max()/floor), 1)))
            start = None
    print(f, round(float(floor), 5), segs)
