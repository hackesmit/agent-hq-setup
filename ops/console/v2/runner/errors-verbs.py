#!/usr/bin/env python3
"""errors-verbs.py: the owner-side half of the console's Errors tab.

Runs as owner through spawn-as-owner.sh (verb `errors`), because the
incident files and state/mail.db belong to owner and the console server
(hqconsole) must not write into ~/hq. Two subcommands:

  errors-verbs.py <hq> list
      JSON on stdout: {incidents:[{file, mtime, text}|{file, mtime, error}],
      omitted, volume:{source, since, hours, fps:[...]}, panes:{<id>: {...}}}.
      Incident files are passed through as TEXT: parsing and tolerance live in
      the server (server/src/errors.js) so they are tested in one place. Every
      actionable incident (fixing, escalated, watching, or a file whose status
      cannot be read) is always included; only history (fixed, logged,
      resolved) is capped, and `omitted` counts what the cap dropped.

  errors-verbs.py <hq> resolve <incident-id>
      Sets status "resolved" and resolved_ts on one incident under the same
      lock the mail automation takes (flock on <id>.lock in the incidents
      dir), re-reading the file inside the lock and writing tmp + os.replace.
      Exit 4 no such incident, 5 malformed file, 6 already resolved, 8 busy
      (the lock stayed held for the whole wait), 2 bad usage.

The incident contract (bead hq-hsl2): one JSON file per incident at
state/errors/incidents/<id>.json, written atomically by ops/mail. This file
never invents fields the contract does not name except resolved_ts,
resolved_by and resolved_from, which readers must tolerate (unknown fields).
"""

import errno
import fcntl
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import time

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
# Only <id>.json is an incident: <id>.lock, <id>.unreadable and temp files are
# the mail side's bookkeeping and never match.
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$")
PANE_RE = re.compile(r"^%[0-9]+$")
WINDOW_ID_RE = re.compile(r"^@[0-9]+$")
SOCKET_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# The one tmux session fixers run in. Anything else on the box (the owner's own
# hq:0 included) is never offered for attachment, whatever the file says.
FIXER_SESSION = "hq-errors"
ACTIONABLE = ("fixing", "escalated", "watching")
# Only these are capped. Anything else (actionable, unreadable, or a status
# outside the contract) is always passed through.
HISTORY = ("fixed", "logged", "resolved")
MAX_HISTORY = 300        # fixed / logged / resolved kept for the tab
MAX_TEXT = 64 * 1024
HOURS = 24
LOCK_WAIT_S = float(os.environ.get("HQ_ERRORS_LOCK_WAIT_S") or 30)  # test seam; sudo resets env in production


def incidents_dir(hq):
    return os.path.join(hq, "state", "errors", "incidents")


def read_text(p):
    """A regular file's text, never through a symlink. Raises OSError."""
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        if st.st_size > MAX_TEXT:
            raise OSError(errno.EFBIG, "file too large (%d bytes)" % st.st_size)
        with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as f:
            fd = None
            return f.read(MAX_TEXT)
    finally:
        if fd is not None:
            os.close(fd)


def parse(text):
    """json.loads that never raises: a deeply nested file (RecursionError) or
    any other surprise is one malformed incident, never a failed listing."""
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001 - per-file tolerance is the point
        return None


def stem_id(name):
    """The incident id is the FILE's name; an embedded id must agree with it."""
    return name[:-5]


def status_of(text):
    o = parse(text)
    if not isinstance(o, dict):
        return None
    s = o.get("status")
    return s if isinstance(s, str) else None


