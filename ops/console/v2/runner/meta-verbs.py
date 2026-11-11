#!/usr/bin/env python3
"""meta-verbs.py: the owner-side half of the Capri (meta terminal) verbs.

Invoked ONLY by spawn-as-owner.sh (which validates argv shapes first), as owner,
from the root-owned /usr/local/lib/hq-console directory. Everything here is either a
read-only check or a bounded revert inside owner's own persistence surfaces. It never
takes a free-form command or path: kinds and names are validated against fixed shapes
and fixed roots, and file restores only copy from the backup this script itself wrote
at snapshot time.

Commands (stdout is one JSON object; exit 0 unless the argv is unusable):
  check [sid]              proposal 19 refusal rules 1 to 4, {ok, reasons[]}
  snapshot SID [after]     persistence snapshot + backups under META_STATE/SID/backup
                           ("after": the close-time view, no backups written)
  scopes                   {scopes:[hq-meta-*.scope names]}
  stop SID                 stop hq-meta-SID.scope (SIGTERM, then SIGKILL), {stopped}
  revert SID KIND NAME     remove something that did not exist at snapshot time
                           (unit|cron|at|autostart|stop) or restore a changed file
                           from the snapshot backup (restore)
  integrity                canaries.sh + cage-integrity diff, {canaries, cage}

Env: HQ_META_DIR (default /var/lib/hqconsole/meta), HQ_ROOT, HOME.
Design: docs/superpowers/specs/2026-08-17-console-v2-design.md 3b; ops/proposals/19-meta-terminal.md.
"""
import hashlib
import json
import os
import re
import shutil
from stat import S_ISLNK, S_ISREG
import subprocess
import sys
import time

HQ = os.environ.get("HQ_ROOT") or "/home/owner/hq"
META_DIR = os.environ.get("HQ_META_DIR") or "/var/lib/hqconsole/meta"
# The wrapper pins HOME=/home/owner for every verb. The test suite points the meta
# dir at a fixture, and ONLY then may it also point the home at a fixture: a owner
# side verb must never be able to reach the real home from a test. Under sudo both
# variables are reset, so production always uses the real home and the real meta dir.
HOME = (os.environ.get("HQ_META_HOME") if os.environ.get("HQ_META_DIR") else None) or os.environ.get("HOME") or os.path.expanduser("~")
# The uid that is trusted to own the meta files: root in production. A test points
# HQ_META_DIR at a fixture it owns, and ONLY then may it name its own uid trusted.
TRUSTED_UID = int(os.environ["HQ_META_TRUSTED_UID"]) if (os.environ.get("HQ_META_DIR") and os.environ.get("HQ_META_TRUSTED_UID")) else 0
# Ancestor verification stops at this base (its own ownership is not re-checked):
# provisioning owns /var/lib/hqconsole, so we verify the meta dir and everything
# below it, not the whole filesystem root. A test points it at the fixture parent.
TRUSTED_BASE = os.path.realpath((os.environ.get("HQ_META_TRUSTED_BASE") if os.environ.get("HQ_META_DIR") else None) or META_DIR.rstrip("/"))
META_SETTINGS = os.path.join(META_DIR, "meta-settings.json")
META_STATE = os.path.join(META_DIR, "sessions")
META_AUDIT = os.path.join(META_DIR, "audit.jsonl")
USER_SETTINGS = os.path.join(HOME, ".claude", "settings.json")
# The setting sources the wrapper will pass to `claude` at launch (bead hq-ngef).
# The wrapper is the single source of truth and hands it here; in production it
# is a hardcoded empty string (not environment-overridable), so user/project/
# local settings are never loaded and rule 1 below is skipped rather than
# false-refusing. Rule 1 is a tripwire for the test surface and any accidental
# non-empty sources, NOT a licence to load a live user file safely.
SETTING_SOURCES = [x for x in (os.environ.get("HQ_META_SETTING_SOURCES", "") or "").split(",") if x.strip()]
LOADS_USER_SETTINGS = "user" in SETTING_SOURCES
USER_UNITS = os.path.join(HOME, ".config", "systemd", "user")
AUTOSTART = os.path.join(HOME, ".config", "autostart")
SHELL_FILES = [".profile", ".bashrc", ".bash_profile", ".bash_login", ".zshrc", ".zprofile"]
MUTATING = ("Bash", "Write", "Edit", "MultiEdit", "NotebookEdit")
CAGE_PATHS = [".claude", "ops/githooks", "ops/scripts", "ops/templates", "CLAUDE.md"]

SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
UNIT_REL_RE = re.compile(r"^[A-Za-z0-9@._-]+(/[A-Za-z0-9@._-]+)*\.(service|timer|socket|path|target|slice|mount)$")
UNIT_NAME_RE = re.compile(r"^[A-Za-z0-9@._\\:-]+\.(service|scope|timer|socket|path|target|slice|mount)$")
AT_RE = re.compile(r"^[0-9]{1,9}$")
DESKTOP_RE = re.compile(r"^[A-Za-z0-9._-]+\.desktop$")
SCOPE_RE = re.compile(r"^hq-meta-[A-Za-z0-9._-]+\.scope$")
# Scopes that hold terminals (the hqterm tmux server, one scope per tmux pane):
# stopping one kills a console terminal or a worker, never a session's persistence
# (hq-4npjr.20). The runner's diffSnapshots never asks; this refuses it anyway.
TERMINAL_SCOPE_RE = re.compile(r"^(tmux-spawn-[A-Za-z0-9-]+|hq-term-tmux)\.scope$")
MAX_BACKUP_BYTES = 256 * 1024
# Tools are named by absolute path: this script decides what runs as owner on the
# strength of a sudo rule, so nothing here is resolved through PATH.
SYSTEMCTL = "/usr/bin/systemctl"
CRONTAB = "/usr/bin/crontab"
ATQ = "/usr/bin/atq"
ATRM = "/usr/bin/atrm"
GIT = "/usr/bin/git"
BASH = "/usr/bin/bash"


def out(obj, code=0):
    sys.stdout.write(json.dumps(obj, sort_keys=True) + "\n")
    sys.exit(code)


def die(msg):
    sys.stderr.write("meta-verbs: " + msg + "\n")
    sys.exit(2)


def user_env():
    uid = os.getuid()
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % uid)
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=%s/bus" % env["XDG_RUNTIME_DIR"])
    return env


def run(argv, timeout=20, cwd=None):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=user_env())
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", "not found: " + argv[0]
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()



def mutating_allow(entries):
    hits = []
    for e in entries or []:
        if not isinstance(e, str):
            continue
        tool = e.split("(", 1)[0].strip()
        if tool in MUTATING:
            hits.append(e)
    return hits


# ----------------------------------------------------------------------- check --
def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def hook_commands(settings):
    cmds = []
    hooks = settings.get("hooks") if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        return cmds
    for _event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for g in groups:
            for h in (g.get("hooks") if isinstance(g, dict) else None) or []:
                if isinstance(h, dict) and isinstance(h.get("command"), str):
                    cmds.append(h["command"])
    return cmds


def writable(path):
    return os.access(path, os.W_OK)


def verify_trusted(path):
    """Reasons why `path` (and every ancestor up to /) is not safe to trust as code
    or config that will run as owner: a component that is a symlink, is not owned by
    the trusted uid, or is writable by group or other. This is the real control:
    os.access(W_OK) only proves the SESSION user cannot write, not that hqconsole (the
    caller) cannot. Requiring trusted ownership and no group/other write closes the
    hqconsole-owned-hook and writable-parent escalations."""
    reasons = []
    cur = os.path.abspath(path)
    # every component from `path` down to (and including) the meta dir, but not past
    # the trusted base, which provisioning owns and we take on trust
    stop_at = os.path.dirname(TRUSTED_BASE) if TRUSTED_BASE not in ("", "/") else "/"
    seen = 0
    while True:
        try:
            st = os.lstat(cur)
        except OSError as e:
            reasons.append("cannot lstat %s: %s" % (cur, str(e)[:80]))
            break
        if S_ISLNK(st.st_mode):
            reasons.append("symlink in the trusted path: " + cur)
        if st.st_uid != TRUSTED_UID:
            reasons.append("not owned by the trusted uid (%d): %s owned by %d" % (TRUSTED_UID, cur, st.st_uid))
        if st.st_mode & 0o022:
            reasons.append("group/other writable: " + cur)
        if cur == TRUSTED_BASE or cur == stop_at or os.path.dirname(cur) == cur:
            break
        cur = os.path.dirname(cur)
        seen += 1
        if seen > 40:
            reasons.append("path too deep to verify: " + path)
            break
    return reasons


