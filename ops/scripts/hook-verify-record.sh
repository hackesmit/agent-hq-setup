#!/usr/bin/env bash
# PostToolUse hook (Edit|Write|MultiEdit|Bash): the verification ledger recorder.
# Appends structured records to state/verify/$SESSION.jsonl — the audit trail behind
# invariant 6's receipt gate and the session-eval packet's raw material.
#   - Edit/Write/MultiEdit  -> a change record with the file path.
#   - Bash matching a verify regex   -> a verify record (tests, typecheck, lint,
#     jq, bash -n, git diff --check, curl status, screenshot read).
#   - Bash matching a mutation regex -> a change record with the command + target.
# Read-only, non-verify Bash creates nothing (keeps the ledger from filling with noise).
# Pure local file ops, no model calls. Fail-open, fast-exit on the common case.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
# A rig worker loads this hook through ops/config/worker-hooks.json, so its project dir is
# the rig, not hq. spawn.sh exports HQ_HOOK_DIR (the main hq checkout's ops/scripts) for
# exactly those workers, so state lands in hq by an explicit root, never by a filename guess.
if [ -n "${HQ_HOOK_DIR:-}" ] && [ -d "$HQ_HOOK_DIR" ]; then HQ="$(cd "$HQ_HOOK_DIR/../.." && pwd)"
elif [ ! -f "$HQ/ops/scripts/$(basename "$0")" ]; then HQ="$(cd "$(dirname "$0")/../.." && pwd)"; fi
# A session in an hq worktree records to the main checkout, which outlives the worktree.
_hq_main="$(git -C "$HQ" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
case "$_hq_main" in */.git) [ -d "${_hq_main%/.git}/ops/scripts" ] && HQ="${_hq_main%/.git}" ;; esac
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD HQ

python3 - <<'PY'
import json, os, re, sys, datetime

hq = os.environ["HQ"]
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)

tool = d.get("tool_name", "")
ti = d.get("tool_input") or {}
sid = d.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "unknown"
sid = re.sub(r"[^A-Za-z0-9._-]", "_", str(sid))[:80] or "unknown"

records = []  # each: (kind, target, detail)

if tool in ("Edit", "Write", "MultiEdit"):
    p = ti.get("file_path") or ti.get("path") or ""
    if p:
        records.append(("change", p, tool))
elif tool == "Bash":
    cmd = str(ti.get("command", ""))
    if cmd.strip():
        VERIFY = re.compile(
            r"\b(pytest|vitest|jest|go\s+test|cargo\s+test|npm\s+test|pnpm\s+(?:test|-s?\s*test)"
            r"|yarn\s+test|tsc\b|mypy|ruff|eslint|golangci|\blint\b|bash\s+-n|jq\s"
            r"|git\s+diff\s+--check|screenshot|playwright)\b", re.I)
        MUTATE = re.compile(
            r"(git\s+(push|commit|merge|rebase|reset|checkout|switch|revert|cherry-pick)"
            r"|\brm\b|\bmv\b|\bcp\b|\btee\b|\bdd\b|>>?\s*\S|npm\s+publish|pnpm\s+publish"
            r"|vercel\b|docker\s+(build|push|run)|curl[^|]*-X\s*(POST|PUT|PATCH|DELETE)"
            r"|\bpsql\b|\bbq\b\s|supabase\b)", re.I)
        # verify classification wins over mutation (a test that writes a snapshot is still a verify)
        if VERIFY.search(cmd):
            records.append(("verify", cmd[:200], "bash"))
        elif MUTATE.search(cmd):
            records.append(("change", cmd[:200], "bash"))

if not records:
    sys.exit(0)

ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
outdir = os.path.join(hq, "state", "verify")
try:
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, f"{sid}.jsonl"), "a") as f:
        for kind, target, detail in records:
            f.write(json.dumps({"ts": ts, "kind": kind, "tool": tool,
                                "target": target, "detail": detail}) + "\n")
except OSError:
    sys.exit(0)
PY
exit 0
