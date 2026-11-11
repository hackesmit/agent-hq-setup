#!/usr/bin/env bash
# PreToolUse hook (Bash): refuse `git commit` made directly on a RIG's canonical
# clone while it sits on the default branch (main/master/develop/trunk).
#
# HQ git model: workers live in worktrees (~/hq-<suffix>) on a per-bead branch,
# commit there, and finish.sh merges that branch into the rig default with
# `git merge` (never a raw `git commit` on the canonical). So a `git commit`
# landing on a rig's canonical default branch is almost always a mistake that
# bypasses the review -> merge flow (invariant 7). Block it and point at the
# worktree.
#
# Passes through (exit 0):
#   - worktrees (git-dir != git-common-dir) -> the branch IS the isolation
#   - the HQ repo itself (config/cage commits by the overseer are legitimate)
#   - any non-default branch
#   - anything outside ~/hq/rigs/ or not a git repo
# Fail-open on any uncertainty.
set -uo pipefail
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
# A rig worker loads this hook through ops/config/worker-hooks.json, so its project dir is
# the rig, not hq. spawn.sh exports HQ_HOOK_DIR (the main hq checkout's ops/scripts) for
# exactly those workers, so state lands in hq by an explicit root, never by a filename guess.
if [ -n "${HQ_HOOK_DIR:-}" ] && [ -d "$HQ_HOOK_DIR" ]; then HQ="$(cd "$HQ_HOOK_DIR/../.." && pwd)"
elif [ ! -f "$HQ/ops/scripts/$(basename "$0")" ]; then HQ="$(cd "$(dirname "$0")/../.." && pwd)"; fi
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

# Fire only on a real `git commit` (not commit-tree, --help, --dry-run, log...).
if not re.search(r'(^|[;&|]\s*|\s)git\s+commit(\s|$)', cmd):
    sys.exit(0)
if re.search(r'git\s+commit\s+(--help|-h|--dry-run)', cmd):
    sys.exit(0)

# Effective directory: leading `cd <path>` wins, else `-C <dir>`, else payload cwd.
d_dir = d.get("cwd") or os.getcwd()
m = re.search(r'(?:^|;\s*|&&\s*|\|\|\s*)cd\s+([^\s;&|]+)', cmd)
if m:
    d_dir = m.group(1).strip().strip("'").strip('"')
else:
    mc = re.search(r'-C\s+(\S+)', cmd)
    if mc:
        d_dir = mc.group(1)
if d_dir.startswith("~"):
    d_dir = os.path.expanduser(d_dir)

def git(*a):
    return subprocess.run(["git", "-C", d_dir, *a], capture_output=True, text=True, timeout=15)

try:
    if not os.path.isdir(d_dir):
        sys.exit(0)
    gd = git("rev-parse", "--git-dir")
    gc = git("rev-parse", "--git-common-dir")
    if gd.returncode or gc.returncode:
        sys.exit(0)  # not a repo we can read -> allow
    canonical = os.path.abspath(os.path.join(d_dir, gd.stdout.strip())) == \
                os.path.abspath(os.path.join(d_dir, gc.stdout.strip()))
    if not canonical:
        sys.exit(0)  # worktree -> the branch is the isolation, allow
    top = git("rev-parse", "--show-toplevel").stdout.strip()
    branch = git("branch", "--show-current").stdout.strip()
except Exception:
    sys.exit(0)

if not top or not branch:
    sys.exit(0)

hq = os.path.abspath(os.environ.get("HQ", ""))
rigs = os.path.join(hq, "rigs") + os.sep
# Only rig canonical clones are gated; the HQ repo and non-rig paths are exempt.
if not os.path.abspath(top).startswith(rigs):
    sys.exit(0)
if branch not in ("main", "master", "develop", "trunk"):
    sys.exit(0)

rig = os.path.basename(top)
print(f"{rig}|{branch}")
sys.exit(2)
PY
)"
rc=$?
if [ "$rc" -eq 2 ]; then
  rig="${REASON%%|*}"; branch="${REASON##*|}"
  cat >&2 <<EOF
BLOCKED: refusing a direct \`git commit\` on ${rig}'s canonical default branch ($branch).

HQ workers commit on their own worktree branch; finish.sh is what merges that
branch into $branch (via git merge, after review). Committing straight onto the
canonical $branch bypasses that flow (invariant 7).

To recover:
  - If you are a worker: commit inside your ~/hq-<bead> worktree, not here.
  - If you genuinely need this change on $branch, make it on a branch and let
    finish.sh merge it, or ask the owner.
EOF
  exit 2
fi
exit 0
