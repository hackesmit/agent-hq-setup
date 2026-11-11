#!/usr/bin/env bash
# PreToolUse hook (Bash): refuse blanket staging inside the HQ repo itself.
#
# Rigs are safe: two terminals on the same rig get separate worktrees, so their
# working trees cannot overlap. The HQ repo has no such separation and is the
# one repo EVERY terminal touches, because ops/, tests/ and state/ all live in
# it. A blanket `git add -A` there stages whatever other sessions happen to have
# uncommitted right now.
#
# This is not hypothetical. On 2026-08-12 commit c0b114a, authored by a terminal
# working on acme-financial and titled "calidad: cerrar los dos hallazgos de la
# revision cruzada de lucy", also contained 103 lines of another session's
# in-progress console work across five files. Nothing was lost, but the real
# damage is upstream of tidiness: the diff handed to an adversarial reviewer no
# longer matches what the author actually changed, which silently defeats the
# review gate (invariant 6). It was caught only because the reviewer said the
# files it had been asked to review were not in the diff.
#
# Blocked in ~/hq (canonical clone only):
#   git add -A | --all | -u | --update | . | ./ | :/ | --pathspec-from-file
#   git commit -a | -am | --all
#   (-u is blocked too: it sweeps every tracked modification, which is exactly
#   what the c0b114a incident consisted of; explicit paths are the habit)
# Passes through (exit 0):
#   - explicit paths: `git add ops/console tests/foo.sh` (the intended habit)
#   - anything outside the HQ repo, including every rig and every worktree
#   - --help / --dry-run / add -n, judged per invocation, never command-wide
#   - anything we cannot parse
# Fail-open on any uncertainty, like the other workflow hooks.
set -uo pipefail
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD
# canonical HQ from THIS script's location, never from CLAUDE_PROJECT_DIR: a
# session launched inside a rig worktree carries the rig as its project dir,
# which would make `git -C ~/hq add -A` from exactly those sessions pass.
# HQ_DIR is the explicit override seam for the test fixtures.
HQ="${HQ_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
export HQ

REASON="$(python3 - <<'PY'
import json, os, re, subprocess, sys
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)
if d.get("tool_name") != "Bash":
    sys.exit(0)
cmd = str((d.get("tool_input") or {}).get("command", ""))

# EVERY git invocation in the command is inspected INDEPENDENTLY: a --dry-run
# or --help on one invocation never excuses another, and each invocation's own
# -C / preceding cd decides which repo it acts on. `git add file && git add -A`
# and `git -C /tmp/x add -A; git -C ~/hq add -A` are both fully evaluated.
CMDPOS = r'(?:^\s*|[;&|(]\s*|\n\s*)'
GIT = re.compile(
    CMDPOS + r'(?:env\s+|command\s+|sudo\s+)?git\s+'
    r'(?P<globals>(?:-[A-Za-z]\s*\S*\s+|--[a-z-]+(?:=\S+)?\s+)*)'
    r'(?P<sub>add|commit)\b(?P<rest>[^;&|\n]*)')

def unq(s):
    return s.strip().strip("'").strip('"')

cands = []   # (hit description, -C dir or empty, match start offset)
for m in GIT.finditer(cmd):
    sub, rest = m.group("sub"), m.group("rest")
    # inert forms, judged per invocation only
    if re.search(r'(^|\s)(--help|-h|--dry-run)(\s|$)', rest):
        continue
    if sub == "add" and re.search(r'(^|\s)-[A-Za-z]*n[A-Za-z]*(\s|$)', rest):
        continue   # git add -n is a dry run (commit -n is no-verify, NOT exempt)
    gm = re.search(r'-C\s+(\S+)', m.group("globals") or "")
    gc_dir = unq(gm.group(1)) if gm else ""
    blanket = False
    if sub == "add":
        # -A/--all, -u/--update (sweeps every tracked modification, exactly the
        # c0b114a incident class), whole-tree pathspecs, and pathspec files
        if re.search(r'(^|\s)(-[A-Za-z]*[Au][A-Za-z]*|--all|--update)(\s|$)', rest) \
           or re.search(r'(^|\s)(\.|\./|:/|:\(top\)\S*)(\s|$)', rest) \
           or re.search(r'(^|\s)--pathspec-from-file', rest):
            blanket = True
    else:
        if re.search(r'(^|\s)--all(\s|$)', rest) or re.search(r'(^|\s)-[A-Za-z]*a[A-Za-z]*(\s|$)', rest):
            blanket = True
    if blanket:
        cands.append(("git " + sub + " " + rest.strip(), gc_dir, m.start()))
