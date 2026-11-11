#!/usr/bin/env python3
"""Services, jobs and automations helper (console v2 P2.3/P2.4/P2.8).

Runs as owner through spawn-as-owner.sh. Three commands:

  services.py <hq> status              -> JSON {services, jobs, automations}
  services.py <hq> logs <id> <n>       -> JSON {id, lines: [...]} (n <= 200)
  services.py <hq> restart <id>        -> JSON {id, ok, state} (exit 2 refused)
  services.py <hq> mail-switch <disabled|log-only> <on|off> -> JSON {switch, on}

Policy comes from ops/projects/console/services.json and jobs.json: those live
in the guard-protected tree (lucy spec review: an agent-writable allowlist
under a sudo wrapper is no allowlist), the owner seeds them, and this helper
re-validates everything on every run. Missing policy files mean empty
sections, never an error. Every subprocess gets a 5 s deadline with its whole
process group killed on timeout and stdout capped, so one wedged daemon marks
one entry unavailable instead of the collector.
"""

import json
import math
import os
import re
import selectors
import signal
import stat as stat_mod
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, wait as cf_wait
from datetime import datetime, timezone

DEADLINE_S = 5


def _status_deadline():
    """The whole status probe stays under the wrapper's 60 s. The env override
    exists so the deadline is testable without a 45 s wait; a bogus, non-finite,
    non-positive or oversized value degrades to the default rather than raising
    at import and failing the whole command (lucy fix-verify)."""
    v = os.environ.get("HQ_SERVICES_DEADLINE")
    if v is not None:
        try:
            f = float(v)
            if math.isfinite(f) and 0 < f <= 55:
                return f
        except ValueError:
            pass
    return 45.0


STATUS_DEADLINE_S = _status_deadline()
PROBE_WORKERS = 8
MAX_OUT = 256 * 1024
MAX_LOG_LINES = 200
MAX_POLICY_BYTES = 64 * 1024
CLOCK_SKEW_S = 3600.0
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$")
KINDS = {"systemd-user", "systemd-system", "docker", "tmux"}
RESTARTABLE_KINDS = {"systemd-user", "docker"}
JOB_SOURCE_RE = re.compile(r"^(mtime|json:[A-Za-z0-9_.-]{1,40})$")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]")


def out_json(obj):
    json.dump(obj, sys.stdout)
    print()


def fail(msg, code=1):
    print(f"services.py: {msg}", file=sys.stderr)
    sys.exit(code)


def run_cmd(argv, deadline_s=DEADLINE_S, end_at=None):
    """Bounded subprocess: a wall deadline, process group killed on timeout,
    and output STREAMED into capped buffers so a firehose (megabytes in the
    window) can never exhaust memory before the cap applies (lucy red-team).
    `end_at` is an ABSOLUTE monotonic ceiling: an already-expired call never
    spawns, and the effective wall deadline is min(now + deadline_s, end_at).
    Userspace cannot cut a process off at the exact instant, but no subprocess
    is granted runtime PAST the deadline: one spawned in the jitter window is
    killed on the first loop iteration (lucy fix-verify).
    Returns (code, stdout, stderr); code -1 means timeout or a missing binary."""
    now = time.monotonic()
    if end_at is not None and now >= end_at:
        return -1, "", "timeout"
    deadline = now + deadline_s
    if end_at is not None:
        deadline = min(deadline, end_at)
    try:
        p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except (OSError, ValueError):
        return -1, "", "unavailable"
    # The deadline may have passed while Popen ran: kill immediately rather than
    # granting a fresh window (lucy fix-verify).
    if time.monotonic() >= deadline:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        p.wait()
        return -1, "", "timeout"
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ, ("out", MAX_OUT))
    sel.register(p.stderr, selectors.EVENT_READ, ("err", 4096))
    bufs = {"out": bytearray(), "err": bytearray()}
    timed_out = False
    open_n = 2
    while open_n > 0:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            break
        for key, _mask in sel.select(timeout=remaining):
            which, cap = key.data
            try:
                chunk = os.read(key.fileobj.fileno(), 65536)
            except OSError:
                chunk = b""
            if not chunk:
                sel.unregister(key.fileobj)
                open_n -= 1
                continue
            room = cap - len(bufs[which])
            if room > 0:
                bufs[which] += chunk[:room]
        # both buffers full: stop reading, kill, done
        if len(bufs["out"]) >= MAX_OUT and len(bufs["err"]) >= 4096:
            break
    sel.close()
    capped = len(bufs["out"]) >= MAX_OUT and len(bufs["err"]) >= 4096
    # Kill the whole group whenever we stopped early: a leader that already
    # exited can still have descendants holding the pipes open (lucy fix-verify:
    # `sh -c 'sleep 1000 & exit 0'` leaks without an unconditional killpg).
    if timed_out or capped or p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        p.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    code = -1 if timed_out else (p.returncode if p.returncode is not None else -1)
    return code, bufs["out"].decode("utf-8", "replace"), bufs["err"].decode("utf-8", "replace")