def check(sid=None):
    reasons = []
    # rule 1: what the USER settings would contribute IF the launch loaded them.
    # With the launch pinned to --setting-sources '' (bead hq-ngef) user settings
    # are never read at exec, so there is nothing to validate and validating a
    # file that is not loaded would only false-refuse on a box where the owner has
    # his own user-level prefs. This block therefore runs only when the sources
    # actually include "user" (defense in depth if that is ever re-enabled).
    if LOADS_USER_SETTINGS and os.path.exists(USER_SETTINGS):
        try:
            u = load_json(USER_SETTINGS)
            allow = (u.get("permissions") or {}).get("allow") if isinstance(u, dict) else None
            for e in mutating_allow(allow):
                reasons.append("user settings allow: " + e)
            # --setting-sources user loads the user hooks too, and a hook runs
            # without a permission prompt: any user-level hook is refused.
            uhooks = u.get("hooks") if isinstance(u, dict) else None
            if isinstance(uhooks, dict) and any(isinstance(v, list) and v for v in uhooks.values()):
                reasons.append("user settings define hooks: " + ",".join(sorted(k for k, v in uhooks.items() if isinstance(v, list) and v)))
            # And the user-level permission MODE, for the same reason the hooks
            # matter: --setting-sources user loads this file. The gate reasoned
            # about allow rules and hooks and never looked at the mode, which is
            # the single switch that decides whether the uncaged session asks
            # before it acts. This box has dontAsk set at user level, so the
            # whole safety story rested on a command-line flag out-ranking a
            # settings file, which is a thing to verify rather than assume. The
            # gate no longer depends on winning that argument.
            umode = (u.get("permissions") or {}).get("defaultMode") if isinstance(u, dict) else None
            if umode is not None and umode != "default":
                reasons.append("user settings defaultMode is " + str(umode)[:40] + ", not default")
            # remoteControlAtStartup is the same shape of risk as hooks and the
            # permission mode: --setting-sources user loads it, and it makes the
            # uncaged session reachable from OUTSIDE the box, which is exactly
            # what physical-presence-is-the-control depends on not happening.
            # hqbox sets nothing today; the laptop sets it true, so refuse it at
            # user level before anyone turns it on where Capri starts. Not
            # agentPushNotifEnabled: that is a notification setting, not an
            # access one, so it stays out (bead hq-fb1y decided this explicitly).
            if isinstance(u, dict) and u.get("remoteControlAtStartup"):
                reasons.append("user settings remoteControlAtStartup is truthy: the uncaged session must not be reachable from outside the box")
        except Exception as e:  # noqa: BLE001
            reasons.append("user settings unreadable: " + str(e)[:120])
    # rule 2 + 3: the meta settings file and its hooks
    if not os.path.isdir(META_DIR):
        reasons.append("meta dir missing or unreadable: " + META_DIR)
        return {"ok": False, "reasons": reasons, "sid": sid}
    if writable(META_DIR):
        reasons.append("meta dir writable by this user")
    for r in verify_trusted(META_DIR):
        reasons.append("meta dir not trusted: " + r)
    if not os.path.isfile(META_SETTINGS):
        reasons.append("meta settings missing: " + META_SETTINGS)
    else:
        if writable(META_SETTINGS):
            reasons.append("meta settings writable by this user")
        for r in verify_trusted(META_SETTINGS):
            reasons.append("meta settings not trusted: " + r)
        try:
            m = load_json(META_SETTINGS)
            perms = m.get("permissions") if isinstance(m, dict) else None
            # Full trust (proposal 58; the owner, 2026-10-11): Capri runs with
            # bypassPermissions like every other console terminal, so the permission
            # mode and the allow list are no longer start-refusal rules.
            if not isinstance(perms, dict):
                reasons.append("meta settings have no permissions block")
            cmds = hook_commands(m)
            if not cmds:
                reasons.append("meta settings name no hooks")
            real_meta = os.path.realpath(META_DIR)
            for c in cmds:
                if not os.path.isabs(c):
                    reasons.append("hook path not absolute: " + c)
                    continue
                rc = os.path.realpath(c)
                if os.path.dirname(rc) != real_meta:
                    reasons.append("hook not directly inside the meta dir: " + c)
                if not os.path.isfile(rc):
                    reasons.append("hook missing: " + c)
                    continue
                if os.path.islink(c):
                    reasons.append("hook path is a symlink: " + c)
                if not os.access(rc, os.X_OK):
                    reasons.append("hook not executable: " + c)
                if writable(rc):
                    reasons.append("hook writable by this user: " + c)
                for r in verify_trusted(rc):
                    reasons.append("hook not trusted (" + c + "): " + r)
        except Exception as e:  # noqa: BLE001
            reasons.append("meta settings unreadable: " + str(e)[:120])
    # audit trail must be appendable, or the session runs with no record
    if os.path.exists(META_AUDIT):
        if not writable(META_AUDIT):
            reasons.append("audit file not writable by this user")
    elif not writable(META_DIR):
        reasons.append("audit file missing and not creatable: " + META_AUDIT)
    # rule 4: per-session state must be creatable with owner write access
    if not os.path.isdir(META_STATE):
        reasons.append("meta state dir missing: " + META_STATE)
    elif not writable(META_STATE):
        reasons.append("meta state dir not writable by this user")
    else:
        probe = os.path.join(META_STATE, (sid or "probe-%d" % os.getpid()) + ".check")
        try:
            os.mkdir(probe, 0o700)
            os.rmdir(probe)
        except Exception as e:  # noqa: BLE001
            reasons.append("cannot create a session state dir: " + str(e)[:120])
    return {"ok": not reasons, "reasons": reasons, "sid": sid, "home": HOME, "metaDir": META_DIR}


