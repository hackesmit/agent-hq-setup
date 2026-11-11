#!/usr/bin/env bash
# term-park.sh [pane-id] - minimize a terminal instead of killing it: the pane moves to
# the hidden 'parked' window (its process keeps running) and the work window re-tiles.
# Reopen it with term-unpark.sh (Alt-o menu). Bound to Alt-h; term-reap.sh also parks
# finished worker panes here so their output stays readable without cluttering work.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SES="${HQ_TMUX_SESSION:-hq}"

pane="${1:-$(tmux display-message -p '#{pane_id}' 2>/dev/null)}"
[ -n "$pane" ] || { echo "term-park: no pane target" >&2; exit 1; }
info="$(tmux display-message -p -t "$pane" '#{session_name} #{window_name}' 2>/dev/null)"
[ -n "$info" ] || { echo "term-park: no such pane: $pane" >&2; exit 1; }
ses_of="${info%% *}"; win="${info#* }"
[ "$ses_of" = "$SES" ] && [ "$win" = parked ] && exit 0
# only OUR session's work terminals park: a foreign session's pane, or a sole service
# pane (monitor, sync, console), moving to parked would dismantle its window while the
# process hides (lucy rounds 1 and 2)
if [ "$ses_of" != "$SES" ] || [ "$win" != work ]; then
  tmux display-message "term-park: only $SES work terminals park (this pane is $ses_of:$win)" 2>/dev/null || true
  echo "term-park: refusing to park a '$ses_of:$win' pane" >&2
  exit 1
fi
title="$(tmux display-message -p -t "$pane" '#{pane_title}' 2>/dev/null)"

# serialize the check-then-create below: two concurrent parks (e.g. two workers dying
# together) could otherwise each see no parked window and break-pane a duplicate,
# making 'SES:parked' ambiguous forever after (lucy round 2). Fail-open like retile.
exec 9>"/tmp/hq-park-$(printf '%s' "$SES" | tr -c 'A-Za-z0-9' '_').lock"
flock 9 2>/dev/null || true

if tmux list-windows -t "$SES" -F '#W' 2>/dev/null | grep -qx parked; then
  tmux join-pane -d -s "$pane" -t "$SES:parked" 2>/dev/null || { echo "term-park: join failed" >&2; exit 1; }
  tmux select-layout -t "$SES:parked" tiled >/dev/null 2>&1 || true
else
  tmux break-pane -d -s "$pane" -t "$SES:" -n parked 2>/dev/null || { echo "term-park: break failed" >&2; exit 1; }
fi
"$SCRIPT_DIR/term-retile.sh" "$SES:work" >/dev/null 2>&1 || true
tmux display-message "parked: ${title:-$pane} (Alt-o to reopen)" 2>/dev/null || true
exit 0
