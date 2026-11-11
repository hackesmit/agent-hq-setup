#!/usr/bin/env python3
"""drift-check: what is declared to run against what runs (hq-fgg3.1).

The enforcement for one drift class: something declared to run is not running,
something running is not declared, or a temporary switch never got switched
back (the retired vault bridge that kept alerting, LOG_ONLY left on for two
months, a retired console window still started by hq.sh, git-sync down 58 h).

Read-only. Declarations come from ops/config/runtime.json plus the registries it
names (heartbeats.json, coverage.json, the console's jobs.json and services.json,
.claude/settings.json, ops/mcp, hq.sh, CLAUDE.md). Every check is small and fails
open: a tool that cannot be run gives a "could not check" line, never a crash and
never a drift item.

Exit 0 clean, 1 drift found, 2 usage, 3 the manifest itself is unreadable.

Two roots. ROOT (HQ_ROOT) is the repo tree whose declarations and files are
judged. LIVE (DRIFT_LIVE_ROOT, default ROOT) is the checkout on the running box
that holds what is never in git: state/ (heartbeats), rigs/ (the project
checkouts) and gitignored local files (.claude/settings.local.json, switch flag
files). They differ only for finish.sh's drift gate on an hq-repo merge, which
points ROOT at a throwaway preview worktree and LIVE at the real ~/hq.

Seams for tests (all optional): HQ_ROOT (repo), DRIFT_LIVE_ROOT, HQ_STATE_DIR, HQ_HOSTNAME,
DRIFT_TODAY (YYYY-MM-DD), DRIFT_NOW (epoch seconds), DRIFT_BD (bd binary, empty
skips the bead lookups), DRIFT_USER_SETTINGS (the user's settings.json), and
PATH shims for systemctl, tmux and crontab.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("HQ_ROOT") or Path(__file__).resolve().parents[2])
LIVE = Path(os.environ.get("DRIFT_LIVE_ROOT") or ROOT)
STATE = Path(os.environ.get("HQ_STATE_DIR") or LIVE / "state")
MANIFEST = ROOT / "ops" / "config" / "runtime.json"
TODAY = os.environ.get("DRIFT_TODAY") or datetime.date.today().isoformat()
NOW = float(os.environ.get("DRIFT_NOW") or time.time())
HOST = os.environ.get("HQ_HOSTNAME") or socket.gethostname().split(".")[0]

def _rig_overrides():
    """DRIFT_RIG_OVERRIDE='name=/path[,name2=/path2]': judge rigs/<name> by
    another checkout (finish.sh points it at the would-be merge result)."""
    out = {}
    for part in (os.environ.get("DRIFT_RIG_OVERRIDE") or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip() and v.strip():
                out[k.strip()] = Path(v.strip())
    return out


RIG_OVERRIDE = _rig_overrides()


def resolve(rel):
    """A repo-relative path, with rigs/<name>/... mapped through RIG_OVERRIDE,
    and any other rigs/ path read from the live box (rigs/ is never in git)."""
    parts = Path(rel).parts
    if len(parts) >= 2 and parts[0] == "rigs" and parts[1] in RIG_OVERRIDE:
        return RIG_OVERRIDE[parts[1]].joinpath(*parts[2:])
    if parts and parts[0] == "rigs":
        return LIVE / rel
    return ROOT / rel


def local_file(rel):
    """A file that may be gitignored: the tree's copy, else the live box's."""
    p = ROOT / rel
    return p if p.exists() or LIVE == ROOT else LIVE / rel


CHECKS = ("units", "tmux", "heartbeats", "coverage", "hooks", "mcp",
          "switches", "cron", "claims", "registries", "installed")
BOOT = ("units", "tmux", "heartbeats")


class CouldNot(Exception):
    pass


class Result:
    def __init__(self):
        self.items = []
        self.unknown = []
        self.ran = []

    def drift(self, check, subject, kind, cls, detail, owner, fix):
        self.items.append({
            "id": "%s:%s:%s" % (check, subject, kind), "check": check,
            "subject": subject, "kind": kind, "class": cls, "detail": detail,
            "owner": owner or "unowned", "fix": fix})

    def could_not(self, check, detail):
        self.unknown.append({"check": check, "detail": str(detail)[:300]})


def run(args, timeout=20, ok_codes=(0,)):
    """Run a command; return stdout. CouldNot when it cannot run or fails."""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           cwd=str(ROOT))
    except (OSError, subprocess.TimeoutExpired) as e:
        raise CouldNot("%s: %r" % (args[0], e))
    if p.returncode not in ok_codes:
        raise CouldNot("%s exit %d: %s" % (" ".join(args[:3]), p.returncode,
                                           (p.stderr or p.stdout).strip()[:200]))
    return p.stdout


def load_json(path):
    return json.loads(Path(path).read_text())


def norm_unit(text):
    """A unit body without comments, blank lines or trailing space."""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith(";"):
            continue
        out.append(s)
    return out


def expired(date):
    return bool(date) and str(date) < TODAY


def valid_date(date):
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", str(date or "")))


# --- units -------------------------------------------------------------------

def _sysctl(scope):
    return ["systemctl", "--user"] if scope == "user" else ["systemctl"]


def unit_files(scope):
    out = run(_sysctl(scope) + ["list-unit-files", "--no-legend", "--plain"])
    files = {}
    for line in out.splitlines():
        parts = line.split()
        if parts:
            files[parts[0]] = parts[1] if len(parts) > 1 else ""
    return files


PROPS = ("LoadState", "ActiveState", "UnitFileState", "Result", "OnFailure",
         "SuccessExitStatus", "FragmentPath")


def show(scope, unit):
    out = run(_sysctl(scope) + ["show", unit, "-p", ",".join(PROPS)])
    props = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            props[k] = v
    return props


def _compare_source(res, entry, unit, installed, source):
    try:
        repo = (ROOT / source).read_text()
    except OSError:
        res.drift("units", unit, "source-missing", "STALE",
                  "declared source %s is not in the repo" % source, entry.get("owner"),
                  "fix the source path in ops/config/runtime.json or restore the file")
        return
    if not installed:
        return
    try:
        live = Path(installed).read_text()
    except OSError as e:
        res.could_not("units", "%s: cannot read %s: %r" % (unit, installed, e))
        return
    if norm_unit(repo) != norm_unit(live):
        res.drift("units", unit, "differs", "STALE",
                  "installed %s differs from %s" % (installed, source), entry.get("owner"),
                  "reinstall from the repo, or commit the live change to %s" % source)


def trigger_source(entry):
    """The repo file of a timer/socket unit's trigger: trigger_source when the
    entry sets it (null means source-less on purpose), else <source base>.<run>."""
    if entry.get("run") not in ("timer", "socket"):
        return None
    if "trigger_source" in entry:
        return entry["trigger_source"] or None
    src = entry.get("source")
    return src.rsplit(".", 1)[0] + "." + entry["run"] if src else None


def check_units(res, man):
    declared = {}
    files = {}
    for scope in ("user", "system"):
        try:
            files[scope] = unit_files(scope)
        except CouldNot as e:
            res.could_not("units", "%s unit list: %s" % (scope, e))
    for entry in man.get("units", []):
        unit, scope = entry["unit"], entry.get("scope", "user")
        runmode = entry.get("run", "daemon")
        owner = entry.get("owner")
        base = unit.rsplit(".", 1)[0]
        declared.setdefault(scope, set()).add(unit)
        if runmode in ("timer", "socket"):
            declared[scope].add("%s.%s" % (base, runmode))
        if scope not in files:
            continue
        if runmode == "template":
            if unit not in files[scope]:
                res.drift("units", unit, "not-installed", "MISSING",
                          "declared %s template is not installed" % scope, owner,
                          "install it from %s" % entry.get("source"))
            elif entry.get("source"):
                frag = (Path.home() / ".config/systemd/user" / unit) if scope == "user" \
                    else Path("/etc/systemd/system") / unit
                _compare_source(res, entry, unit, str(frag) if frag.exists() else "",
                                entry["source"])
            continue
        try:
            p = show(scope, unit)
        except CouldNot as e:
            res.could_not("units", "%s: %s" % (unit, e))
            continue
        if p.get("LoadState") != "loaded":
            res.drift("units", unit, "not-installed", "MISSING",
                      "declared %s unit is not installed (LoadState=%s)"
                      % (scope, p.get("LoadState")), owner,
                      "install it from %s, or remove it from ops/config/runtime.json"
                      % entry.get("source"))
            continue
        if runmode == "daemon":
            if p.get("ActiveState") != "active":
                res.drift("units", unit, "inactive", "BROKEN",
                          "declared daemon is %s" % p.get("ActiveState"), owner,
                          "systemctl %srestart %s and read its journal"
                          % ("--user " if scope == "user" else "", unit))
            if p.get("UnitFileState") not in ("enabled", "enabled-runtime", "linked"):
                res.drift("units", unit, "not-enabled", "BROKEN",
                          "declared daemon is %s, so it will not start at boot"
                          % p.get("UnitFileState"), owner,
                          "systemctl %senable %s" % ("--user " if scope == "user" else "", unit))
        elif runmode in ("timer", "socket"):
            trig = "%s.%s" % (base, runmode)
            try:
                t = show(scope, trig)
            except CouldNot as e:
                res.could_not("units", "%s: %s" % (trig, e))
                t = None
            if t is not None:
                if t.get("LoadState") != "loaded":
                    res.drift("units", trig, "not-installed", "MISSING",
                              "the %s that starts %s is not installed" % (runmode, unit),
                              owner, "install and enable %s" % trig)
                else:
                    if t.get("ActiveState") != "active":
                        res.drift("units", trig, "inactive", "BROKEN",
                                  "%s is %s, so %s never runs"
                                  % (trig, t.get("ActiveState"), unit), owner,
                                  "systemctl %senable --now %s"
                                  % ("--user " if scope == "user" else "", trig))
                    if t.get("UnitFileState") not in ("enabled", "enabled-runtime", "linked"):
                        res.drift("units", trig, "not-enabled", "BROKEN",
                                  "%s is %s, so it is gone after a reboot"
                                  % (trig, t.get("UnitFileState")), owner,
                                  "systemctl %senable %s"
                                  % ("--user " if scope == "user" else "", trig))
                    # Always compared, so a deleted repo timer/socket file is
                    # reported as source-missing. A trigger with no repo copy
                    # on purpose says so: "trigger_source": null.
                    tsrc = trigger_source(entry)
                    if tsrc:
                        _compare_source(res, entry, trig, t.get("FragmentPath", ""), tsrc)
        if p.get("ActiveState") == "failed" or p.get("Result") not in ("success", "", None):
            res.drift("units", unit, "failed", "BROKEN",
                      "last run failed (ActiveState=%s Result=%s)"
                      % (p.get("ActiveState"), p.get("Result")), owner,
                      "read journalctl %s-u %s, fix, then reset-failed"
                      % ("--user " if scope == "user" else "", unit))
        if entry.get("on_failure", "required") == "required" and not p.get("OnFailure"):
            res.drift("units", unit, "no-onfailure", "MISSING",
                      "no OnFailure= alert is wired", owner,
                      "add it to ops/services/failure-notify/install.sh and re-run it")
        codes = [c for c in (p.get("SuccessExitStatus") or "").split()
                 if c.isdigit() and c != "0"]
        if codes and not entry.get("success_exit_ok"):
            res.drift("units", unit, "success-exit", "BROKEN",
                      "SuccessExitStatus counts exit %s as success, so a failure looks healthy"
                      % ",".join(codes), owner, "drop SuccessExitStatus from the unit")
        if entry.get("source"):
            _compare_source(res, entry, unit, p.get("FragmentPath", ""), entry["source"])

    pat = re.compile(man.get("undeclared_unit_pattern") or r"^hq-")
    for scope, names in files.items():
        for name in sorted(names):
            if not pat.search(name) or name in declared.get(scope, set()):
                continue
            if not re.search(r"\.(service|timer|socket|path)$", name):
                continue
            res.drift("units", name, "undeclared", "UNDECLARED",
                      "%s unit file is installed but not declared (state %s)"
                      % (scope, names[name]), "hq-drift",
                      "declare it in ops/config/runtime.json, or disable and remove it")

    all_declared = set().union(*declared.values()) if declared else set()
    for d in man.get("repo_unit_dirs", ["ops/services"]):
        base = ROOT / d
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if "node_modules" in path.parts or not path.is_file():
                continue
            if not re.search(r"\.(service|timer|socket|path)$", path.name):
                continue
            if path.name in all_declared:
                continue
            res.drift("units", path.name, "repo-undeclared", "UNDECLARED",
                      "%s is in the repo but not declared to run"
                      % path.relative_to(ROOT), "hq-drift",
                      "declare it in ops/config/runtime.json, or delete the file")


# --- tmux --------------------------------------------------------------------

def check_tmux(res, man):
    spec = man.get("tmux") or {}
    session = spec.get("session", "hq")
    required = list(spec.get("windows", []))
    optional = set(spec.get("optional", [])) | set(spec.get("launcher_conditional", {}))
    found = {}
    for server in spec.get("servers", ["default"]):
        try:
            p = subprocess.run(
                ["tmux", "-L", server, "list-panes", "-s", "-t", "=%s:" % session, "-F",
                 "#{session_name}\t#{window_name}\t#{pane_dead}"],
                capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as e:
            res.could_not("tmux", "server %s: %r" % (server, e))
            continue
        if p.returncode != 0:
            err = (p.stderr or "").lower()
            if any(s in err for s in ("no server", "can't find", "no such file",
                                      "error connecting", "session not found")):
                continue
            res.could_not("tmux", "server %s: %s" % (server, err.strip()[:200]))
            continue
        wins = {}
        for line in p.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) != 3 or parts[0] != session:
                continue
            wins.setdefault(parts[1], []).append(parts[2].strip() == "1")
        if wins:
            found[server] = wins
    if not found:
        if not [u for u in res.unknown if u["check"] == "tmux"]:
            res.drift("tmux", session, "no-session", "BROKEN",
                      "the %s session runs on no tmux server, so its loops are down"
                      % session, "hq-boot",
                      "systemctl --user restart tmux-hq, then check the windows")
        return
    if len(found) > 1:
        res.drift("tmux", session, "duplicate", "BROKEN",
                  "the %s session runs on %d servers (%s): every loop runs twice"
                  % (session, len(found), ", ".join(sorted(found))), "hq-boot",
                  "kill the copy that was not started by tmux-hq or hq.sh")
    for server, wins in sorted(found.items()):
        for w in required:
            if w not in wins:
                res.drift("tmux", "%s:%s" % (session, w), "missing", "BROKEN",
                          "declared window %s is not in the %s session on server %s"
                          % (w, session, server), "hq-watch",
                          "restart it with the restart line in ops/mail/heartbeats.json")
            elif all(wins[w]):
                res.drift("tmux", "%s:%s" % (session, w), "dead", "BROKEN",
                          "window %s on server %s has only dead panes" % (w, server),
                          "hq-watch", "tmux -L %s respawn-window -k -t %s:%s"
                          % (server, session, w))
        for w in sorted(wins):
            if w not in required and w not in optional:
                res.drift("tmux", "%s:%s" % (session, w), "undeclared", "UNDECLARED",
                          "window %s on server %s is not declared" % (w, server),
                          "hq-drift",
                          "declare it under tmux in ops/config/runtime.json, or kill it")
    launcher = spec.get("launcher")
    if launcher:
        try:
            text = (ROOT / launcher).read_text()
        except OSError as e:
            res.could_not("tmux", "launcher %s: %r" % (launcher, e))
            return
        started = set(re.findall(r"new-(?:session|window)\b[^\n]*?\s-n\s+([A-Za-z0-9_.-]+)", text))
        for w in sorted(started - set(required) - optional):
            res.drift("tmux", "%s:%s" % (session, w), "launcher-undeclared", "STALE",
                      "%s starts window %s, which is not declared" % (launcher, w),
                      "hq-drift", "declare it, or stop starting it in %s" % launcher)
        for w in required:
            if w not in started:
                res.drift("tmux", "%s:%s" % (session, w), "launcher-missing", "STALE",
                          "declared window %s is not started by %s" % (w, launcher),
                          "hq-drift", "start it in %s, or drop it from runtime.json" % launcher)


# --- heartbeats --------------------------------------------------------------

def _hq_mail():
    os.environ.setdefault("HQ_DIR", str(LIVE))
    p = str(ROOT / "ops" / "mail")
    if p not in sys.path:
        sys.path.insert(0, p)


def check_heartbeats(res, man):
    reg = ROOT / "ops" / "mail" / "heartbeats.json"
    try:
        loops = load_json(reg)["loops"]
        assert isinstance(loops, dict)
    except Exception as e:
        res.could_not("heartbeats", "registry %s: %r" % (reg, e))
        return
    hbdir = STATE / "heartbeat"
    try:
        _hq_mail()
        from hq_mail import heartbeat
        rows = heartbeat.status(loops, directory=hbdir, now=NOW, host=HOST)
    except Exception as e:
        res.could_not("heartbeats", "hq_mail.heartbeat: %r" % (e,))
        rows = []
    for r in rows:
        spec = r.get("spec") or {}
        if r["state"] in ("missing", "stale"):
            age = "never written" if r.get("age") is None else "%ds old" % r["age"]
            res.drift("heartbeats", r["name"], "dead", "BROKEN",
                      "loop heartbeat is %s (%s, limit %ds)"
                      % (r["state"], age, r["stale_after"]), spec.get("project"),
                      spec.get("restart") or "restart the loop")
        elif r["state"] == "error":
            res.could_not("heartbeats", "%s: %s" % (r["name"], r.get("error")))
    for name, spec in sorted(loops.items()):
        if not isinstance(spec, dict) or spec.get("enabled") is not False:
            continue
        exp = spec.get("expires")
        if not valid_date(exp) or not spec.get("owner"):
            res.drift("heartbeats", name, "parked-no-expiry", "MISSING",
                      "parked (enabled: false) with no expires date or owner",
                      spec.get("project"),
                      "add expires (YYYY-MM-DD) and owner to it in ops/mail/heartbeats.json")
        elif expired(exp):
            res.drift("heartbeats", name, "parked-expired", "EXPIRED",
                      "parked until %s, which has passed" % exp, spec.get("owner"),
                      "re-enable the heartbeat or delete the entry")
    try:
        files = sorted(p for p in hbdir.iterdir() if not p.name.startswith("."))
    except OSError:
        files = []
    for p in files:
        if p.name in loops:
            continue
        try:
            age = int(NOW - p.stat().st_mtime)
        except OSError:
            continue
        res.drift("heartbeats", p.name, "orphan", "UNDECLARED",
                  "state/heartbeat/%s is written (%ds ago) but no loop declares it"
                  % (p.name, age), "hq-drift",
                  "find and stop what writes it, or declare the loop in ops/mail/heartbeats.json")
    jobs_path = ROOT / "ops" / "projects" / "console" / "jobs.json"
    try:
        jobs = load_json(jobs_path)
    except FileNotFoundError:
        jobs = []
    except Exception as e:
        res.could_not("heartbeats", "jobs.json: %r" % (e,))
        jobs = []
    for job in jobs if isinstance(jobs, list) else []:
        hb, cad = job.get("heartbeat"), job.get("cadenceS")
        if not hb or not cad:
            continue
        rel = hb[len("state/"):] if hb.startswith("state/") else None
        path = STATE / rel if rel else ROOT / hb
        try:
            age = int(NOW - path.stat().st_mtime)
        except OSError:
            age = None
        if age is None or age > 3 * int(cad):
            res.drift("heartbeats", "job-" + job.get("id", hb), "stale", "BROKEN",
                      "console job heartbeat %s is %s (cadence %ss)"
                      % (hb, "missing" if age is None else "%ds old" % age, cad),
                      job.get("id"), "restart the job, or drop it from ops/projects/console/jobs.json")


# --- coverage ----------------------------------------------------------------

def bead_status(ids):
    bd = os.environ.get("DRIFT_BD", "bd")
    if not bd or not ids:
        raise CouldNot("bead lookup disabled")
    out = run([bd, "show"] + sorted(ids) + ["--json"], timeout=30)
    data = json.loads(out)
    if isinstance(data, dict):
        data = [data]
    return {d.get("id"): d.get("status") for d in data}


def check_coverage(res, man):
    try:
        _hq_mail()
        from hq_mail import coverage
        reg = ROOT / "ops" / "mail" / "coverage.json"
        r = coverage.audit(hq=LIVE, registry=reg)   # rigs/ lives on the box
        projects = load_json(reg)["projects"]
    except Exception as e:
        res.could_not("coverage", repr(e))
        return
    if r.get("error"):
        res.could_not("coverage", r["error"])
        return
    # Rotted is recomputed here rather than taken from the audit so that
    # evidence inside an overridden rig (finish.sh's would-be merge tree) is
    # judged against that tree.
    rotted = []
    for name in sorted(projects):
        entry = projects[name] or {}
        if entry.get("status") == "wired":
            ev = entry.get("evidence")
            if not ev or not resolve(ev).exists():
                rotted.append(name)
    for name in rotted:
        res.drift("coverage", name, "rotted", "BROKEN",
                  "claimed wired but its evidence file is gone", name,
                  "fix evidence in ops/mail/coverage.json or rewire the reporter")
    for name in r.get("unlisted", []):
        res.drift("coverage", name, "unlisted", "MISSING",
                  "rig exists with no failure-reporting decision", name,
                  "add it to ops/mail/coverage.json")
    owners = {}
    for name in r.get("gaps", []):
        bead = str((projects.get(name) or {}).get("bead") or "")
        m = re.match(r"^\s*([a-z]+-[0-9a-z]+(?:\.[0-9]+)*)", bead)
        if not m:
            res.drift("coverage", name, "gap-unowned", "MISSING",
                      "a known reporting gap with no owner bead", name,
                      "file a bead and name it in coverage.json, or wire the reporter")
        else:
            owners[name] = m.group(1)
    if owners:
        try:
            st = bead_status(set(owners.values()))
        except (CouldNot, ValueError) as e:
            res.could_not("coverage", "gap owner beads: %s" % e)
            return
        for name, b in sorted(owners.items()):
            s = st.get(b)
            if s is None or s == "closed":
                res.drift("coverage", name, "gap-owner-closed", "STALE",
                          "reporting gap is owned by %s, which is %s"
                          % (b, s or "not in the ledger"), name,
                          "wire the reporter and mark it wired, or name an open bead")


# --- hooks and MCP -----------------------------------------------------------

def _resolves(cmd):
    first = cmd.strip().split()[0] if cmd.strip() else ""
    first = first.replace("$CLAUDE_PROJECT_DIR", str(ROOT)).replace("${CLAUDE_PROJECT_DIR}", str(ROOT))
    first = os.path.expanduser(first.strip("\"'"))
    if "/" in first:
        return first, os.path.isfile(first) and os.access(first, os.X_OK)
    return first, shutil.which(first) is not None


def check_hooks(res, man):
    settings = [ROOT / ".claude" / "settings.json", local_file(".claude/settings.local.json"),
                Path(os.environ.get("DRIFT_USER_SETTINGS") or Path.home() / ".claude" / "settings.json")]
    wired = set()
    for s in settings:
        try:
            data = load_json(s)
        except FileNotFoundError:
            continue
        except Exception as e:
            res.could_not("hooks", "%s: %r" % (s, e))
            continue
        for event, groups in (data.get("hooks") or {}).items():
            for g in groups or []:
                for h in (g or {}).get("hooks", []):
                    cmd = h.get("command") or ""
                    if not cmd:
                        continue
                    target, ok = _resolves(cmd)
                    wired.add(os.path.basename(target))
                    if not ok:
                        res.drift("hooks", os.path.basename(target) or cmd[:40], "missing",
                                  "BROKEN", "%s %s hook runs %s, which does not exist or is not executable"
                                  % (s.name, event, target), "hq-drift",
                                  "restore the hook file or remove it from %s" % s)
    unwired = man.get("hooks_unwired") or {}
    for p in sorted((ROOT / "ops" / "scripts").glob("hook-*.sh")):
        if p.name not in wired and p.name not in unwired:
            res.drift("hooks", p.name, "unwired", "UNDECLARED",
                      "hook file exists but no settings file runs it", "hq-drift",
                      "wire it in .claude/settings.json, delete it, or list it under hooks_unwired with a reason")


def check_mcp(res, man):
    for prof in sorted((ROOT / "ops" / "mcp").glob("*.json")):
        try:
            servers = (load_json(prof).get("mcpServers") or {})
        except Exception as e:
            res.could_not("mcp", "%s: %r" % (prof.name, e))
            continue
        for name, spec in servers.items():
            cmd = (spec or {}).get("command")
            if not cmd:
                continue
            target, ok = _resolves(cmd)
            if not ok:
                res.drift("mcp", "%s/%s" % (prof.stem, name), "command-missing", "BROKEN",
                          "MCP profile %s runs %s, which is not installed" % (prof.name, target),
                          "hq-drift", "install the command or delete ops/mcp/%s" % prof.name)


# --- switches ----------------------------------------------------------------

def _live_tracked(res, roots):
    """Paths under `roots` that the live checkout's git tracks, or None when
    LIVE == ROOT. A tracked file's state belongs to the tree being checked
    (ROOT): its live copy is only the pre-merge version, so it must not
    resurrect a file the merge deletes. Only untracked or gitignored live
    files (local state such as ops/mail/LOG_ONLY) are read from LIVE. When git
    cannot answer, nothing is read from LIVE and the check is marked could
    not check, so the gate leaves switches out of its comparison."""
    if LIVE == ROOT:
        return None
    if not (LIVE / ".git").exists():
        return set()   # not a git checkout: every live file is local
    try:
        out = subprocess.run(["git", "-C", str(LIVE), "ls-files", "-z", "--"] + list(roots),
                             capture_output=True, text=True, timeout=20)
        if out.returncode != 0:
            raise CouldNot((out.stderr or "").strip()[:200])
        return set(p for p in out.stdout.split("\0") if p)
    except (OSError, subprocess.TimeoutExpired, CouldNot) as e:
        res.could_not("switches", "git ls-files in %s: %r" % (LIVE, e))
        return False


def check_switches(res, man):
    switches = man.get("switches") or {}
    scan = man.get("switch_scan") or {}
    scan_roots = [r for r in scan.get("roots") or [] if r != "state"]
    tracked = _live_tracked(res, sorted(set(scan_roots) | set(switches)))

    def live_local(rel):
        """Does an untracked (local-only) live copy of rel exist?"""
        return bool(tracked is not None and tracked is not False
                    and rel not in tracked and (LIVE / rel).exists())

    for rel, spec in sorted(switches.items()):
        spec = spec or {}
        # the checked tree decides; a gitignored live flag file counts too
        on = (ROOT / rel).exists() or live_local(rel)
        rec = spec.get("on")
        owner = (rec or {}).get("owner") or spec.get("owner")
        if on and not rec:
            res.drift("switches", rel, "on-undeclared", "BROKEN",
                      "switch is ON (%s) with no on record, so nothing says when it ends"
                      % spec.get("what", "flag file"), owner,
                      "delete %s, or record on: {since, expires, owner} in ops/config/runtime.json" % rel)
        elif on and (not valid_date(rec.get("expires")) or not rec.get("owner")):
            res.drift("switches", rel, "on-no-expiry", "MISSING",
                      "switch is ON but its on record has no valid expires or owner", owner,
                      "add expires (YYYY-MM-DD) and owner to the on record")
        elif on and expired(rec.get("expires")):
            res.drift("switches", rel, "expired", "EXPIRED",
                      "switch is ON past its expiry %s" % rec.get("expires"), owner,
                      "switch it off (delete %s, set on to null) or extend expires with a reason" % rel)
        elif not on and rec:
            res.drift("switches", rel, "stale-on-record", "STALE",
                      "switch is off but runtime.json still records it on", owner,
                      "set on to null for %s in ops/config/runtime.json" % rel)
    rx = re.compile(scan.get("name_regex") or r"^[A-Z][A-Z0-9_]{2,}$")
    ignore = set(scan.get("ignore_names") or [])
    skip = set(scan.get("skip_dirs") or [])
    depth = int(scan.get("max_depth") or 3)
    walks = []
    for root_rel in scan.get("roots") or []:
        if root_rel == "state":
            walks.append((STATE, "state", False))
        else:
            walks.append((ROOT / root_rel, root_rel, False))
            if tracked is not None and tracked is not False:   # local flag files live only on the box
                walks.append((LIVE / root_rel, root_rel, True))
    seen = set()
    for base, label, live_walk in walks:
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            d = Path(dirpath)
            level = len(d.relative_to(base).parts)
            dirnames[:] = [n for n in dirnames if n not in skip and level < depth]
            for fn in filenames:
                if not rx.match(fn) or fn in ignore:
                    continue
                rel = str(Path(label) / (d / fn).relative_to(base))
                if live_walk and rel in tracked:
                    continue   # tracked: the checked tree's walk decides
                if rel in switches or rel in seen:
                    continue
                seen.add(rel)
                res.drift("switches", rel, "undeclared", "UNDECLARED",
                          "flag-shaped file %s is not a declared switch" % rel, "hq-drift",
                          "declare it under switches with an owner and expiry, or delete it")


# --- cron --------------------------------------------------------------------

def check_cron(res, man):
    try:
        p = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        res.could_not("cron", repr(e))
        return
    if p.returncode != 0 and "no crontab" not in (p.stderr or "").lower():
        res.could_not("cron", (p.stderr or "").strip()[:200])
        return
    lines = [l.strip() for l in (p.stdout or "").splitlines()
             if l.strip() and not l.strip().startswith("#") and not re.match(r"^\w+=", l.strip())]
    declared = man.get("cron") or []
    for c in declared:
        if not any(c["match"] in l for l in lines):
            res.drift("cron", c["match"], "missing", "MISSING",
                      "declared cron job (%s) is not in the crontab" % c.get("what", ""),
                      c.get("owner"), "add it back with crontab -e, or drop it from runtime.json")
    for l in lines:
        if not re.search(r"(/hq/|\$HOME/hq|~/hq)", l):
            continue
        if any(c["match"] in l for c in declared):
            continue
        res.drift("cron", l[:80], "undeclared", "UNDECLARED",
                  "crontab line is not declared: %s" % l[:160], "hq-drift",
                  "declare it under cron in ops/config/runtime.json, or remove it")


# --- claims ------------------------------------------------------------------

def _rig_dirs():
    rigs = LIVE / "rigs"
    names = set()
    if not rigs.is_dir():
        raise CouldNot("no rigs/ directory under %s" % LIVE)
    _hq_mail()
    from hq_mail import coverage
    for p in rigs.iterdir():
        if p.is_dir():
            kind, name = coverage.classify(p)
            if kind == "project":
                names.add(name)
    return names


def check_claims(res, man):
    for c in man.get("claims") or []:
        cid, owner = c.get("id"), c.get("owner")
        try:
            text = (ROOT / c.get("file", "CLAUDE.md")).read_text()
        except OSError as e:
            res.could_not("claims", "%s: %r" % (cid, e))
            continue
        if c.get("type") == "rigs_table":
            rows = []
            m = re.search(r"^\| Rig \| Path \|.*\n\|[-| ]+\|\n((?:\|.*\n?)*)", text, re.M)
            if not m:
                res.drift("claims", cid, "anchor", "STALE", "Rigs table not found in %s"
                          % c.get("file"), owner, "restore the | Rig | Path | table")
                continue
            for line in m.group(1).splitlines():
                cells = [x.strip() for x in line.strip().strip("|").split("|")]
                if cells and cells[0]:
                    rows.append(cells[0])
            try:
                dirs = _rig_dirs()
            except (CouldNot, Exception) as e:
                res.could_not("claims", "%s: %s" % (cid, e))
                continue
            for name in sorted(dirs - set(rows)):
                res.drift("claims", "rig:" + name, "not-in-table", "STALE",
                          "rigs/%s exists but the CLAUDE.md Rigs table has no row" % name,
                          owner, "add a row, or archive the directory")
            for name in sorted(set(rows) - dirs):
                res.drift("claims", "rig:" + name, "no-dir", "STALE",
                          "CLAUDE.md Rigs table lists %s, which is not under rigs/" % name,
                          owner, "drop the row, or restore the checkout")
            continue
        m = re.search(c["regex"], text)
        if not m:
            res.drift("claims", cid, "anchor", "STALE",
                      "the sentence this claim checks is gone from %s" % c.get("file"), owner,
                      "update the claim regex in ops/config/runtime.json")
            continue
        value = m.group(1)
        mode = c.get("compare", "contains")
        if mode == "path_exists":
            if not Path(os.path.expanduser(value)).exists():
                res.drift("claims", cid, "false", "STALE",
                          "%s says %s, which does not exist" % (c.get("file"), value), owner,
                          "correct the line or restore the path")
            continue
        try:
            out = run(c["cmd"], timeout=15)
        except CouldNot as e:
            res.could_not("claims", "%s: %s" % (cid, e))
            continue
        if mode == "path":
            ok = os.path.realpath(os.path.expanduser(value)) == \
                os.path.realpath(os.path.expanduser(out.strip()))
        else:
            ok = c.get("expect", "{0}").format(value) in out
        if not ok:
            res.drift("claims", cid, "false", "STALE",
                      "%s says %s, the system says %s"
                      % (c.get("file"), value, " ".join(out.split())[:120]), owner,
                      "correct the line in %s, or the system" % c.get("file"))


# --- registries --------------------------------------------------------------

def check_registries(res, man):
    path = ROOT / "ops" / "projects" / "console" / "services.json"
    try:
        services = load_json(path)
    except FileNotFoundError:
        return
    except Exception as e:
        res.could_not("registries", "services.json: %r" % (e,))
        return
    declared = {u["unit"] for u in man.get("units", [])}
    for s in services if isinstance(services, list) else []:
        u = s.get("unit")
        if u and u not in declared:
            res.drift("registries", u, "console-undeclared", "STALE",
                      "the console's services.json shows %s, which runtime.json does not declare" % u,
                      "hq-console", "declare it in runtime.json, or drop it from services.json")


# --- installed copies --------------------------------------------------------

def check_installed(res, man):
    """Files installed outside the repo on purpose must still match their source."""
    for f in man.get("installed_files") or []:
        dst = Path(os.path.expanduser(f["installed"]))
        src = ROOT / f["source"]
        if not dst.exists():
            res.drift("installed", f["installed"], "missing", "MISSING",
                      "installed copy of %s is absent" % f["source"], f.get("owner"),
                      f.get("install") or "install it from %s" % f["source"])
            continue
        try:
            same = dst.read_bytes() == src.read_bytes()
        except OSError as e:
            res.could_not("installed", "%s: %r" % (f["installed"], e))
            continue
        if not same:
            res.drift("installed", f["installed"], "differs", "STALE",
                      "installed copy differs from %s" % f["source"], f.get("owner"),
                      f.get("install") or "reinstall it from %s" % f["source"])


RUNNERS = {"units": check_units, "tmux": check_tmux, "heartbeats": check_heartbeats,
           "coverage": check_coverage, "hooks": check_hooks, "mcp": check_mcp,
           "switches": check_switches, "cron": check_cron, "claims": check_claims,
           "registries": check_registries, "installed": check_installed}


def evaluate(only):
    res = Result()
    man = load_json(MANIFEST)
    for name in only:
        res.ran.append(name)
        try:
            RUNNERS[name](res, man)
        except Exception as e:   # fail open: a broken check is not drift
            res.could_not(name, "check crashed: %r" % (e,))
    return res


def as_json(res):
    return {"date": TODAY, "host": HOST, "root": str(ROOT), "live": str(LIVE), "checks": res.ran,
            "clean": not res.items, "items": res.items, "unknown": res.unknown}


def as_text(res):
    lines = ["drift-check %s on %s: %d drift item(s), %d could not check"
             % (TODAY, HOST, len(res.items), len(res.unknown))]
    for it in res.items:
        lines.append("  [%s] %s - %s. owner: %s. fix: %s"
                     % (it["class"], it["id"], it["detail"], it["owner"], it["fix"]))
    for u in res.unknown:
        lines.append("  [COULD NOT CHECK] %s - %s" % (u["check"], u["detail"]))
    if not res.items and not res.unknown:
        lines.append("  clean: everything declared runs, nothing undeclared runs")
    return "\n".join(lines)


def new_since(before, after):
    """Items in `after` that `before` lacks, comparing only checks that ran and
    succeeded in BOTH runs: a check that could not run in either run (a
    systemd or tmux hiccup) is left out of both, so existing drift can never
    turn into "new". Returns (new_items, excluded_checks)."""
    for d in (before, after):
        if not isinstance(d, dict) or d.get("error") or not isinstance(d.get("items"), list):
            raise ValueError("not a drift-check --json result")
    ran = set(before.get("checks") or []) & set(after.get("checks") or [])
    excluded = {u.get("check") for u in (before.get("unknown") or []) + (after.get("unknown") or [])}
    usable = ran - excluded
    old_ids = {it["id"] for it in before["items"]}
    new = [it for it in after["items"] if it.get("check") in usable and it["id"] not in old_ids]
    return new, sorted(c for c in (ran | excluded) if c not in usable)


def _flag_shaped(path, man):
    """Would check_switches' scan see repo path `path` as a flag file?"""
    scan = man.get("switch_scan") or {}
    rx = re.compile(scan.get("name_regex") or r"^[A-Z][A-Z0-9_]{2,}$")
    parts = Path(path).parts
    if not parts or not rx.match(parts[-1]) or parts[-1] in set(scan.get("ignore_names") or []):
        return False
    skip = set(scan.get("skip_dirs") or [])
    depth = int(scan.get("max_depth") or 3)
    for root_rel in scan.get("roots") or []:
        rp = Path(root_rel).parts
        if tuple(parts[:len(rp)]) != rp:
            continue
        dirs = parts[len(rp):-1]
        if len(dirs) <= depth and not set(dirs) & skip:
            return True
    return False