# -------------------------------------------------------------------- snapshot --
def session_dir(sid):
    if not SID_RE.match(sid or ""):
        die("bad sid")
    d = os.path.join(META_STATE, sid)
    os.makedirs(d, mode=0o755, exist_ok=True)
    return d


def list_unit_files():
    code, so, _ = run([SYSTEMCTL, "--user", "list-unit-files", "--no-legend", "--plain", "--no-pager"])
    res = {}
    if code == 0:
        for line in so.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                res[parts[0]] = parts[1]
    return res, code


def list_units():
    code, so, _ = run([SYSTEMCTL, "--user", "list-units", "--all", "--no-legend", "--plain", "--no-pager"])
    res = {}
    if code == 0:
        for line in so.splitlines():
            parts = line.split()
            if len(parts) >= 4:
                res[parts[0]] = parts[2] + "/" + parts[3]
    return res, code


def backup_file(sdir, rel, src):
    """Copy src into the session backup tree. Returns None on success, else a reason."""
    dst = os.path.join(sdir, "backup", rel)
    os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
    if os.path.getsize(src) > MAX_BACKUP_BYTES:
        return "too large to back up (%d bytes)" % os.path.getsize(src)
    shutil.copy2(src, dst)
    return None


def shell_file_paths():
    paths = [os.path.join(HOME, n) for n in SHELL_FILES]
    if os.path.isdir(AUTOSTART):
        for n in sorted(os.listdir(AUTOSTART)):
            if DESKTOP_RE.match(n):
                paths.append(os.path.join(AUTOSTART, n))
    return paths


def write_settings_baseline(sdir):
    """The integrity hook's session-start baseline (settings-baseline.sha256).

    Same watched set, order and line format as snapshot() in
    hook-meta-settings-integrity.sh: the hook compares its own recomputation to
    this file line by line and fails closed when the file is missing, so the
    pre-start snapshot has to leave it here or every mutating call is refused."""
    files = [
        USER_SETTINGS,
        os.path.join(HQ, ".claude", "settings.local.json"),
        os.path.join(HQ, ".claude", "settings.json"),
        META_SETTINGS,
    ]
    lines = []
    for p in files:
        if not os.path.exists(p):
            h = "MISSING"
        else:
            try:
                h = sha_file(p) if os.path.isfile(p) else "UNREADABLE"
            except OSError:
                h = "UNREADABLE"
        lines.append("%s  %s\n" % (h, p))
    dst = os.path.join(sdir, "settings-baseline.sha256")
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("".join(lines))
    os.chmod(tmp, 0o444)
    os.replace(tmp, dst)


