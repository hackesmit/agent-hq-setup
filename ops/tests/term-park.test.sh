#!/usr/bin/env bash
# Fixture tests for term-park / term-unpark / term-reap / silent term-kill.
# Runs a throwaway tmux server on its own socket (session named 'hq' there, so the
# scripts' defaults apply); never touches the real hq server.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PARK(){ bash "$DIR/../scripts/term-park.sh" "$@"; }
UNPARK(){ bash "$DIR/../scripts/term-unpark.sh" "$@"; }
REAP(){ bash "$DIR/../scripts/term-reap.sh" "$@"; }
KILL(){ bash "$DIR/../scripts/term-kill.sh" "$@"; }
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

command -v tmux >/dev/null 2>&1 || { echo "TERM-PARK TESTS: SKIP (no tmux)"; exit 0; }

export HQ_ROOT="$(mktemp -d)"; export HQ_STATE_DIR="$HQ_ROOT/state"
sock="$HQ_ROOT/tmux.sock"
tm(){ env -u TMUX tmux -S "$sock" "$@"; }
cleanup(){ tm kill-server >/dev/null 2>&1; rm -rf "$HQ_ROOT"; }
trap cleanup EXIT

tm new-session -d -s hq -n work 'sleep 300' || { echo "TERM-PARK TESTS: SKIP (tmux server failed)"; exit 0; }
tm set -w -t hq:work remain-on-exit on
# scripts under test call bare `tmux`; point them at the test socket
export TMUX="$sock,0,0"

p1="$(tm list-panes -t hq:work -F '#{pane_id}')"
p2="$(tm split-window -t hq:work -PF '#{pane_id}' 'sleep 300')"

# park p2: it leaves work, lands in parked, keeps running
PARK "$p2" >/dev/null 2>&1
tm list-windows -t hq -F '#W' | grep -qx parked && ok "parked window created" || no "parked window created"
eq "work has 1 pane after park" "$(tm list-panes -t hq:work | wc -l)" "1"
eq "p2 lives in parked" "$(tm display-message -p -t "$p2" '#{window_name}')" "parked"
eq "p2 still alive" "$(tm display-message -p -t "$p2" '#{pane_dead}')" "0"

# parking a parked pane is a no-op
PARK "$p2" >/dev/null 2>&1 && ok "re-park is a no-op" || no "re-park is a no-op"

# unpark p2: back into work, parked window auto-closes when empty
UNPARK "$p2" >/dev/null 2>&1
eq "p2 back in work" "$(tm display-message -p -t "$p2" '#{window_name}')" "work"
eq "work has 2 panes after unpark" "$(tm list-panes -t hq:work | wc -l)" "2"
tm list-windows -t hq -F '#W' | grep -qx parked && no "empty parked window closed" || ok "empty parked window closed"

# reap an exited INTERACTIVE terminal: pane disappears, registry row deregistered
p3="$(tm split-window -t hq:work -PF '#{pane_id}' 'true')"
"$REGSH" register --id t-aaaa --kind terminal --rig "" --worktree "" --branch "" --window "$p3" --model m >/dev/null
sleep 1
eq "p3 is dead" "$(tm display-message -p -t "$p3" '#{pane_dead}')" "1"
REAP "$p3" >/dev/null 2>&1
tm list-panes -t hq:work -F '#{pane_id}' | grep -qx "$p3" && no "dead terminal pane removed" || ok "dead terminal pane removed"
"$REGSH" get t-aaaa >/dev/null 2>&1 && no "dead terminal deregistered" || ok "dead terminal deregistered"

# reap an exited WORKER: pane is killed at once, row kept as finishable (2026-10-27)
p4="$(tm split-window -t hq:work -PF '#{pane_id}' 'true')"
tm select-pane -t "$p4" -T "t-bbbb myrig xd-1"
"$REGSH" register --id t-bbbb --kind worker --rig myrig --worktree "" --branch "" --window "$p4" --model m >/dev/null
sleep 1
REAP "$p4" >/dev/null 2>&1
tm list-panes -a -F '#{pane_id}' | grep -qx "$p4" && no "dead worker pane removed" || ok "dead worker pane removed"
eq "dead worker row is finishable" "$("$REGSH" get t-bbbb | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" "finishable"

# reap ignores live panes and non-work windows
REAP "$p1" >/dev/null 2>&1
tm list-panes -t hq:work -F '#{pane_id}' | grep -qx "$p1" && ok "reap leaves live panes alone" || no "reap leaves live panes alone"
REAP "$p4" >/dev/null 2>&1
ok "reap of a pane that no longer exists is a no-op"

# park refuses panes outside the work window (service windows stay intact)
tm new-window -t hq -n monitor 'sleep 300'
pm="$(tm list-panes -t hq:monitor -F '#{pane_id}')"
PARK "$pm" >/dev/null 2>&1 && no "park refuses service pane" "exit 0" || ok "park refuses service pane"
eq "service pane untouched" "$(tm display-message -p -t "$pm" '#{window_name}')" "monitor"

# reap with an unreadable registry parks instead of killing (fail-safe, never destroys)
p6="$(tm split-window -t hq:work -PF '#{pane_id}' 'true')"
sleep 1
cp "$HQ_STATE_DIR/sessions.json" "$HQ_STATE_DIR/sessions.json.bak"
echo "{corrupt" > "$HQ_STATE_DIR/sessions.json"
REAP "$p6" >/dev/null 2>&1
eq "corrupt registry: dead pane parked not killed" "$(tm display-message -p -t "$p6" '#{window_name}')" "parked"
mv "$HQ_STATE_DIR/sessions.json.bak" "$HQ_STATE_DIR/sessions.json"

# reap never touches another session's pane, even in a window also named 'work'
tm new-session -d -s other -n work 'sleep 300'
tm set -w -t other:work remain-on-exit on
po="$(tm split-window -t other:work -PF '#{pane_id}' 'true')"
sleep 1
REAP "$po" >/dev/null 2>&1
tm list-panes -t other:work -F '#{pane_id}' | grep -qx "$po" && ok "reap ignores foreign session" || no "reap ignores foreign session"
PARK "$po" >/dev/null 2>&1 && no "park refuses foreign session" "exit 0" || ok "park refuses foreign session"
tm kill-session -t other

# concurrent parks create exactly one parked window (no duplicate-name ambiguity)
pa="$(tm split-window -t hq:work -PF '#{pane_id}' 'sleep 300')"
pb="$(tm split-window -t hq:work -PF '#{pane_id}' 'sleep 300')"
PARK "$pa" >/dev/null 2>&1 & PARK "$pb" >/dev/null 2>&1 & wait
eq "concurrent parks: one parked window" "$(tm list-windows -t hq -F '#W' | grep -cx parked)" "1"
eq "concurrent parks: pane A parked" "$(tm display-message -p -t "$pa" '#{window_name}')" "parked"
eq "concurrent parks: pane B parked" "$(tm display-message -p -t "$pb" '#{window_name}')" "parked"
tm kill-pane -t "$pa"; tm kill-pane -t "$pb"

# term-kill: silent on stdout when non-interactive (no sticky run-shell view), pane gone
p5="$(tm split-window -t hq:work -PF '#{pane_id}' 'sleep 300')"
out="$(KILL "$p5" 2>&1)"
eq "term-kill silent under run-shell" "$out" ""
tm list-panes -t hq:work -F '#{pane_id}' | grep -qx "$p5" && no "term-kill removes pane" || ok "term-kill removes pane"

[ "$fail" = 0 ] && echo "TERM-PARK TESTS: PASS" || { echo "TERM-PARK TESTS: FAIL"; exit 1; }
