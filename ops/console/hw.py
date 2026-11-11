#!/usr/bin/env python3
"""Hardware health for the mini pc: CPU, memory, swap, disks, temperatures,
uptime, the processes actually eating the box, and the health reports two root
jobs leave behind (disk S.M.A.R.T. and the restic backup).

Reads /proc and /sys directly, no subprocesses, so it costs about a millisecond
and is safe to run behind the dashboard's 3s poll. CPU utilisation needs two
samples, so the previous /proc/stat reading is kept in the same cache file and
the delta is taken against it; the first call after a restart reports the
since-boot average and every call after that is a true interval measurement.

usage: hw.py [--state <dir>]
"""
import json
import os
import sys
import time

CACHE = "hw-sample.json"
# Written by root jobs this script cannot do itself (smartctl needs root):
# ops/services/disk-health/hq-disk-health.sh and ops/services/restic-backup/.
HEALTH_DIR = os.environ.get("HQ_HEALTH_DIR", "/var/lib/hq-health")


def read(path, default=""):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except Exception:
        return default


def cpu_sample():
    """Aggregate jiffies from /proc/stat: (idle, total)."""
    line = read("/proc/stat").split("\n")[0]
    parts = [int(x) for x in line.split()[1:] if x.isdigit()]
    if len(parts) < 4:
        return None
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)   # idle + iowait
    return idle, sum(parts)


def meminfo():
    out = {}
    for line in read("/proc/meminfo").split("\n"):
        k, _, rest = line.partition(":")
        v = rest.strip().split(" ")[0]
        if v.isdigit():
            out[k] = int(v) * 1024
    return out


def temps():
    """Every readable sensor. Some zones exist but error on read, so each one is
    attempted independently rather than trusting the directory listing."""
    found = []
    for base in ("/sys/class/hwmon",):
        try:
            entries = sorted(os.listdir(base))
        except OSError:
            continue
        for h in entries:
            hp = os.path.join(base, h)
            name = read(os.path.join(hp, "name"), h)
            try:
                files = sorted(f for f in os.listdir(hp)
                               if f.startswith("temp") and f.endswith("_input"))
            except OSError:
                continue
            for f in files:
                raw = read(os.path.join(hp, f))
                if not raw.lstrip("-").isdigit():
                    continue
                c = int(raw) / 1000.0
                if not (-50 < c < 150):
                    continue
                label = read(os.path.join(hp, f.replace("_input", "_label")), "")
                found.append({"name": name, "label": label or f.replace("_input", ""),
                              "c": round(c, 1)})
    return found


def disks():
    out = []
    seen = set()
    for line in read("/proc/mounts").split("\n"):
        bits = line.split()
        if len(bits) < 3:
            continue
        dev, mount, fstype = bits[0], bits[1], bits[2]
        if fstype in ("tmpfs", "devtmpfs", "squashfs", "overlay", "proc", "sysfs",
                      "cgroup2", "efivarfs", "devpts", "autofs", "fusectl",
                      "securityfs", "pstore", "bpf", "tracefs", "debugfs",
                      "configfs", "ramfs", "hugetlbfs", "mqueue", "nsfs", "binfmt_misc"):
            continue
        if not dev.startswith("/dev/") or mount in seen:
            continue
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total < 1 << 30:          # ignore boot slivers
            continue
        free = st.f_bavail * st.f_frsize
        seen.add(mount)
        out.append({"mount": mount, "total": total, "free": free,
                    "pct": round(100.0 * (total - free) / total, 1)})
    return sorted(out, key=lambda d: -d["total"])[:4]


def top_procs(n=5):
    """Biggest resident processes, by EXECUTABLE NAME only.

    Deliberately never /proc/<pid>/cmdline. Command lines routinely carry
    secrets (bearer tokens, database URLs, signed links, passwords passed as
    flags), and this output is published to every console client. Truncating
    would not help: the secret is usually near the front. comm plus pid and RSS
    answers "what is eating the box" without disclosing anything."""
    out = []
    for e in os.listdir("/proc"):
        if not e.isdigit():
            continue
        rss = 0
        for line in read("/proc/%s/status" % e).split("\n"):
            if line.startswith("VmRSS:"):
                v = line.split()[1]
                rss = int(v) * 1024 if v.isdigit() else 0
                break
        if not rss:
            continue
        name = read("/proc/%s/comm" % e, "?")[:32]
        out.append({"pid": int(e), "rss": rss, "cmd": name or "?"})
    return sorted(out, key=lambda p: -p["rss"])[:n]


def health_report(name):
    """One of the root-written reports, or None. They are small JSON objects; a
    missing, oversized or malformed file is simply no report, never an error."""
    path = os.path.join(HEALTH_DIR, name)
    try:
        if os.path.getsize(path) > 64 * 1024:
            return None
        with open(path) as fh:
            data = json.load(fh)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def main():
    state = None
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--state" and i + 1 < len(argv):
            state = argv[i + 1]
    state = state or os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), "state")
    wr = os.path.join(state, "console")
    os.makedirs(wr, exist_ok=True)
    cpath = os.path.join(wr, CACHE)

    prev = {}
    try:
        with open(cpath) as fh:
            prev = json.load(fh)
    except Exception:
        pass

    cur = cpu_sample()
    cpu_pct = None
    if cur:
        pi, pt = prev.get("idle"), prev.get("total")
        if isinstance(pi, int) and isinstance(pt, int) and cur[1] > pt:
            didle, dtotal = cur[0] - pi, cur[1] - pt
            if dtotal > 0:
                cpu_pct = round(max(0.0, min(100.0, 100.0 * (1 - didle / dtotal))), 1)
        elif cur[1]:
            cpu_pct = round(100.0 * (1 - cur[0] / cur[1]), 1)
        try:
            tmp = "%s.%d.tmp" % (cpath, os.getpid())
            with open(tmp, "w") as fh:
                json.dump({"idle": cur[0], "total": cur[1], "ts": time.time()}, fh)
            os.replace(tmp, cpath)
        except Exception:
            pass

    m = meminfo()
    mt, ma = m.get("MemTotal", 0), m.get("MemAvailable", 0)
    st, sf = m.get("SwapTotal", 0), m.get("SwapFree", 0)
    load = read("/proc/loadavg").split()[:3]
    up = read("/proc/uptime").split(" ")[0]
    t = temps()
    print(json.dumps({
        "cpu": {"pct": cpu_pct, "cores": os.cpu_count() or 0,
                "load": [float(x) for x in load] if len(load) == 3 else []},
        "mem": {"total": mt, "used": mt - ma, "avail": ma,
                "pct": round(100.0 * (mt - ma) / mt, 1) if mt else None},
        "swap": {"total": st, "used": st - sf,
                 "pct": round(100.0 * (st - sf) / st, 1) if st else None},
        "temps": t,
        "temp_max": max((x["c"] for x in t), default=None),
        "disks": disks(),
        "uptime_s": int(float(up)) if up.replace(".", "").isdigit() else 0,
        "procs": top_procs(),
        "health": {"disk": health_report("disk.json"), "backup": health_report("backup.json")},
    }))


if __name__ == "__main__":
    main()