def open_contained_dir(hq, *parts, create=False):
    """Walk hq/<parts> from a trusted root fd, every component O_DIRECTORY|
    O_NOFOLLOW so an ANCESTOR symlink cannot redirect the final open either
    (lucy fix-verify: O_NOFOLLOW guards only the last component). Returns a dir
    fd or None."""
    try:
        fd = os.open(os.path.realpath(hq), os.O_DIRECTORY)
    except OSError:
        return None
    try:
        for part in parts:
            try:
                nfd = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None
                os.mkdir(part, 0o755, dir_fd=fd)
                nfd = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nfd
        return fd
    except OSError:
        os.close(fd)
        return None


def scrub(line):
    """Log lines cross into the browser: strip ANSI and control sequences."""
    return ANSI_RE.sub("", line)[:500]


# ---------------------------------------------------------------- policy

def read_policy(hq, name, max_entries=100):
    """A policy file must be a regular non-symlink JSON file under 64 KB in
    the protected tree. Absent -> ([], None). Invalid -> ([], reason): the
    section is disabled loudly rather than half-trusted."""
    path = os.path.join(hq, "ops", "projects", "console", name)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return [], None
    except OSError as e:
        return [], f"{name}: {e.strerror}"
    import stat as stat_mod

    if not stat_mod.S_ISREG(st.st_mode):
        return [], f"{name} is not a regular file"
    if st.st_size > MAX_POLICY_BYTES:
        return [], f"{name} is over {MAX_POLICY_BYTES} bytes"
    try:
        rows = json.load(open(path))
    except Exception as e:
        return [], f"{name} is not valid JSON: {e}"
    if not isinstance(rows, list) or len(rows) > max_entries:
        return [], f"{name} must be a list of at most {max_entries} entries"
    return rows, None


def load_services(hq):
    rows, err = read_policy(hq, "services.json")
    if err:
        return [], err
    seen = set()
    out = []
    for r in rows:
        if not isinstance(r, dict):
            return [], "services.json: every entry must be an object"
        id_ = r.get("id")
        unit = r.get("unit")
        kind = r.get("kind")
        if not isinstance(id_, str) or not ID_RE.match(id_) or id_ in seen:
            return [], f"services.json: bad or duplicate id {id_!r}"
        if kind not in KINDS:
            return [], f"services.json: {id_}: bad kind {kind!r}"
        if not isinstance(unit, str) or not UNIT_RE.match(unit):
            return [], f"services.json: {id_}: bad unit {unit!r}"
        seen.add(id_)
        out.append(
            {
                "id": id_,
                "label": str(r.get("label") or id_)[:80],
                "kind": kind,
                "unit": unit,
                "restartable": bool(r.get("restartable")) and kind in RESTARTABLE_KINDS,
                "logs": bool(r.get("logs")),
            }
        )
    return out, None


def load_jobs(hq):
    rows, err = read_policy(hq, "jobs.json")
    if err:
        return [], err
    seen = set()
    out = []
    for r in rows:
        if not isinstance(r, dict):
            return [], "jobs.json: every entry must be an object"
        id_ = r.get("id")
        hb = r.get("heartbeat")
        source = r.get("source") or "mtime"
        cadence = r.get("cadenceS")
        if not isinstance(id_, str) or not ID_RE.match(id_) or id_ in seen:
            return [], f"jobs.json: bad or duplicate id {id_!r}"
        if not isinstance(hb, str) or hb.startswith("/") or ".." in hb or len(hb) > 200:
            return [], f"jobs.json: {id_}: bad heartbeat path"
        if not isinstance(source, str) or not JOB_SOURCE_RE.match(source):
            return [], f"jobs.json: {id_}: bad source {source!r}"
        if not isinstance(cadence, (int, float)) or not (0 < cadence <= 30 * 86400):
            return [], f"jobs.json: {id_}: cadenceS must be positive and sane"
        seen.add(id_)
        out.append(
            {
                "id": id_,
                "label": str(r.get("label") or id_)[:80],
                "kind": str(r.get("kind") or "loop")[:20],
                "heartbeat": hb,
                "source": source,
                "cadenceS": float(cadence),
            }
        )
    return out, None


