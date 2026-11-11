#!/usr/bin/env bash
# term-reap.sh <pane-id> - pane-died handler, wired via set-hook in ops/tmux/hq.conf
# (fires only where remain-on-exit is on, i.e. the work window). A dead WORKER pane is
# parked so its final summary stays readable via Alt-o until finish.sh tears it down;
# anything else (an exited interactive terminal) just disappears: deregister the
# session, kill the corpse, re-tile. Either way no "Pane is dead" is left on screen.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
SES="${HQ_TMUX_SESSION:-hq}"

pane="${1:-}"
[ -n "$pane" ] || exit 0
[ "$(tmux display-message -p -t "$pane" '#{pane_dead}' 2>/dev/null)" = 1 ] || exit 0
# the pane-died hook is server-wide: act only on OUR session's work window, never on
# some other session's pane that happens to share a window name (lucy round 2)
info="$(tmux display-message -p -t "$pane" '#{session_name} #{window_name}' 2>/dev/null)"
[ "$info" = "$SES work" ] || exit 0   # foreign sessions, service windows, parked corpses manage themselves

# who was this? (registry rows store the pane id in tmux_window). A registry that
# cannot be read prints ERR: that must never route to the destructive kill path,
# because a real worker could be misread as unknown (lucy round 1, MAJOR 3).
row="$(PANE="$pane" "$REGSH" list --json 2>/dev/null | PANE="$pane" python3 -c '
import json,sys,os
p=os.environ["PANE"]
try: rows=json.load(sys.stdin)
except Exception: print("ERR ERR"); raise SystemExit
for r in rows:
    if r.get("tmux_window")==p: print(r.get("id",""), r.get("kind","")); break' 2>/dev/null)" || row="ERR ERR"
id="${row%% *}"; kind="${row#* }"; [ "$kind" = "$row" ] && kind=""
[ "$id" = ERR ] && { id=""; kind=ERR; }

if [ "$kind" = worker ]; then
  # A finished worker disappears at once (the owner 2026-10-27: parking piled up 107
  # corpses). Its summary is on the bead, so nothing is lost. The row becomes
  # finishable so the session stays listed as awaiting review and finish.sh, and
  # reconcile (which prunes only active rows) leaves it alone.
  "$REGSH" update "$id" --status finishable >/dev/null 2>&1 || true
  tmux kill-pane -t "$pane" >/dev/null 2>&1 || true
  "$SCRIPT_DIR/term-retile.sh" "$SES:work" >/dev/null 2>&1 || true
  tmux display-message "worker $id exited; summary on its bead, output in state/logs/$id.log" 2>/dev/null || true
elif [ "$kind" = ERR ]; then
  # never claim parked on a failed park (e.g. parked window out of space): the dead
  # pane stays visible in work as an honest failure, not a silent loss (lucy round 2)
  if bash "$SCRIPT_DIR/term-park.sh" "$pane" >/dev/null 2>&1; then
    tmux display-message "registry unreadable; parked dead pane $pane instead of killing it" 2>/dev/null || true
  else
    tmux display-message "term-reap: could not park dead pane ${id:-$pane}; leaving it in work" 2>/dev/null || true
  fi
else
  [ -n "$id" ] && { "$REGSH" deregister "$id" >/dev/null 2>&1 || true; }
  tmux kill-pane -t "$pane" >/dev/null 2>&1 || true
  "$SCRIPT_DIR/term-retile.sh" "$SES:work" >/dev/null 2>&1 || true
fi
exit 0