def snapshot(sid, after=False):
    sdir = session_dir(sid)
    errors = []
    skipped = []
    if not after and os.path.exists(os.path.join(sdir, "snapshot.json")):
        # a reused sid would mix this session's backups with a previous one's
        out({"ok": False, "error": "snapshot already exists for this sid", "sid": sid})
    snap = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sid": sid, "home": HOME, "after": bool(after)}
    unit_files = {}
    if os.path.isdir(USER_UNITS):
        for root, _dirs, files in os.walk(USER_UNITS):
            for n in files:
                p = os.path.join(root, n)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue
                rel = os.path.relpath(p, USER_UNITS)
                try:
                    unit_files[rel] = sha_file(p)
                    if not after:
                        why = backup_file(sdir, os.path.join("units", rel), p)
                        if why:
                            skipped.append({"path": "units/" + rel, "why": why})
                except OSError as e:
                    unit_files[rel] = None
                    errors.append("units/%s: %s" % (rel, str(e)[:120]))
    uf, uf_code = list_unit_files()
    un, un_code = list_units()
    snap["units"] = {"files": unit_files, "unitFiles": uf, "units": un, "systemctl": uf_code == 0 and un_code == 0}
    code, so, se = run([CRONTAB, "-l"])
    snap["crontab"] = {"available": code != 127, "lines": [l for l in so.splitlines() if l.strip()] if code == 0 else []}
    code, so, se = run([ATQ])
    snap["at"] = {"available": code != 127, "lines": so.splitlines() if code == 0 else []}
    files = {}
    present = []
    for p in shell_file_paths():
        rel = os.path.relpath(p, HOME)
        try:
            lst = os.lstat(p)
            exists = True
        except OSError:
            lst = None
            exists = False
        if exists:
            present.append(rel)
        if lst is not None and S_ISREG(lst.st_mode):
            try:
                files[rel] = sha_file(p)
                if not after:
                    why = backup_file(sdir, os.path.join("home", rel), p)
                    if why:
                        skipped.append({"path": "home/" + rel, "why": why})
            except OSError as e:
                files[rel] = None
                errors.append("home/%s: %s" % (rel, str(e)[:120]))
        else:
            files[rel] = None
    snap["files"] = files
    snap["present"] = present
    snap["errors"] = errors
    snap["backupSkipped"] = skipped
    # each revert surface is only usable if its baseline was captured; a failed
    # enumeration must not read as an empty baseline (would let a pre-existing item
    # be "reverted"). "known" is what the revert verbs check.
    snap["known"] = {
        "units": bool(snap["units"]["systemctl"]),
        "crontab": bool(snap["crontab"]["available"]),
        "at": bool(snap["at"]["available"]),
        "files": True,
    }
    snap["ok"] = snap["known"]["units"]
    try:
        with open(os.path.join(sdir, "after.json" if after else "snapshot.json"), "w", encoding="utf-8") as f:
            json.dump(snap, f, sort_keys=True)
    except OSError as e:
        # without the on-disk snapshot the revert verbs cannot prove an item is
        # new, so the start must be refused: say so instead of pretending
        snap["ok"] = False
        snap["error"] = "cannot write snapshot: " + str(e)[:160]
    if not after:
        try:
            write_settings_baseline(sdir)
        except OSError as e:
            # the hook would refuse every mutating call of a session started
            # without it: refuse the start instead, with the reason on the card
            snap["ok"] = False
            snap["error"] = "cannot write settings baseline: " + str(e)[:160]
    return snap


# ---------------------------------------------------------------- scopes/stop --
def scopes():
    code, so, _ = run([SYSTEMCTL, "--user", "list-units", "--all", "--plain", "--no-legend", "--no-pager", "hq-meta-*.scope"])
    names = []
    if code == 0:
        for line in so.splitlines():
            parts = line.split()
            if parts and SCOPE_RE.match(parts[0]):
                names.append(parts[0])
    return {"scopes": names, "ok": code == 0}


GONE_STATES = ("inactive", "failed", "")


def unit_state(unit):
    code, so, _ = run([SYSTEMCTL, "--user", "is-active", unit])
    st = so.strip().splitlines()[0] if so.strip() else ""
    if code == 127:
        return "systemctl-missing"
    return st


def stop(sid):
    if not SID_RE.match(sid or ""):
        die("bad sid")
    unit = "hq-meta-%s.scope" % sid
    before = unit_state(unit)
    if before == "systemctl-missing":
        return {"unit": unit, "existed": False, "stopped": False, "state": before, "error": "systemctl not available"}
    existed = before not in GONE_STATES
    run([SYSTEMCTL, "--user", "stop", unit], timeout=25)
    st = unit_state(unit)
    # anything that is not plainly gone (active, activating, deactivating, reloading) gets the hammer
    for _ in range(10):
        if st in GONE_STATES:
            break
        run([SYSTEMCTL, "--user", "kill", "-s", "SIGKILL", unit])
        time.sleep(0.3)
        st = unit_state(unit)
    run([SYSTEMCTL, "--user", "reset-failed", unit])
    st = unit_state(unit)
    return {"unit": unit, "existed": existed, "stopped": st in GONE_STATES, "state": st or "inactive"}


# ------------------------------------------------------------------- revert --
def no_symlink_parents(base, dst):
    """Reason if any component of dst below base is a symlink (base itself excluded)."""
    base = os.path.abspath(base)
    dst = os.path.abspath(dst)
    if not (dst == base or dst.startswith(base + os.sep)):
        return "path escapes the base: " + dst
    rel = os.path.relpath(dst, base)
    cur = base
    for part in rel.split(os.sep):
        cur = os.path.join(cur, part)
        if os.path.islink(cur) and cur != dst:
            return "symlink parent: " + cur
    return None


