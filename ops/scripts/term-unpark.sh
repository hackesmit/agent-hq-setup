#!/usr/bin/env bash
# term-unpark.sh [pane-id] - reopen a parked (minimized) terminal into the work window.
# With no args, pops a menu of parked panes to pick from (bound to Alt-o); with a pane
# id, restores that pane directly. Counterpart of term-park.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SES="${HQ_TMUX_SESSION:-hq}"
TAB="$(printf '\t')"

pane="${1:-}"
if [ -z "$pane" ]; then
  if ! tmux list-windows -t "$SES" -F '#W' 2>/dev/null | grep -qx parked; then
    tmux display-message "no parked terminals" 2>/dev/null || echo "term-unpark: no parked terminals"
    exit 0
  fi
  items=(); i=1
  while IFS="$TAB" read -r id t dead; do
    label="${t:-$id}"; [ "$dead" = 1 ] && label="$label [dead]"
    key=""; [ "$i" -le 9 ] && key="$i"
    items+=("$label" "$key" "run-shell \"$SCRIPT_DIR/term-unpark.sh $id\"")
    i=$((i+1))
  done < <(tmux list-panes -t "$SES:parked" -F "#{pane_id}${TAB}#{pane_title}${TAB}#{pane_dead}" 2>/dev/null)
  if [ "${#items[@]}" = 0 ]; then
    tmux display-message "no parked terminals" 2>/dev/null || echo "term-unpark: no parked terminals"
    exit 0
  fi
  tmux display-menu -T " parked terminals " "${items[@]}" 2>/dev/null || true
  exit 0
fi

if tmux list-windows -t "$SES" -F '#W' 2>/dev/null | grep -qx work; then
  tmux join-pane -d -s "$pane" -t "$SES:work" 2>/dev/null || { echo "term-unpark: join failed" >&2; exit 1; }
else
  tmux break-pane -d -s "$pane" -t "$SES:" -n work 2>/dev/null || { echo "term-unpark: restore failed" >&2; exit 1; }
fi
"$SCRIPT_DIR/term-retile.sh" "$SES:work" >/dev/null 2>&1 || true
tmux select-window -t "$SES:work" >/dev/null 2>&1 || true
tmux select-pane -t "$pane" >/dev/null 2>&1 || true
tmux select-layout -t "$SES:parked" tiled >/dev/null 2>&1 || true
exit 0