if not cands:
    sys.exit(0)

def eff_dir(start, chint):
    # this invocation's -C wins; else the last `cd <path>` before it; else cwd.
    # cds inside (...) subshells do not change the parent shell's directory, so
    # strip parenthesized groups before scanning (one nesting level; deeper
    # nesting stays imperfect, consistent with the fail-open regex doctrine)
    if chint:
        dd = chint
    else:
        dd = d.get("cwd") or os.getcwd()
        before = cmd[:start]
        prev = None
        while prev != before:
            prev = before
            before = re.sub(r'\([^()]*\)', ' ', before)
        for cm in re.finditer(r'(?:^|[;&|]\s*)cd\s+([^\s;&|]+)', before):
            dd = unq(cm.group(1))
    return os.path.expanduser(dd)

def git(d_dir, *a):
    return subprocess.run(["git", "-C", d_dir, *a], capture_output=True, text=True, timeout=15)

hq = os.path.abspath(os.environ.get("HQ", ""))
hit = ""; hit_dir = ""
for desc, chint, start in cands:
    d_dir = eff_dir(start, chint)
    try:
        if not os.path.isdir(d_dir):
            continue
        gd = git(d_dir, "rev-parse", "--git-dir")
        gc = git(d_dir, "rev-parse", "--git-common-dir")
        if gd.returncode or gc.returncode:
            continue
        canonical = os.path.abspath(os.path.join(d_dir, gd.stdout.strip())) == \
                    os.path.abspath(os.path.join(d_dir, gc.stdout.strip()))
        if not canonical:
            continue   # a worktree owns its own tree; nothing foreign to sweep
        top = git(d_dir, "rev-parse", "--show-toplevel").stdout.strip()
    except Exception:
        continue
    if top and os.path.abspath(top) == hq:
        hit = desc; hit_dir = d_dir
        break   # only the HQ repo itself is gated; one hq hit is enough to block
if not hit:
    sys.exit(0)

# How much would actually be swept, so the message is concrete rather than a
# lecture. Cheap: one porcelain call.
try:
    dirty = [l[3:] for l in git(hit_dir, "status", "--porcelain").stdout.splitlines() if l.strip()]
except Exception:
    dirty = []
print(hit + "|" + str(len(dirty)) + "|" + ", ".join(dirty[:6]))
sys.exit(2)
PY
)"
rc=$?
if [ "$rc" -eq 2 ]; then
  what="${REASON%%|*}"; rest="${REASON#*|}"
  n="${rest%%|*}"; files="${rest#*|}"
  cat >&2 <<EOF
BLOCKED: refusing blanket staging in the HQ repo ($what).

~/hq is shared by every terminal, so this would stage whatever OTHER sessions
have uncommitted right now. There are currently $n modified path(s):
  $files

That already happened once (commit c0b114a swept 103 lines of another session's
console work into an unrelated acme-financial commit). The real cost is that
the diff an adversarial reviewer receives stops matching what you changed.

Stage the paths you actually touched instead:
  git add ops/console/ctl.sh tests/console-test.sh
  git commit -F <message-file>

Rig worktrees are unaffected; this gate is only the HQ repo itself.
EOF
  exit 2
fi
exit 0