def safe_write_over(src, dst):
    """Copy src over dst without following a symlink at dst or a symlinked parent:
    write a fresh temp with O_CREAT|O_EXCL|O_NOFOLLOW in the verified directory, then
    rename it over the target (replacing a symlink rather than writing through it)."""
    d = os.path.dirname(dst)
    tmp = os.path.join(d, "." + os.path.basename(dst) + ".meta-restore." + str(os.getpid()))
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with open(src, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                write_all(fd, chunk)
    finally:
        os.close(fd)
    os.replace(tmp, dst)


def write_all(fd, chunk):
    """os.write may write fewer bytes than requested (short write on some FUSE /
    network filesystems); loop until every byte lands, a zero-byte write is an
    error rather than silent truncation (lucy J8r2-4)."""
    mv = memoryview(chunk)
    while mv:
        n = os.write(fd, mv)
        if n <= 0:
            die("refused: short write while restoring")
        mv = mv[n:]


def copy_verify_publish(src_fd, dst, want):
    """Copy the verified backup descriptor into a staged temp while hashing the
    SAME bytes in one pass, then publish with os.replace. Returns the hash of the
    bytes actually written, so the caller compares it to the baseline and only a
    match survives. src_fd is already O_NOFOLLOW-opened, fstat'd regular, at
    offset 0. Never reopens src by pathname (lucy J8r2-1)."""
    d = os.path.dirname(dst)
    tmp = os.path.join(d, "." + os.path.basename(dst) + ".meta-restore." + str(os.getpid()))
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    h = hashlib.sha256()
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            chunk = os.read(src_fd, 65536)
            if not chunk:
                break
            write_all(fd, chunk)
            h.update(chunk)
    finally:
        os.close(fd)
    got = h.hexdigest()
    if got != want:
        # never publish unverified bytes
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return got
    os.replace(tmp, dst)
    return got


def safe_unlink(base, dst):
    why = no_symlink_parents(base, dst)
    if why:
        die("refused: " + why)
    try:
        os.unlink(dst)
        return True
    except FileNotFoundError:
        return False


def load_snapshot(sdir, sid=None):
    """The revert baseline. The runner (hqconsole) holds the pre-start snapshot
    in memory and hands it back on stdin, because the on-disk snapshot.json lives
    in the owner-writable session dir and the uncaged session (also owner) could
    edit or delete it to defeat its own auto-revert (bead hq-gbml). A snapshot on
    stdin is authoritative; the on-disk copy is a fallback only for a manual or
    legacy invocation with no stdin, never a thing to trust over what the runner
    said. A stdin snapshot for the wrong sid is refused rather than silently used."""
    # The baseline is MANDATORY on stdin and there is no on-disk fallback: the
    # session dir is owner-writable, so an on-disk snapshot.json (or an empty
    # stdin that fell back to it) is exactly the untrusted copy this fix exists to
    # stop trusting (lucy J8-2). Empty/tty stdin fails closed.
    if sys.stdin.isatty():
        die("refused: meta-revert needs the runner-held baseline on stdin (no terminal fallback)")
    raw = sys.stdin.read()
    if not raw or not raw.strip():
        die("refused: no baseline on stdin (the runner must hand it the pre-start snapshot)")
    try:
        snap = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        die("baseline on stdin is not JSON: " + str(e)[:120])
    if not isinstance(snap, dict) or snap.get("ok") is not True:
        die("baseline on stdin is not a usable snapshot")
    # Exact sid match, both canonical: a null/missing sid must NOT pass (lucy J8-2).
    bsid = snap.get("sid")
    if not isinstance(bsid, str) or not SID_RE.match(bsid) or bsid != sid:
        die("baseline on stdin is not bound to this sid")
    return snap


def validate_revert_name(kind, name):
    """Shape checks first, so a malformed name is refused as such before any state is read."""
    if kind == "unit":
        if not UNIT_REL_RE.match(name) or ".." in name.split("/"):
            die("bad unit name")
    elif kind == "stop":
        if not UNIT_NAME_RE.match(name):
            die("bad unit name")
    elif kind == "cron":
        if "\n" in name or not name.strip():
            die("bad cron line")
    elif kind == "at":
        if not AT_RE.match(name):
            die("bad at job")
    elif kind == "autostart":
        if not DESKTOP_RE.match(name):
            die("bad autostart name")
    elif kind == "restore":
        if ".." in name.split("/") or not (name.startswith("units/") or name.startswith("home/")):
            die("bad restore path")
        if name.startswith("units/") and not UNIT_REL_RE.match(name[len("units/"):]):
            die("bad unit name")
    else:
        die("bad revert kind")


def revert(sid, kind, name):
    if not SID_RE.match(sid or ""):
        die("bad sid")
    validate_revert_name(kind, name)
    sdir = os.path.join(META_STATE, sid)
    # Every revert is bound to THIS session's snapshot: removals only for items that
    # were absent at snapshot time, restores only for items that were present. The
    # caller (the runner, via sudo) never gets a free delete or a free write.
    snap = load_snapshot(sdir, sid)
    known = snap.get("known") or {}
    units_before = (snap.get("units") or {}).get("files") or {}
    active_before = (snap.get("units") or {}).get("units") or {}
    cron_before = set((snap.get("crontab") or {}).get("lines") or [])
    at_before = set(str(l).strip().split()[0] for l in ((snap.get("at") or {}).get("lines") or []) if str(l).strip())
    files_before = snap.get("files") or {}
    present_before = set(snap.get("present") or [])
    if kind == "unit":
        if not UNIT_REL_RE.match(name) or ".." in name.split("/"):
            die("bad unit name")
        if not known.get("units"):
            die("refused: unit baseline was not captured at snapshot time")
        if name in units_before:
            die("refused: unit existed at snapshot time: " + name)
        p = os.path.join(USER_UNITS, name)
        if not p.startswith(USER_UNITS + os.sep):
            die("unit outside the user unit dir")
        run([SYSTEMCTL, "--user", "disable", "--now", os.path.basename(name)], timeout=25)
        removed = safe_unlink(USER_UNITS, p)
        run([SYSTEMCTL, "--user", "daemon-reload"])
        return {"ok": True, "action": "unit removed" if removed else "unit already absent", "name": name}
    if kind == "stop":
        if not UNIT_NAME_RE.match(name):
            die("bad unit name")
        if TERMINAL_SCOPE_RE.match(name):
            die("refused: terminal scope, stopping it kills a terminal: " + name)
        if not known.get("units"):
            die("refused: unit baseline was not captured at snapshot time")
        # a unit that was already running at snapshot time is the owner's, never stopped
        # here; one that existed but was inactive and is running now was started by
        # the session, and stopping it only restores the state the snapshot recorded
        if name in active_before and str(active_before[name]).startswith(("active/", "activating/", "reloading/")):
            die("refused: unit was active at snapshot time: " + name)
        run([SYSTEMCTL, "--user", "stop", name], timeout=25)
        code, so, _ = run([SYSTEMCTL, "--user", "is-active", name])
        return {"ok": so.strip() != "active", "action": "unit stopped", "name": name}
    if kind == "cron":
        if "\n" in name or not name.strip():
            die("bad cron line")
        if not known.get("crontab"):
            die("refused: crontab baseline was not captured at snapshot time")
        if name in cron_before:
            die("refused: cron line existed at snapshot time")
        code, so, _ = run([CRONTAB, "-l"])
        if code != 0:
            return {"ok": True, "action": "no crontab", "name": name}
        kept = [l for l in so.splitlines() if l != name]
        if len(kept) == len(so.splitlines()):
            return {"ok": True, "action": "line already absent", "name": name}
        body = "\n".join(kept) + ("\n" if kept else "")
        try:
            p = subprocess.run([CRONTAB, "-"], input=body, text=True, capture_output=True, timeout=20, env=user_env())
            return {"ok": p.returncode == 0, "action": "cron line removed", "name": name}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "action": "crontab failed: " + str(e)[:120], "name": name}
    if kind == "at":
        if not AT_RE.match(name):
            die("bad at job")
        if not known.get("at"):
            die("refused: at baseline was not captured at snapshot time")
        if name in at_before:
            die("refused: at job existed at snapshot time: " + name)
        code, _so, se = run([ATRM, name])
        return {"ok": code == 0, "action": "at job removed" if code == 0 else "atrm failed: " + se.strip()[:120], "name": name}
    if kind == "autostart":
        if not DESKTOP_RE.match(name):
            die("bad autostart name")
        if (".config/autostart/" + name) in present_before:
            die("refused: autostart entry existed at snapshot time: " + name)
        p = os.path.join(AUTOSTART, name)
        removed = safe_unlink(AUTOSTART, p)
        return {"ok": True, "action": "autostart removed" if removed else "already absent", "name": name}
    if kind == "restore":
        # name is the backup-relative path: units/REL or home/REL
        # Validate the TARGET first, before any backup lookup: a path outside the
        # allowed set is refused whether or not a backup exists.
        if ".." in name.split("/") or not (name.startswith("units/") or name.startswith("home/")):
            die("bad restore path")
        if name.startswith("units/"):
            rel = name[len("units/"):]
            if not UNIT_REL_RE.match(rel):
                die("bad unit name")
            dst = os.path.join(USER_UNITS, rel)
        else:
            rel = name[len("home/"):]
            allowed = [os.path.relpath(p, HOME) for p in shell_file_paths()]
            if rel not in allowed and not (rel.startswith(".config/autostart/") and DESKTOP_RE.match(os.path.basename(rel))):
                die("restore target not in the allowed set")
            dst = os.path.join(HOME, rel)
        # only something that existed as a regular file at snapshot time can be
        # restored (a backup only exists for those); presence covers symlinks too
        existed = (rel in units_before) if name.startswith("units/") else (rel in present_before)
        if not existed:
            die("refused: nothing to restore, item was absent at snapshot time: " + name)
        src = os.path.join(sdir, "backup", name)
        # The backup lives in the owner-writable session dir, so its bytes are
        # untrusted. Open it ONCE with O_NOFOLLOW, hash that exact descriptor
        # against the runner-held baseline, and copy from the SAME descriptor:
        # reopening by pathname between the hash and the copy is a TOCTOU a owner
        # process could win by swapping the file (lucy J8-1, bead hq-gbml).
        want = (units_before.get(rel) if name.startswith("units/") else files_before.get(rel))
        if not want:
            die("refused: no baseline hash for " + name + ", cannot vouch for the backup")
        try:
            bfd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {"ok": False, "action": "no backup for " + name, "name": name}
        except OSError as e:
            die("refused: backup unreadable: " + str(e)[:120])
        try:
            st = os.fstat(bfd)
            if not S_ISREG(st.st_mode):
                die("refused: backup is not a regular file: " + name)
            base = USER_UNITS if name.startswith("units/") else HOME
            why = no_symlink_parents(base, dst)
            if why:
                die("refused: " + why)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            # One pass: copy the verified fd into the staged temp while hashing the
            # SAME bytes, compare against the runner-held baseline, and only then
            # publish. The bytes written are the bytes hashed, so the inode cannot
            # be swapped between a hash read and a copy read (lucy J8r2-1).
            # Residual, accepted for a single-user box (CLAUDE.md review doctrine):
            # the final os.replace resolves a temp pathname in the owner-owned
            # dest dir, and the parent dir is re-resolved after no_symlink_parents,
            # so a CONCURRENT process running as owner could still race the
            # publish. That process already IS owner and can write these files
            # directly without meta-revert, so restore atomicity is not the
            # boundary here; the boundary is the per-action permission prompt, the
            # surfaced revert failure, and the close-time integrity check.
            got = copy_verify_publish(bfd, dst, want)
            if got != want:
                die("refused: backup for " + name + " does not match the baseline (tampered)")
        finally:
            os.close(bfd)
        if name.startswith("units/"):
            run([SYSTEMCTL, "--user", "daemon-reload"])
        return {"ok": True, "action": "restored from snapshot backup", "name": name}
    die("bad revert kind")