def read_incidents(hq):
    d = incidents_dir(hq)
    try:
        names = [n for n in os.listdir(d) if FILE_RE.match(n)]
    except FileNotFoundError:
        return [], 0, "missing"
    except OSError as e:
        return [], 0, "unreadable: %s" % e.strerror
    rows = []
    for n in names:
        p = os.path.join(d, n)
        try:
            st = os.lstat(p)
        except OSError:
            continue  # renamed away between listdir and lstat
        if not stat.S_ISREG(st.st_mode):
            continue  # a symlink, fifo or directory is never an incident
        rows.append((st.st_mtime, n, p))
    rows.sort(reverse=True)
    out = []
    history = 0
    omitted = 0
    # Every file is read and its status looked at BEFORE any cap: a cap on the
    # raw listing would let thousands of newer history files hide an older
    # escalated incident. Only history (fixed/logged/resolved) is dropped, and
    # its text is not kept.
    for mtime, n, p in rows:
        rec = {"file": n, "mtime": mtime}
        try:
            rec["text"] = read_text(p)
        except OSError as e:
            if e.errno in (errno.ENOENT,):
                continue
            rec["error"] = e.strerror if e.errno == errno.EFBIG else "unreadable: %s" % (e.strerror or e)
        status = status_of(rec["text"]) if "text" in rec else None
        if status in HISTORY:
            history += 1
            if history > MAX_HISTORY:
                omitted += 1
                continue
        out.append(rec)
    return out, omitted, None


def split_target(fixer):
    """(socket, target) from the fixer record. The socket comes from
    fixer.tmux_socket, or a leading "-L <name> " on the target, or a
    "<socket>:<session>:<window>" three-part target. None means the default
    tmux server."""
    target = fixer.get("tmux_target")
    target = target.strip() if isinstance(target, str) else ""
    sock = fixer.get("tmux_socket")
    sock = sock.strip() if isinstance(sock, str) else None
    m = re.match(r"^-L\s+(\S+)\s+(\S+)$", target)
    if m:
        sock = sock or m.group(1)
        target = m.group(2)
    elif target.count(":") == 2 and not PANE_RE.match(target):
        first, rest = target.split(":", 1)
        sock = sock or first
        target = rest
    if sock in ("", "default"):
        sock = None
    return sock, target


def parse_target(target):
    """"session:window[.pane]" -> (session, window, pane_index or None). The
    window is the WHOLE name: a ".N" suffix is split off only when N is
    numeric, so a name containing dots is never cut in half."""
    if not target or ":" not in target:
        return None
    sess, rest = target.split(":", 1)
    pidx = None
    head, dot, tail = rest.rpartition(".")
    if dot and tail.isdigit() and head:
        rest, pidx = head, tail
    if not sess or not rest:
        return None
    return sess, rest, pidx


def tmux(sock, args):
    argv = ["tmux"] + (["-L", sock] if sock else []) + args
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


PANE_FMT = "#{pane_id}\t#{session_name}\t#{window_name}\t#{window_id}\t#{pane_index}\t#{pane_dead}"


def list_panes(cache):
    """Every pane on owner's DEFAULT tmux server. display-message is NOT used
    for lookups: with no client it silently falls back to some current pane for
    a target that does not exist, which would attach the wrong terminal."""
    if "panes" in cache:
        return cache["panes"]
    got = tmux(None, ["list-panes", "-a", "-F", PANE_FMT])
    rows = []
    for line in (got or "").splitlines():
        f = line.split("\t")
        if len(f) >= 6 and PANE_RE.match(f[0]):
            rows.append({"id": f[0], "session": f[1], "window": f[2], "wid": f[3], "pindex": f[4], "dead": f[5] == "1"})
    cache["panes"] = rows if got is not None else None
    return cache["panes"]


