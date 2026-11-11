#!/usr/bin/env bash
# PreToolUse hook (Bash): block a hard switch/checkout/reset --hard in a DIRTY shared
# canonical clone, so one session cannot stomp another's uncommitted work. A canonical
# clone has git-dir == git-common-dir; a worktree has them differ. Passes cleanly for:
# clean trees, worktrees (workers live here), and new-branch creation (-b / -c).
# Fail-open: if anything can't be determined, allow.
set -uo pipefail
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD

REASON="$(python3 - <<'PY'
import json, os, re, subprocess, sys
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)
if d.get("tool_name") != "Bash":
    sys.exit(0)
cmd = str((d.get("tool_input") or {}).get("command", ""))

# Is this a destructive checkout/switch/reset --hard? (not a new-branch create)
danger = False
if re.search(r"\bgit\s+reset\b[^|&;]*--hard", cmd):
    danger = True
if re.search(r"\bgit\s+(checkout|switch)\b", cmd):
    if not re.search(r"(?:^|\s)-[bB]\b|(?:^|\s)-c\b|--orphan", cmd):
        danger = True
if not danger:
    sys.exit(0)

# Effective directory: -C <dir> wins, else payload cwd, else process cwd.
mc = re.search(r"-C\s+(\S+)", cmd)
d_dir = mc.group(1) if mc else (d.get("cwd") or os.getcwd())
d_dir = os.path.expanduser(d_dir)

def git(*a):
    return subprocess.run(["git", "-C", d_dir, *a], capture_output=True,
                          text=True, timeout=15)
try:
    gd = git("rev-parse", "--git-dir")
    gc = git("rev-parse", "--git-common-dir")
    if gd.returncode or gc.returncode:
        sys.exit(0)  # not a repo we can read -> allow
    canonical = os.path.abspath(os.path.join(d_dir, gd.stdout.strip())) == \
                os.path.abspath(os.path.join(d_dir, gc.stdout.strip()))
    if not canonical:
        sys.exit(0)  # worktree -> allow
    st = git("status", "--porcelain")
    dirty = bool(st.stdout.strip())
except Exception:
    sys.exit(0)

if canonical and dirty:
    print(f"Blocked: destructive `git {('reset --hard' if 'reset' in cmd else 'checkout/switch')}` "
          f"in a dirty canonical clone ({d_dir}). Uncommitted work would be lost and this "
          f"clone is shared. Commit or stash first, or run it in your own worktree.")
    sys.exit(2)
sys.exit(0)
PY
)"
if [ $? -eq 2 ]; then printf '%s\n' "$REASON" >&2; exit 2; fi
exit 0
