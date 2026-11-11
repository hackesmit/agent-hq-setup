#!/usr/bin/env bash
# PreToolUse hook (hq-4npjr.26): the orchestrator chat terminal delegates; it does
# not do the work inline. Acts ONLY when HQ_CONSOLE_ROLE=orchestrator, which the
# console server sets when it launches the role "orchestrator" terminal (server.js
# /api/session/new). Every other session (workers, Alt-key terminals, headless
# orchestrator runs) passes through untouched.
#
# Denied in the chat terminal: WebSearch, WebFetch, Artifact, NotebookEdit, a
# foreground Agent/Task (allowed only with run_in_background true), and
# Write/Edit/MultiEdit outside state/, ops/reference/owner-facts.md, a Claude
# scratchpad under /tmp, or Claude auto-memory (~/.claude/projects/*/memory/).
# Bash, Read, bd, ctl.sh, george.sh and orchestrator_log.py stay allowed.
# Fail-open on an unreadable payload: a broken hook must not wedge the terminal.
set -uo pipefail
[ "${HQ_CONSOLE_ROLE:-}" = "orchestrator" ] || exit 0
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD
HQ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" export HQ_ROOT

REASON="$(python3 - <<'PY'
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)
tool = str(d.get("tool_name") or "")
ti = d.get("tool_input") or {}
if not isinstance(ti, dict):
    ti = {}
DISPATCH = ("Create a bead (bd create, --parent the epic) and dispatch a worker "
            "(ops/scripts/spawn.sh <rig> \"<task>\" --worker --bead <id>, or "
            "ops/console/ctl.sh dispatch-batch), then tell the owner what was dispatched "
            "and how the result arrives. The chat terminal must be free again within "
            "about 2 minutes (seed: ops/templates/orchestrator.md).")

def deny(what):
    print(f"Blocked (orchestrator delegates, hq-4npjr.26): {what} is worker work. {DISPATCH}")
    sys.exit(2)

if tool in ("WebSearch", "WebFetch"):
    deny("web research")
if tool == "Artifact":
    deny("publishing an artifact")
if tool == "NotebookEdit":
    deny("notebook editing")
if tool in ("Agent", "Task"):
    if ti.get("run_in_background") is True:
        sys.exit(0)
    deny("a foreground Agent (it holds this terminal until it returns; pass run_in_background: true for a quick lookup)")
if tool in ("Write", "Edit", "MultiEdit"):
    p = str(ti.get("file_path") or "")
    if not p:
        sys.exit(0)
    root = os.path.realpath(os.environ["HQ_ROOT"])
    base = d.get("cwd") or root
    full = os.path.realpath(os.path.join(base, os.path.expanduser(p)))
    home = os.path.realpath(os.path.expanduser("~"))
    def under(prefix):
        return full == prefix or full.startswith(prefix.rstrip("/") + "/")
    parts = full.split("/")
    ok = (
        under(os.path.join(root, "state"))
        or full == os.path.join(root, "ops", "reference", "owner-facts.md")
        or (full.startswith("/tmp/") and "scratchpad" in parts)
        or (under(os.path.join(home, ".claude", "projects")) and "memory" in parts)
    )
    if ok:
        sys.exit(0)
    deny(f"editing {full} (the chat terminal writes only state/, ops/reference/owner-facts.md, its scratchpad and memory)")
sys.exit(0)
PY
)"
if [ $? -eq 2 ]; then printf '%s\n' "$REASON" >&2; exit 2; fi
exit 0
