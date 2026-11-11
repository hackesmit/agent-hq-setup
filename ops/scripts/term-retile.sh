#!/usr/bin/env bash
# term-retile.sh [window] — smart layout for the work window:
#   1 pane  = full
#   2 panes = side-by-side (even-horizontal, a vertical divider)   <- what you want for 2
#   3 panes = two on top + one wide on the bottom (tiled)
#   4+      = grid (tiled)
# Bound to Alt-f; also called by term.sh / term-kill.sh after create/kill.
set -uo pipefail
win="${1:-hq:work}"
# serialize concurrent retiles: without this, two term.sh could each read the pane count
# and apply a layout out of order (e.g. even-horizontal onto 3 panes). flock makes the
# count+layout atomic per window; fail-open if flock is unavailable.
exec 9>"/tmp/hq-retile-$(printf '%s' "$win" | tr -c 'A-Za-z0-9' '_').lock"
flock 9 2>/dev/null || true
n="$(tmux list-panes -t "$win" 2>/dev/null | wc -l)"
if [ "$n" = 2 ]; then
  tmux select-layout -t "$win" even-horizontal >/dev/null 2>&1 || true
else
  tmux select-layout -t "$win" tiled >/dev/null 2>&1 || true
fi
