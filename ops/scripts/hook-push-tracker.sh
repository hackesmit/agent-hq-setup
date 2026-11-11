#!/usr/bin/env bash
# Dual-event hook (wired to both PostToolUse Bash and Stop).
#   PostToolUse: record the PATH each mutation touched (file path for Edit/Write,
#     directory for Bash git mutations) to state/touched-<sid> —
#     WITHOUT forking git (the old per-Edit `git rev-parse` was pure hot-path overhead).
#     Repo-root resolution is deferred to Stop, where it runs once per unique dir.
#   Stop: resolve tracked paths -> repo roots (deduped), then block session end (exit 2)
#     if any is left with uncommitted changes. In the shared HQ tree the check is scoped
#     to THIS session's touched paths (every terminal shares that working tree, so a
#     whole-repo status would flag a neighbor's work); worktrees and rigs keep the
#     whole-repo check, where one session owns the tree and it is the right signal.
#     HQ workers are commit-only, so "left dirty"
#     = work not committed before the session ended, the exact failure to catch.
#     Respects stop_hook_active; fail-open.
#   Removed 2026-08-20 (bead hq-qph1): the kind=overseer exemption. Nothing registers
#     as overseer any more (hook-session-register's overseer branch is gone too), so the
#     lookup was a per-Stop read of state/sessions.json that could never match.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD HQ

REASON="$(python3 - <<'PY'
import json, os, re, subprocess, sys
hq = os.environ["HQ"]
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)

sid = str(d.get("session_id") or "unknown")
sid = re.sub(r"[^A-Za-z0-9._-]", "_", sid)[:80] or "unknown"
event = d.get("hook_event_name") or d.get("hookEventName") or ""
track = os.path.join(hq, "state", f"touched-{sid}")

def repo_root(path):
    try:
        r = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""

if event == "PostToolUse":
    tool = d.get("tool_name", "")
    ti = d.get("tool_input") or {}
    cand = ""; extra = []
    if tool in ("Edit", "Write", "MultiEdit"):
        # record the FILE path, not its directory: the Stop gate scopes the shared-HQ
        # dirty check to this session's own paths, so file granularity is what keeps a
        # neighbor terminal's dirt in the same tree from flagging this session
        cand = str(ti.get("file_path") or ti.get("path") or "")
    elif tool == "Bash":
        cmd = str(ti.get("command", ""))
        m = re.search(r"\bgit\s+(?:-C\s+\S+\s+)?(commit|merge|add|revert|rm|mv)\b", cmd)
        if m:
            mc = re.search(r"-C\s+(\S+)", cmd)
            base = os.path.expanduser(mc.group(1)) if mc else (d.get("cwd") or os.getcwd())
            cand = base
            # ALSO record explicit path arguments of add/rm/mv, so a session's own
            # bash-staged files stay visible to the scoped shared-tree check at Stop
            # (a bare cwd record at the hq root carries no path information there)
            if m.group(1) in ("add", "rm", "mv"):
                tail = cmd[m.end():].split(";")[0].split("&&")[0].split("|")[0]
                try:
                    import shlex
                    toks = shlex.split(tail)
                except Exception:
                    toks = None
                # blanket forms claim the whole tree: record a sentinel that restores
                # the unscoped status check for THIS session (old behavior), instead
                # of silently dropping the record. Unparseable tails are treated the
                # same, conservatively. (Proposal 12 separately refuses blanket adds
                # in the shared hq tree; this covers the guard-off case.)
                blanket = toks is None or any(
                    t in (".", "-A", "--all", "-u", "--update", "--pathspec-from-file")
                    or t.startswith("--pathspec-from-file=")
                    or re.search(r"[*?\[]", t)
                    for t in toks)
                if blanket:
                    extra.append("::wholetree::" + base)
                else:
                    for tok in toks:
                        if not tok or tok.startswith("-"):
                            continue
                        tok = os.path.expanduser(tok)
                        extra.append(tok if os.path.isabs(tok) else os.path.join(base, tok))
    if not cand:
        sys.exit(0)
    # Record the raw dir only — NO git fork here (that was the per-Edit overhead).
    # Repo-root resolution happens once per unique dir at Stop.
    cands = [os.path.expanduser(cand)] + extra
    try:
        os.makedirs(os.path.dirname(track), exist_ok=True)
        prior = set(open(track).read().split("\n")) if os.path.exists(track) else set()
        new = [c for c in cands if c not in prior]
        if new:
            with open(track, "a") as f:
                f.write("\n".join(new) + "\n")
    except Exception:
        pass
    sys.exit(0)

if event == "Stop":
    if d.get("stop_hook_active"):
        sys.exit(0)
    if os.environ.get("HQ_PUSH_GATE", "1") == "0":   # escape hatch, symmetric w/ HQ_VERIFY_BLOCK
        sys.exit(0)
    if not os.path.exists(track):
        sys.exit(0)
    try:
        dirs = [r for r in open(track).read().split("\n") if r.strip()]
    except Exception:
        sys.exit(0)
    # resolve entries -> repo roots once, deduped (climb to a real parent for paths that
    # do not exist yet), keeping which touched paths belong to each root
    repos = {}
    full = set()   # roots where this session claimed the whole tree (blanket git add)
    for entry in dirs:
        if entry.startswith("::wholetree::"):
            entry = entry[len("::wholetree::"):]
            root = repo_root(entry) if os.path.isdir(entry) else ""
            if root:
                full.add(os.path.realpath(root))
                repos.setdefault(os.path.realpath(root), set())
            continue
        c = entry
        while c and c != "/" and not os.path.exists(c):
            c = os.path.dirname(c)
        probe = c if os.path.isdir(c) else os.path.dirname(c)
        root = repo_root(probe)
        if root:
            repos.setdefault(os.path.realpath(root), set()).add(entry)
    hq_root = os.path.realpath(hq)
    dirty = []
    for r, touched in repos.items():
        if not os.path.isdir(r):
            continue
        cmd = ["git", "-C", r, "status", "--porcelain"]
        if r == hq_root and r not in full:
            # the HQ repo is ONE working tree shared by every terminal: a whole-repo
            # status here reports the neighbors' uncommitted work as this session's.
            # Scope the check to the paths THIS session touched; a bare root entry
            # (recorded from a git command run at the top level) carries no path
            # information, so it cannot justify flagging the whole shared tree.
            specs = []
            for p in sorted(touched):
                rp = os.path.realpath(p) if os.path.exists(p) else os.path.normpath(p)
                if rp == r or not rp.startswith(r + os.sep):
                    continue
                specs.append(os.path.relpath(rp, r))
            if not specs:
                continue
            cmd += ["--"] + specs
        try:
            env = dict(os.environ, GIT_LITERAL_PATHSPECS="1")   # filenames are data, never pathspec magic
            st = subprocess.run(cmd, capture_output=True, text=True, timeout=15, env=env)
            if st.returncode == 0 and st.stdout.strip():
                dirty.append(r)
        except Exception:
            pass
    if dirty:
        print("Uncommitted work in a repo you touched this session: "
              + ", ".join(os.path.basename(x) for x in dirty)
              + ". Workers are commit-only — commit before ending, then a clean stop is "
                "the completion signal. (If intentionally leaving WIP, commit a WIP marker.)")
        sys.exit(2)
    sys.exit(0)

sys.exit(0)
PY
)"
if [ $? -eq 2 ]; then printf '%s\n' "$REASON" >&2; exit 2; fi
exit 0