def resolve_pane(inc, iid, cache):
    """Where a fixing incident's live pane is, and whether the console can attach it.

    Attachable means: on owner's default tmux server (hq-runner's tmux verbs
    reach no other), in session "hq-errors", in a window whose name is exactly
    this incident's id, and alive. Every hint in the file (tmux_pane,
    tmux_window_id, tmux_target) only narrows the search; none of them can point
    the console at a pane outside that rule."""
    fixer = inc.get("fixer") if isinstance(inc.get("fixer"), dict) else None
    if not fixer:
        return None
    sock, target = split_target(fixer)
    out = {"target": target or None, "socket": sock, "id": None, "alive": False, "attachable": False, "reason": None}
    if sock:
        out["reason"] = (
            "bad tmux socket name" if not SOCKET_RE.match(sock)
            else "fixer runs on tmux socket %s; the console attaches the default server only" % sock
        )
        return out
    pane = fixer.get("tmux_pane")
    pane = pane.strip() if isinstance(pane, str) and PANE_RE.match(pane.strip()) else None
    if not pane and PANE_RE.match(target or ""):
        pane = target
    wid = fixer.get("tmux_window_id")
    wid = wid.strip() if isinstance(wid, str) and WINDOW_ID_RE.match(wid.strip()) else None
    parsed = parse_target(target) if not PANE_RE.match(target or "") else None
    if parsed and parsed[0] != FIXER_SESSION:
        out["reason"] = "tmux target is outside the %s session" % FIXER_SESSION
        return out
    if not (pane or wid or parsed):
        out["reason"] = "no usable tmux target"
        return out
    panes = list_panes(cache)
    if panes is None:
        out["reason"] = "tmux server not reachable"
        return out
    # Only panes that satisfy the rule are candidates at all.
    cands = [p for p in panes if p["session"] == FIXER_SESSION and p["window"] == iid]
    if pane:
        match = [p for p in cands if p["id"] == pane]
        if not match and any(p["id"] == pane for p in panes):
            out["reason"] = "tmux pane %s is not the %s:%s window" % (pane, FIXER_SESSION, iid)
            return out
    elif wid:
        match = [p for p in cands if p["wid"] == wid]
    else:
        sess, win, pidx = parsed
        if win != iid:
            out["reason"] = "tmux window %s is not named after the incident" % win
            return out
        match = [p for p in cands if pidx is None or p["pindex"] == pidx]
    if not match:
        out["reason"] = "pane is gone"
        return out
    me = match[0]
    out["id"] = me["id"]
    out["alive"] = not me["dead"]
    if not out["alive"]:
        out["reason"] = "pane is gone"
    else:
        out["attachable"] = True
    return out


def panes_for(raw):
    out = {}
    cache = {}
    for rec in raw:
        if "text" not in rec:
            continue
        inc = parse(rec["text"])
        if not isinstance(inc, dict) or inc.get("status") != "fixing":
            continue
        # The id is the file name. A file whose embedded id disagrees is
        # malformed (the server shows it as such) and gets no pane.
        iid = stem_id(rec["file"])
        if not ID_RE.match(iid) or ("id" in inc and inc.get("id") != iid):
            continue
        p = resolve_pane(inc, iid, cache)
        if p is not None:
            out[iid] = p
    return out


