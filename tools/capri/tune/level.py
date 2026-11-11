import sys, numpy as np
d = np.fromfile(sys.argv[1], dtype="<i2", offset=44).astype(np.float32) / 32768
b = d[: len(d) // 1600 * 1600].reshape(-1, 1600)
r = np.sqrt((b**2).mean(1))
print({"seconds": len(d) / 16000, "rms_median": float(np.median(r)), "rms_p95": float(np.percentile(r, 95)), "rms_max": float(r.max())})