def gate_relevant(repo, paths, man):
    """Does a merge touching `paths` (relative to the merged repo) change what
    drift-check reads? repo is "hq" for the hq repo, else a rig name. The list
    lives in runtime.json gate_paths, plus every declared unit and installed-file
    source (timer and socket triggers included) and claim file, every declared
    switch path, and any flag-shaped file under a switch_scan root (the same
    name, depth and skip rules check_switches uses); for a rig, the
    coverage.json evidence inside it. Returns the matching paths."""
    import fnmatch
    if repo == "hq":
        pats = list(man.get("gate_paths") or [])
        pats += [u["source"] for u in man.get("units", []) if u.get("source")]
        pats += [t for t in (trigger_source(u) for u in man.get("units", [])) if t]
        pats += [f["source"] for f in man.get("installed_files", []) if f.get("source")]
        pats += [c.get("file", "CLAUDE.md") for c in man.get("claims", [])]
        switches = set(man.get("switches") or {})
        return [p for p in paths if p in switches or _flag_shaped(p, man)
                or any(fnmatch.fnmatch(p, pat) for pat in pats)]
    projects = load_json(ROOT / "ops" / "mail" / "coverage.json")["projects"]
    prefix = "rigs/%s/" % repo
    evidence = {e["evidence"][len(prefix):] for e in projects.values()
                if isinstance(e, dict) and str(e.get("evidence") or "").startswith(prefix)}
    return [p for p in paths if p in evidence]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="drift-check")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--boot", action="store_true", help="boot subset: %s" % ",".join(BOOT))
    ap.add_argument("--only", default="", help="comma list of checks: %s" % ",".join(CHECKS))
    ap.add_argument("--list", action="store_true", help="list the checks and exit")
    ap.add_argument("--gate-relevant", metavar="REPO",
                    help="read changed paths on stdin; exit 0 and list them when drift-check reads any "
                         "(REPO is hq or a rig name), 1 when none, 3 on error")
    ap.add_argument("--new-since", nargs=2, metavar=("BEFORE.json", "AFTER.json"),
                    help="print the items AFTER adds over BEFORE (exit 1 if any, 0 none, 3 unreadable)")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    if a.list:
        print("\n".join(CHECKS))
        return 0
    if a.gate_relevant:
        try:
            hits = gate_relevant(a.gate_relevant, [l.strip() for l in sys.stdin if l.strip()],
                                 load_json(MANIFEST))
        except Exception as e:
            print("drift-check: cannot decide relevance: %r" % (e,), file=sys.stderr)
            return 3
        for h in hits:
            print(h)
        return 0 if hits else 1
    if a.new_since:
        try:
            new, skipped = new_since(load_json(a.new_since[0]), load_json(a.new_since[1]))
        except Exception as e:
            print("drift-check: cannot compare: %r" % (e,), file=sys.stderr)
            return 3
        if skipped:
            print("not compared (could not check in one of the runs): %s" % ", ".join(skipped))
        for it in new:
            print("%s - %s" % (it["id"], it.get("detail", "")))
        return 1 if new else 0
    only = list(BOOT) if a.boot else list(CHECKS)
    if a.only:
        only = [x.strip() for x in a.only.split(",") if x.strip()]
        bad = [x for x in only if x not in RUNNERS]
        if bad:
            print("drift-check: unknown check(s): %s" % ", ".join(bad), file=sys.stderr)
            return 2
    try:
        res = evaluate(only)
    except Exception as e:
        msg = "drift-check: cannot read %s: %r" % (MANIFEST, e)
        if a.json:
            print(json.dumps({"date": TODAY, "host": HOST, "error": msg, "clean": None,
                              "items": [], "unknown": []}))
        else:
            print(msg, file=sys.stderr)
        return 3
    print(json.dumps(as_json(res), indent=1) if a.json else as_text(res))
    return 1 if res.items else 0


if __name__ == "__main__":
    sys.exit(main())