# ---------------------------------------------------------------- integrity --
def integrity():
    code, so, se = run([BASH, os.path.join(HQ, "ops", "scripts", "canaries.sh")], timeout=180, cwd=HQ)
    tail = (so + se).splitlines()[-15:]
    c2, status, _ = run([GIT, "-C", HQ, "status", "--porcelain", "--"] + CAGE_PATHS, timeout=60)
    c3, stat, _ = run([GIT, "-C", HQ, "diff", "--stat", "HEAD", "--"] + CAGE_PATHS, timeout=60)
    files = [l[3:].strip() for l in status.splitlines() if l.strip()]
    return {
        "canaries": {"ok": code == 0, "exit": code, "tail": tail},
        "cage": {"clean": c2 == 0 and not files, "files": files, "stat": stat.strip().splitlines()[-12:], "gitOk": c2 == 0 and c3 == 0},
    }


def main(argv):
    if not argv:
        die("usage: meta-verbs.py check|snapshot|scopes|stop|revert|integrity ...")
    cmd, args = argv[0], argv[1:]
    if cmd == "check":
        sid = args[0] if args else None
        if sid is not None and not SID_RE.match(sid):
            die("bad sid")
        out(check(sid))
    if cmd == "snapshot" and len(args) in (1, 2):
        if len(args) == 2 and args[1] != "after":
            die("bad snapshot mode")
        out(snapshot(args[0], len(args) == 2))
    if cmd == "scopes" and not args:
        out(scopes())
    if cmd == "stop" and len(args) == 1:
        out(stop(args[0]))
    if cmd == "revert" and len(args) == 3:
        out(revert(args[0], args[1], args[2]))
    if cmd == "integrity" and not args:
        out(integrity())
    die("bad command or arity: " + cmd)


if __name__ == "__main__":
    main(sys.argv[1:])