# ---------------------------------------------------------------- services

def service_state(entry, deadline_s=DEADLINE_S, end_at=None):
    kind = entry["kind"]
    unit = entry["unit"]
    if kind in ("systemd-user", "systemd-system"):
        argv = ["systemctl"] + (["--user"] if kind == "systemd-user" else []) + [
            "show", unit, "--property=ActiveState,SubState,ActiveEnterTimestamp,NRestarts", "--"]
        code, out, err = run_cmd(argv, deadline_s, end_at)
        if code != 0:
            return {"state": "unavailable", "detail": err.strip()[:120] or f"systemctl exit {code}"}
        props = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
        return {
            "state": props.get("ActiveState", "unknown"),
            "detail": props.get("SubState"),
            "since": props.get("ActiveEnterTimestamp") or None,
            "restarts": int(props.get("NRestarts") or 0),
        }
    if kind == "docker":
        code, out, err = run_cmd(
            ["docker", "inspect", "--format", "{{.State.Status}}\t{{.State.StartedAt}}\t{{.RestartCount}}", "--", unit],
            deadline_s,
            end_at,
        )
        if code != 0:
            return {"state": "unavailable", "detail": err.strip()[:120] or "docker unavailable"}
        parts = out.strip().split("\t")
        return {
            "state": parts[0] if parts else "unknown",
            "since": parts[1] if len(parts) > 1 else None,
            "restarts": int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0,
        }
    if kind == "tmux":
        code, _out, err = run_cmd(["tmux", "has-session", "-t", unit], deadline_s, end_at)
        if code == 0:
            return {"state": "active", "detail": "tmux session"}
        if code == -1:
            return {"state": "unavailable", "detail": err.strip()[:120]}
        return {"state": "inactive", "detail": "no such tmux session"}
    return {"state": "unknown"}


def cmd_status(hq):
    now = datetime.now(tz=timezone.utc).timestamp()
    services, serr = load_services(hq)
    jobs, jerr = load_jobs(hq)
    # Probe services concurrently under one ABSOLUTE wall deadline: 13 wedged
    # units cost one round, not 13 x 5 s serialized past the wrapper timeout
    # (lucy red-team). Each probe returns its own row (no shared-state race,
    # lucy fix-verify) and clamps its subprocess to the deadline that remains,
    # so no worker thread outlives the status deadline and lingers at exit.
    def fallback(e, detail):
        return {**{k: e[k] for k in ("id", "label", "kind", "unit", "restartable", "logs")}, "state": "unavailable", "detail": detail}

    svc_rows = [fallback(e, "probe deadline") for e in services]
    if services:
        end = time.monotonic() + STATUS_DEADLINE_S

        def probe(e):
            # A probe that starts after the absolute deadline gets NO fresh
            # runtime: it returns the fallback without spawning anything (lucy
            # fix-verify, so late waves cannot extend past the deadline).
            if time.monotonic() >= end:
                return fallback(e, "probe deadline")
            st = service_state(e, deadline_s=DEADLINE_S, end_at=end)
            return {**{k: e[k] for k in ("id", "label", "kind", "unit", "restartable", "logs")}, **st}

        pool = ThreadPoolExecutor(max_workers=PROBE_WORKERS)
        futs = {pool.submit(probe, services[i]): i for i in range(len(services))}
        # Every started probe finishes by `end` (its subprocess deadline is
        # clamped to the remaining budget), so waiting to just past `end` is
        # enough; later-queued probes short-circuit to the fallback.
        done, _pending = cf_wait(futs, timeout=max(0.1, end - time.monotonic() + 0.5))
        for f in done:
            try:
                svc_rows[futs[f]] = f.result()
            except Exception:
                pass
        pool.shutdown(wait=False, cancel_futures=True)
    job_rows = [job_state(hq, j, now) for j in jobs]
    out_json(
        {
            "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
            "services": svc_rows,
            "servicesError": serr,
            "jobs": job_rows,
            "jobsError": jerr,
            "automations": mail_state(hq, now),
        }
    )


# ---------------------------------------------------------------- jobs

