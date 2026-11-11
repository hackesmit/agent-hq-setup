#!/usr/bin/env bash
# stall-watch.test.sh: synthetic panes on a private tmux server (hq-fgg3.4).
# A stalled hq:work worker and busy-but-quiet hqt-* terminals (one with a window
# name that has spaces) must be flagged; idle, moving and non-hq panes must not.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SW="${STALL_WATCH:-$ROOT/tools/hq-watch/stall-watch.sh}"
SCR="$(mktemp -d)"
SOCK="stalltest-$$"
T=(tmux -L "$SOCK" -f /dev/null)
# tmux 3.4 leaves the socket file behind after kill-server (hq-1nkg.7), so remove it too
cleanup(){ "${T[@]}" kill-server 2>/dev/null; rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCK"; rm -rf "$SCR"; }
trap cleanup EXIT
FAKE="$SCR/hq"; mkdir -p "$FAKE/ops/scripts" "$SCR/bin"
printf '#!/bin/sh\necho "$@" >> %s/notified\n' "$SCR" > "$FAKE/ops/scripts/notify.sh"
chmod +x "$FAKE/ops/scripts/notify.sh"
cp /bin/bash "$SCR/bin/claude"   # a process whose comm is "claude"
busy_static='echo "static output line"; while :; do printf "\r* Working (%ss - esc to interrupt)   " $SECONDS; sleep 1; done'
idle_static='echo "static output line"; echo "> "; sleep 3600; :'
busy_moving='while :; do echo "line $RANDOM"; echo "* Working ($SECONDS s - esc to interrupt)"; sleep 1; done'
work_static='echo "[Bash] long command"; sleep 3600; :'
"${T[@]}" new-session -d -s hqt-stalled -x 120 -y 30 "$SCR/bin/claude" -c "$busy_static"
"${T[@]}" new-session -d -s hqt-spaced  -x 120 -y 30 "$SCR/bin/claude" -c "$busy_static"
"${T[@]}" rename-window -t hqt-spaced:0 'my task with spaces'
# 25 columns: the busy marker wraps across physical lines (needs capture-pane -J)
"${T[@]}" new-session -d -s hqt-narrow  -x 25 -y 30 "$SCR/bin/claude" -c "$busy_static"
"${T[@]}" new-session -d -s hqt-idle    -x 120 -y 30 "$SCR/bin/claude" -c "$idle_static"
"${T[@]}" new-session -d -s hqt-moving  -x 120 -y 30 "$SCR/bin/claude" -c "$busy_moving"
"${T[@]}" new-session -d -s hq -n work  -x 120 -y 30 "$SCR/bin/claude" -c "$work_static"
"${T[@]}" new-session -d -s other       -x 120 -y 30 "$SCR/bin/claude" -c "$work_static"
sleep 1
export HQ_ROOT="$FAKE" STALL_TMUX_SOCKETS="$SOCK" STALL_S=2
bash "$SW" >/dev/null; sleep 3; bash "$SW" >/dev/null

fail=0
check(){ if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
N="$SCR/notified"; touch "$N"
check "stalled hq:work worker flagged"        'grep -q "work hq pane" "$N"'
check "stalled hqt terminal flagged"          'grep -q "term hqt-stalled " "$N"'
check "spaced window name still flagged"      'grep -q "term hqt-spaced " "$N"'
check "narrow (25 col) hqt terminal flagged"  'grep -q "term hqt-narrow " "$N"'
check "idle hqt terminal not flagged"         '! grep -q "hqt-idle" "$N"'
check "moving hqt terminal not flagged"       '! grep -q "hqt-moving" "$N"'
check "non-hq session not flagged"            '! grep -q " other " "$N"'
check "exactly four pings"                    '[ "$(wc -l < "$N")" -eq 4 ]'
check "heartbeat written"                     '[ -f "$FAKE/state/heartbeat/stall-watch" ]'
[ "$fail" = 0 ] && echo "STALL-WATCH TESTS: PASS" || { echo "STALL-WATCH TESTS: FAIL"; exit 1; }