def volume(hq, now):
    since = now - HOURS * 3600
    res = {"source": "none", "since": since, "hours": HOURS, "fps": [], "error": None}
    path = os.path.join(hq, "state", "mail.db")
    if not os.path.exists(path):
        return res
    try:
        db = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=2)
    except sqlite3.Error as e:
        res["error"] = str(e)
        return res
    try:
        tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
        meta = {}
        if "fps" in tables:
            for fp, project, title, last_ts, count in db.execute(
                "select fp, project, title, last_ts, count from fps"
            ):
                meta[str(fp)] = {"project": project, "title": title, "last_ts": last_ts, "count": count}
        if "fp_events" in tables:
            res["source"] = "fp_events"
            agg = {}
            for fp, ts in db.execute(
                "select fp, ts from fp_events where ts >= ? order by ts desc limit 50000", (since,)
            ):
                try:
                    i = int((float(ts) - since) // 3600)
                except (TypeError, ValueError):
                    continue
                i = min(max(i, 0), HOURS - 1)
                agg.setdefault(str(fp), [0] * HOURS)[i] += 1
            for fp, buckets in agg.items():
                m = meta.get(fp, {})
                res["fps"].append({
                    "fp": fp, "project": m.get("project"), "title": m.get("title"),
                    "total": sum(buckets), "buckets": buckets,
                    "last_ts": m.get("last_ts"), "count": m.get("count"),
                })
        elif meta:
            res["source"] = "fps"
            for fp, m in meta.items():
                try:
                    last = float(m.get("last_ts") or 0)
                except (TypeError, ValueError):
                    continue
                if last < since:
                    continue
                res["fps"].append({
                    "fp": fp, "project": m.get("project"), "title": m.get("title"),
                    "total": None, "buckets": None, "last_ts": last, "count": m.get("count"),
                })
    except sqlite3.Error as e:
        res["error"] = str(e)
    finally:
        db.close()
    res["fps"].sort(key=lambda r: (-(r["total"] or 0), -(r["last_ts"] or 0)))
    res["fps"] = res["fps"][:40]
    return res


def cmd_list(hq):
    now = time.time()
    raw, omitted, dir_state = read_incidents(hq)
    out = {
        "generated_ts": now,
        "dir": dir_state,
        "incidents": raw,
        "omitted": omitted,
        "panes": panes_for(raw),
        "volume": volume(hq, now),
    }
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


def take_lock(path, wait_s):
    """flock(LOCK_EX) on the incident's .lock file, the one the mail automation
    holds across its own read-modify-write. Polls LOCK_NB so a long SMTP or bd
    step on that side makes us give up cleanly instead of hanging the request."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o644)
    deadline = time.monotonic() + wait_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError as e:
            if e.errno not in (errno.EWOULDBLOCK, errno.EAGAIN):
                os.close(fd)
                raise
        if time.monotonic() >= deadline:
            os.close(fd)
            return None
        time.sleep(0.2)


def cmd_resolve(hq, iid):
    if not ID_RE.match(iid):
        print("bad incident id", file=sys.stderr)
        return 2
    d = incidents_dir(hq)
    p = os.path.join(d, iid + ".json")
    if not os.path.lexists(p):
        print("no such incident: %s" % iid, file=sys.stderr)
        return 4
    lock = take_lock(os.path.join(d, iid + ".lock"), LOCK_WAIT_S)
    if lock is None:
        print("incident %s is busy (the mail automation is updating it); retry in a minute" % iid, file=sys.stderr)
        return 8
    try:
        # Re-read INSIDE the lock: whatever the other side wrote last is what we change.
        try:
            text = read_text(p)
        except OSError as e:
            if e.errno == errno.ENOENT:
                print("no such incident: %s" % iid, file=sys.stderr)
                return 4
            print("incident file unreadable: %s" % (e.strerror or e), file=sys.stderr)
            return 5
        inc = parse(text)
        if not isinstance(inc, dict):
            print("incident file is not a JSON object: %s" % iid, file=sys.stderr)
            return 5
        if "id" in inc and inc.get("id") != iid:
            print("incident file %s claims a different id" % iid, file=sys.stderr)
            return 5
        if inc.get("status") == "resolved":
            # resolved is terminal; nothing moves backwards from it
            json.dump({"ok": True, "id": iid, "status": "resolved", "already": True}, sys.stdout)
            sys.stdout.write("\n")
            return 6
        mode = os.stat(p, follow_symlinks=False).st_mode & 0o777
        now = time.time()
        prev = inc.get("status")
        inc["resolved_from"] = prev
        inc["status"] = "resolved"
        inc["resolved_ts"] = now
        inc["resolved_by"] = "console"
        inc["updated_ts"] = now
        tmp = os.path.join(d, ".%s.json.resolve-%d.tmp" % (iid, os.getpid()))
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode or 0o644)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(inc, f, indent=2, sort_keys=True)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, mode or 0o644)
            os.replace(tmp, p)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        json.dump({"ok": True, "id": iid, "status": "resolved", "from": prev, "resolved_ts": now}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    finally:
        os.close(lock)  # closing the fd releases the flock


def main(argv):
    if len(argv) < 3:
        print("usage: errors-verbs.py <hq> list | resolve <id>", file=sys.stderr)
        return 2
    hq, sub = argv[1], argv[2]
    if sub == "list" and len(argv) == 3:
        return cmd_list(hq)
    if sub == "resolve" and len(argv) == 4:
        return cmd_resolve(hq, argv[3])
    print("errors-verbs: bad usage", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