def job_state(hq, job, now):
    row = {**job, "lastRun": None, "state": "missing", "missed": False}
    path = os.path.realpath(os.path.join(hq, job["heartbeat"]))
    root = os.path.realpath(hq)
    if path != root and not path.startswith(root + os.sep):
        return {**row, "state": "malformed", "detail": "heartbeat escapes the root"}
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return {**row, "state": "missing"}
    except OSError as e:
        return {**row, "state": "malformed", "detail": e.strerror}
    import stat as stat_mod

    if not stat_mod.S_ISREG(st.st_mode):
        return {**row, "state": "malformed", "detail": "not a regular file"}
    if st.st_size > MAX_POLICY_BYTES:
        return {**row, "state": "malformed", "detail": "heartbeat file too large"}
    ts = None
    if job["source"] == "mtime":
        ts = st.st_mtime
    else:
        field = job["source"][5:]
        try:
            doc = json.load(open(path))
            v = doc.get(field) if isinstance(doc, dict) else None
            if isinstance(v, (int, float)):
                ts = float(v)
            elif isinstance(v, str):
                ts = datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except Exception:
            return {**row, "state": "malformed", "detail": "heartbeat JSON unreadable"}
    if ts is None or not math.isfinite(ts) or ts < 0 or ts > 4102444800:
        # 4102444800 = year 2100; a 1e309 value parses to inf and would crash
        # datetime.fromtimestamp for the whole report (lucy red-team).
        return {**row, "state": "malformed", "detail": "no valid timestamp"}
    if ts > now + CLOCK_SKEW_S:
        return {**row, "state": "future", "lastRun": iso(ts)}
    age = now - ts
    missed = age > 2 * job["cadenceS"]
    return {**row, "lastRun": iso(ts), "state": "stale" if missed else "ok", "missed": missed}


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# ---------------------------------------------------------------- automations

