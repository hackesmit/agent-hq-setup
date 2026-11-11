#!/usr/bin/env bash
# term-kill.sh [pane-id]  — kill a terminal pane, deregister it, re-tile the rest.
# Default target: the currently focused pane. The worktree (if any) is LEFT intact and
# recoverable — use finish.sh for a real merge + worktree cleanup. Bound to Alt-x.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"

pane="${1:-$(tmux display-message -p '#{pane_id}' 2>/dev/null)}"
[ -n "$pane" ] || { echo "term-kill: no pane target" >&2; exit 1; }

# deregister the session whose window == this pane id (best-effort)
id="$(PANE="$pane" "$REGSH" list --json 2>/dev/null | PANE="$pane" python3 -c '
import json,sys,os
p=os.environ["PANE"]
try: rows=json.load(sys.stdin)
except Exception: rows=[]
for r in rows:
    if r.get("tmux_window")==p: print(r["id"]); break' 2>/dev/null)"
[ -n "$id" ] && "$REGSH" deregister "$id" >/dev/null 2>&1 || true

tmux kill-pane -t "$pane" 2>/dev/null || true
"$SCRIPT_DIR/term-retile.sh" hq:work >/dev/null 2>&1 || true
# feedback via the transient status line only: stdout under run-shell becomes a sticky
# copy-mode view (the lingering "killed t-xxxx" screen), so echo only when interactive
tmux display-message "killed ${id:-$pane}" 2>/dev/null || true
if [ -t 1 ]; then echo "killed ${id:-$pane}"; fi
exit 0
