#!/usr/bin/env bash
# session-registry.sh — single-writer CRUD over the HQ session registry.
# Storage: ${HQ_STATE_DIR:-$HQ/state}/sessions.json (JSON object keyed by id).
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${HQ_STATE_DIR:-$HQ/state}"
REG="$STATE_DIR/sessions.json"
mkdir -p "$STATE_DIR"
[ -f "$REG" ] || printf '%s\n' '{}' > "$REG"
export REG
python3 - "$@" <<'PY'
import json, os, sys, time
REG = os.environ["REG"]
def load():
    try:
        with open(REG) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"session-registry: refusing to proceed — registry unreadable/corrupt: {e}", file=sys.stderr)
        sys.exit(3)
def save(d):
    tmp = REG + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=2, sort_keys=True)
    os.replace(tmp, REG)
def now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
def parse(argv):
    o = {}; i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            k = a[2:]
            if i+1 < len(argv) and not argv[i+1].startswith("--"): o[k]=argv[i+1]; i+=2
            else: o[k]=True; i+=1
        else: o.setdefault("_pos", []).append(a); i+=1
    return o
cmd = sys.argv[1] if len(sys.argv) > 1 else ""
o = parse(sys.argv[2:])
# hq-4npjr.25: every writing subcommand holds an exclusive flock on a sidecar
# file from load through save, so a register cannot be lost to a reconcile that
# loaded earlier and saves later. The lock is waited on for at most
# HQ_REGISTRY_LOCK_TIMEOUT seconds (default 10), then exit 4 with no write:
# SessionStart must never hang. The kernel drops the lock when this process ends.
if cmd in ("register", "update", "deregister", "reconcile"):
    import fcntl
    _lk = open(REG + ".lock", "a")
    _deadline = time.monotonic() + float(os.environ.get("HQ_REGISTRY_LOCK_TIMEOUT", "10"))
    while True:
        try:
            fcntl.flock(_lk, fcntl.LOCK_EX | fcntl.LOCK_NB); break
        except BlockingIOError:
            if time.monotonic() >= _deadline:
                print(f"session-registry: {REG}.lock held too long; {cmd} not applied", file=sys.stderr)
                sys.exit(4)
            time.sleep(0.05)
d = load()
def need_id():
    i = o.get("id") or (o.get("_pos") or [None])[0]
    if not i: print("error: id required", file=sys.stderr); sys.exit(2)
    return i
if cmd == "register":
    i = need_id()
    d[i] = {"id": i, "kind": o.get("kind","interactive"), "rig": o.get("rig",""),
            "worktree": o.get("worktree",""), "branch": o.get("branch",""),
            "bead": o.get("bead",""), "tmux_window": o.get("window",""),
            "model": o.get("model",""), "status": "active", "started": now(),
            "wake_at": None, "objectives_file": o.get("objectives",""), "last_seen": now()}
    # hq-4npjr.10: a --force spawn over a held bead records who forced it and over what
    if isinstance(o.get("forced-by"), str) and o["forced-by"]: d[i]["forced_by"] = o["forced-by"]
    # hq-oq30g.2: spawn --review marks a reviewer row; it never holds its bead
    if isinstance(o.get("role"), str) and o["role"]: d[i]["role"] = o["role"]
    save(d); print(i)
elif cmd == "get":
    i = need_id()
    if i not in d: sys.exit(1)
    print(json.dumps(d[i], indent=2))
elif cmd == "update":
    i = need_id()
    if i not in d: print(f"error: {i} not found", file=sys.stderr); sys.exit(1)
    if "status" in o and o["status"] is not True: d[i]["status"] = o["status"]
    if "wake-at" in o:
        v = o["wake-at"]
        d[i]["wake_at"] = None if v in (True, "", "null") else int(v)
    if o.get("last-seen"): d[i]["last_seen"] = now()
    if o.get("objectives"): d[i]["objectives_file"] = o["objectives"]
    if o.get("window"): d[i]["tmux_window"] = o["window"]
    save(d); print(json.dumps(d[i]))
elif cmd == "deregister":
    i = need_id()
    d.pop(i, None); save(d); print(i)
elif cmd == "list":
    want = o.get("status")
    rows = [e for e in d.values() if not (want and want is not True) or e["status"] == want]
    rows = sorted(rows, key=lambda x: x.get("started",""))
    if o.get("json"):
        print(json.dumps(rows, indent=2))
    else:
        for e in rows:
            print(f'{e["id"]:8} {e["status"]:10} {e["kind"]:11} {e["rig"]:16} {e["tmux_window"]:16} {e["bead"]}')
elif cmd == "reconcile":
    seam = os.environ.get("HQ_TMUX_WINDOWS")
    if seam is not None:
        live = set(seam.split())
    else:
        import subprocess
        try:
            # ask the server that holds the session named exactly hq (default or
            # hqterm): registry pane ids are that server's, and the caller's own
            # server (a console terminal on hqterm, a shell on default) may not be it
            srv = []
            for s in os.environ.get("HQ_TMUX_SERVERS", "default hqterm").split():
                if subprocess.run(["tmux","-L",s,"has-session","-t","=hq"],
                                  capture_output=True).returncode == 0:
                    srv = ["-L", s]; break
            if not srv:
                raise RuntimeError("no hq session on any server")
            rw = subprocess.run(["tmux"]+srv+["list-windows","-a","-F","#S:#W"],
                                capture_output=True, text=True)
            if rw.returncode == 0:
                # live targets = window names (#S:#W) UNION pane ids (%N) — spawned sessions
                # are tiled panes (tracked by pane id), the overseer et al. are windows.
                # A dead pane (remain-on-exit corpse) is not live.
                live = set(rw.stdout.split())
                rp = subprocess.run(["tmux"]+srv+["list-panes","-a","-F","#{pane_id} #{pane_dead}"],
                                    capture_output=True, text=True)
                if rp.returncode == 0:
                    live |= {l.split()[0] for l in rp.stdout.splitlines() if l.split()[1:] == ["0"]}
            else:
                live = None
        except Exception:
            live = None
    pruned = 0
    if live is not None:
        for e in d.values():
            w = e.get("tmux_window","")
            if e["status"] == "active" and w and w not in live:
                e["status"] = "done"; pruned += 1
        save(d)
    print(f"reconciled: {pruned} pruned")
else:
    print("usage: session-registry.sh {register|get|update|deregister|list|reconcile}", file=sys.stderr); sys.exit(2)
PY