def mail_state(hq, now):
    mail = os.path.join(hq, "ops", "mail")
    flags = {
        "disabled": os.path.exists(os.path.join(mail, "DISABLED")),
        "logOnly": os.path.exists(os.path.join(mail, "LOG_ONLY")),
    }
    heartbeats = []
    try:
        # The registry's real shape (ops/mail/heartbeats.json) is
        # {_comment, loops: {name: {interval, stale_after, hosts, enabled}}},
        # and each loop touches state/heartbeat/<name>. The old parser walked
        # the TOP level, so the card showed one bogus entry called "loops" in
        # state missing forever, which read as "hq-mail is broken" while every
        # real loop was green. hosts limits where a loop is expected: absent
        # on an unlisted host is correct, not an outage, exactly as
        # hq_mail.heartbeat treats it. enabled:false is parked wiring, shown
        # as parked rather than hidden so the card cannot silently omit it.
        import platform

        host = platform.node().split(".")[0]
        doc = json.load(open(os.path.join(mail, "heartbeats.json")))
        loops = doc.get("loops") if isinstance(doc, dict) else None
        for name, spec in (loops or {}).items() if isinstance(loops, dict) else []:
            if not isinstance(spec, dict) or len(heartbeats) >= 30:
                continue
            hosts = spec.get("hosts")
            if isinstance(hosts, list) and hosts and host not in [str(h) for h in hosts]:
                continue
            cadence = spec.get("stale_after") or spec.get("interval") or None
            entry = {"id": str(name)[:40], "cadenceS": cadence, "lastRun": None, "state": "missing"}
            if spec.get("enabled") is False:
                entry["state"] = "parked"
                heartbeats.append(entry)
                continue
            safe = re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$", str(name))
            p = os.path.realpath(os.path.join(hq, "state", "heartbeat", str(name))) if safe else ""
            if p and p.startswith(os.path.realpath(hq) + os.sep) and os.path.isfile(p):
                mt = os.stat(p).st_mtime
                entry["lastRun"] = iso(mt)
                entry["state"] = "stale" if (isinstance(cadence, (int, float)) and cadence > 0 and now - mt > cadence) else "ok"
            heartbeats.append(entry)
    except FileNotFoundError:
        pass
    except Exception:
        heartbeats = [{"id": "heartbeats.json", "state": "malformed", "lastRun": None, "cadenceS": None}]
    runs = []
    dfd = open_contained_dir(hq, "state", "mail-runs")
    if dfd is not None:
        try:
            names = sorted(n for n in os.listdir(dfd) if not n.startswith("."))[-5:]
            for f in names:
                # openat with O_NOFOLLOW so a symlink planted in the runs dir
                # cannot disclose a owner-only file through this sudo helper
                # (lucy red-team); fstat must confirm a bounded regular file.
                try:
                    ffd = os.open(f, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
                except OSError:
                    continue
                try:
                    st = os.fstat(ffd)
                    if stat_mod.S_ISREG(st.st_mode) and st.st_size < MAX_POLICY_BYTES:
                        tail = os.read(ffd, MAX_POLICY_BYTES).decode("utf-8", "replace")[-500:]
                        runs.append({"file": f[:60], "tail": scrub(tail)})
                finally:
                    os.close(ffd)
        except OSError:
            pass
        finally:
            os.close(dfd)
    return {"mail": {"flags": flags, "heartbeats": heartbeats, "recentRuns": runs}}


# ---------------------------------------------------------------- actions

def cmd_logs(hq, sid, n):
    services, serr = load_services(hq)
    if serr:
        fail(f"policy invalid: {serr}", 2)
    entry = next((e for e in services if e["id"] == sid), None)
    if not entry or not entry["logs"]:
        fail(f"no such loggable service: {sid}", 2)
    n = max(1, min(int(n), MAX_LOG_LINES))
    kind = entry["kind"]
    unit = entry["unit"]
    if kind in ("systemd-user", "systemd-system"):
        argv = ["journalctl"] + (["--user"] if kind == "systemd-user" else []) + [
            "-u", unit, "-n", str(n), "--no-pager", "-o", "short-iso"]
        code, out, err = run_cmd(argv)
    elif kind == "docker":
        code, out, err = run_cmd(["docker", "logs", "--tail", str(n), "--", unit])
        out = out or err  # docker logs writes to both streams
    else:  # tmux
        code, out, err = run_cmd(["tmux", "capture-pane", "-p", "-t", unit, "-S", f"-{n}"])
    if code != 0 and not out:
        fail(f"logs unavailable: {err.strip()[:160]}")
    lines = [scrub(l) for l in out.splitlines()[-n:]]
    out_json({"id": sid, "lines": lines})


def cmd_restart(hq, sid):
    services, serr = load_services(hq)
    if serr:
        fail(f"policy invalid: {serr}", 2)
    entry = next((e for e in services if e["id"] == sid), None)
    if not entry or not entry["restartable"]:
        fail(f"not restartable: {sid}", 2)
    if entry["kind"] == "systemd-user":
        code, _out, err = run_cmd(["systemctl", "--user", "restart", entry["unit"], "--"])
    else:  # docker
        code, _out, err = run_cmd(["docker", "restart", "--", entry["unit"]])
    if code != 0:
        fail(f"restart failed: {err.strip()[:200]}")
    out_json({"id": sid, "ok": True, "state": service_state(entry).get("state")})


def cmd_mail_switch(hq, switch, onoff):
    names = {"disabled": "DISABLED", "log-only": "LOG_ONLY"}
    if switch not in names or onoff not in ("on", "off"):
        fail("usage: mail-switch <disabled|log-only> <on|off>", 2)
    # Every ancestor (ops, mail) is walked O_NOFOLLOW from the trusted root, so
    # neither a swapped ops/ nor a swapped mail/ can redirect the flag write
    # (lucy fix-verify); the flag itself is then created O_NOFOLLOW too.
    dfd = open_contained_dir(hq, "ops", "mail", create=True)
    if dfd is None:
        fail("ops/mail is not a plain directory", 2)
    try:
        if onoff == "on":
            try:
                ffd = os.open(names[switch], os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
                os.close(ffd)
            except OSError as e:
                fail(f"cannot set the flag ({e.strerror})", 2)
        else:
            try:
                os.unlink(names[switch], dir_fd=dfd)
            except FileNotFoundError:
                pass
    finally:
        os.close(dfd)
    out_json({"switch": switch, "on": onoff == "on"})


def main():
    if len(sys.argv) < 3:
        fail("usage: services.py <hq> <status|logs|restart|mail-switch> ...", 2)
    hq = sys.argv[1]
    cmd = sys.argv[2]
    if cmd == "status":
        cmd_status(hq)
    elif cmd == "logs" and len(sys.argv) == 5 and sys.argv[4].isdigit():
        cmd_logs(hq, sys.argv[3], sys.argv[4])
    elif cmd == "restart" and len(sys.argv) == 4:
        cmd_restart(hq, sys.argv[3])
    elif cmd == "mail-switch" and len(sys.argv) == 5:
        cmd_mail_switch(hq, sys.argv[3], sys.argv[4])
    else:
        fail("bad arguments", 2)


if __name__ == "__main__":
    main()
