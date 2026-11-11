#!/usr/bin/env bash
# tmux-target.test.sh: wake, finish, snooze, panic and hq.sh find the session named exactly
# hq on the right tmux server (shared lib ops/scripts/lib/tmux-server.sh) and never touch a
# decoy session named hq-errors (hq-1nkg.1, stale-sweep 2026-10-20 item 2).
#
# Isolation: every tmux server here lives under a private TMUX_TMPDIR, $TMUX is unset, and
# HQ_TMUX_SERVERS names two unique scratch sockets that stand in for "default" and "hqterm".
# The live servers (default, hqterm, the hq session) are never addressed. All scratch servers
# are killed on exit. panic.sh runs from a copy with a stub notify.sh and a stub pkill;
# hq.sh runs with a fake $HOME whose ~/hq holds stub service scripts.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
S="$(cd "$DIR/../scripts" && pwd)"
REGSH="$S/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

command -v tmux >/dev/null || { echo "SKIP  tmux not installed"; exit 0; }

# short base dir: a unix socket path must stay under ~108 bytes
T="$(mktemp -d /tmp/tt.XXXXXX)"
export TMUX_TMPDIR="$T/sock"; mkdir -p "$TMUX_TMPDIR"
unset TMUX TMUX_PANE
DEF="ttdef$$"; ALT="ttalt$$"          # stand-ins for the default and the hqterm servers
export HQ_TMUX_SERVERS="$DEF $ALT"
SOCKDIR="$TMUX_TMPDIR/tmux-$(id -u)"
cleanup(){
  local s
  for s in "$DEF" "$ALT" default; do tmux -L "$s" kill-server >/dev/null 2>&1; done
  rm -rf "$T"
}
trap cleanup EXIT

# fake binaries: claude never starts for real, pkill only logs
FAKE="$T/bin"; mkdir -p "$FAKE"
printf '#!/bin/sh\nexec sleep 3600\n' > "$FAKE/claude"
printf '#!/bin/sh\necho "pkill $*" >> "%s/pkill.log"\nexit 0\n' "$T" > "$FAKE/pkill"
printf '#!/bin/sh\nexit 0\n' > "$FAKE/bd"
chmod +x "$FAKE"/*
export PATH="$FAKE:$PATH" HQ_BD="$FAKE/bd" HQ_NO_SCHEDULE=1 HQ_SCHTASKS=/bin/false
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

tx(){ local s="$1"; shift; tmux -L "$s" -f /dev/null "$@"; }
reset_servers(){ tx "$DEF" kill-server >/dev/null 2>&1; tx "$ALT" kill-server >/dev/null 2>&1
  tmux -L default kill-server >/dev/null 2>&1; true; }
# decoy: hq-errors with two panes (%0 and %1) on $DEF, like the live default server
mk_decoy(){ tx "$DEF" new-session -d -s hq-errors -n errs 'sleep 3600'
  tx "$DEF" split-window -t '=hq-errors:errs' 'sleep 3600'; }
mk_hq(){ tx "$1" new-session -d -s hq -n monitor 'sleep 3600'; }
has_pane(){ tx "$1" list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF -- "$2"; }
decoy_sig(){ tx "$DEF" list-panes -s -t '=hq-errors' -F '#{window_name}#{pane_id}' 2>/dev/null | sort | tr '\n' ' '; }
DECOY_WANT="errs%0 errs%1 "

# safety: the scratch sockets really are under the private dir before anything else runs
mk_decoy
[ -S "$SOCKDIR/$DEF" ] || { echo "FAIL  scratch socket not under $SOCKDIR, aborting"; exit 1; }
eq "decoy has two panes" "$(decoy_sig)" "$DECOY_WANT"
# the hazard this bead fixes: a bare -t hq prefix-matches the decoy
eq "hazard: bare -t hq resolves to hq-errors" "$(tx "$DEF" display-message -p -t hq '#S' 2>/dev/null)" "hq-errors"

# --- lib: hq_tmux_server ---
. "$S/lib/tmux-server.sh"
( hq_tmux_server ) && no "lib: no hq anywhere returns 1" || ok "lib: no hq anywhere returns 1 (decoy ignored)"
mk_hq "$ALT"
got="$( hq_tmux_server && printf '%s' "${TMUX%%,*}" )"
eq "lib: finds hq on the hqterm stand-in" "$got" "$SOCKDIR/$ALT"
got="$( hq_tmux_server && tmux display-message -p -t '=hq:' '#S' )"
eq "lib: =hq on that server is hq" "$got" "hq"

# --- fixture HQ root with a worker row ---
export HQ_ROOT="$T/hq"; export HQ_STATE_DIR="$HQ_ROOT/state"
mkrig(){ mkdir -p "$HQ_ROOT/rigs/$1"; git -C "$HQ_ROOT/rigs/$1" init -q
  printf base > "$HQ_ROOT/rigs/$1/f"; git -C "$HQ_ROOT/rigs/$1" add -A
  git -C "$HQ_ROOT/rigs/$1" commit -qm base; }
getw(){ "$REGSH" get "$1" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tmux_window",""))' 2>/dev/null; }
mkrig r1
id="$("$S/spawn.sh" r1 "wake target" --worker --dry-run | tail -1)"

# --- wake.sh: revives into hq on the hqterm stand-in, never into the decoy ---
"$REGSH" update "$id" --status snoozed --wake-at "$(( $(date +%s) + 3600 ))" >/dev/null  # wake.sh only revives snoozed rows (hq-1nkg.14)
"$S/wake.sh" "$id" >/dev/null 2>&1
win="$(getw "$id")"
case "$win" in %*) ok "wake: registry holds a pane id ($win)";; *) no "wake: registry holds a pane id" "$win";; esac
eq "wake: pane is in hq:work on the hqterm stand-in" \
   "$(tx "$ALT" display-message -p -t "$win" '#S:#W' 2>/dev/null)" "hq:work"
eq "wake: decoy untouched" "$(decoy_sig)" "$DECOY_WANT"
eq "wake: no work window on the decoy server" \
   "$(tx "$DEF" list-windows -a -F '#S:#W' | grep -c ':work$')" "0"

# --- snooze.sh: kills that pane on the hqterm stand-in; the decoy's same-numbered pane lives ---
"$S/snooze.sh" "for 2 hours" --id "$id" >/dev/null 2>&1
has_pane "$ALT" "$win" && no "snooze: hq pane $win killed" || ok "snooze: hq pane $win killed"
eq "snooze: decoy untouched" "$(decoy_sig)" "$DECOY_WANT"

# --- finish.sh: same kill path after a real merge + close ---
mkrig r2
id2="$("$S/spawn.sh" r2 "finish target" --worker --dry-run | tail -1)"
wt2="$HQ_ROOT/rigs/r2-${id2#s-}"
p2="$(tx "$ALT" new-window -t '=hq:' -n work -PF '#{pane_id}' 'sleep 3600')"   # snooze emptied work
tx "$ALT" split-window -t '=hq:work' 'sleep 3600'   # a survivor, so the window outlives the kill
"$REGSH" update "$id2" --window "$p2" >/dev/null
printf changed > "$wt2/newfile"
printf '#!/bin/sh\ncase "$1" in show) echo "Verification: code - test - PASS";; esac\nexit 0\n' > "$FAKE/bd"
"$S/finish.sh" "$id2" --confirm >/dev/null 2>&1
"$REGSH" get "$id2" >/dev/null 2>&1 && no "finish: merged and deregistered" "row still there" || ok "finish: merged and deregistered"
has_pane "$ALT" "$p2" && no "finish: hq pane $p2 killed" || ok "finish: hq pane $p2 killed"
eq "finish: decoy untouched" "$(decoy_sig)" "$DECOY_WANT"

# --- lib: a stale pane id that now belongs to another session is left alone ---
reset_servers; mk_decoy; mk_hq "$DEF"   # hq and the decoy on the same server
hq_kill_registry_window "%0"            # %0 is hq-errors here, not hq
eq "lib: pane of another session not killed" "$(decoy_sig)" "$DECOY_WANT"
hq_kill_registry_window "hq:monitor"
tx "$DEF" has-session -t '=hq' 2>/dev/null && no "lib: hq:monitor window killed" || ok "lib: hq:monitor window killed (=hq exact)"
eq "lib: decoy survives the window kill" "$(decoy_sig)" "$DECOY_WANT"
unset TMUX

# --- wake.sh with no hq anywhere: the decoy gets no work window ---
reset_servers; mk_decoy
"$REGSH" update "$id" --status snoozed >/dev/null 2>&1
"$S/wake.sh" "$id" >/dev/null 2>&1
eq "wake (no hq): decoy untouched" "$(decoy_sig)" "$DECOY_WANT"
eq "wake (no hq): no new window on the decoy server" "$(tx "$DEF" list-windows -a | wc -l | tr -d ' ')" "1"

# --- panic.sh: kills =hq on every candidate server, never the decoy ---
reset_servers; mk_decoy; mk_hq "$ALT"; mk_hq "$DEF"
P="$T/panic"; mkdir -p "$P/lib"
cp "$S/panic.sh" "$P/panic.sh"; cp "$S/lib/tmux-server.sh" "$P/lib/"
printf '#!/bin/sh\nexit 0\n' > "$P/notify.sh"; chmod +x "$P/notify.sh" "$P/panic.sh"
cmp -s "$S/panic.sh" "$P/panic.sh" && ok "panic: copy is byte-identical" || no "panic: copy is byte-identical"
"$P/panic.sh" >/dev/null 2>&1
tx "$ALT" has-session -t '=hq' 2>/dev/null && no "panic: hq on hqterm stand-in stopped" || ok "panic: hq on hqterm stand-in stopped"
tx "$DEF" has-session -t '=hq' 2>/dev/null && no "panic: hq on default stand-in stopped" || ok "panic: hq on default stand-in stopped"
eq "panic: decoy untouched" "$(decoy_sig)" "$DECOY_WANT"
grep -q 'pkill -f claude' "$T/pkill.log" 2>/dev/null && ok "panic: still runs pkill -f claude (stubbed)" || no "panic: pkill" "$(cat "$T/pkill.log" 2>/dev/null)"

# --- hq.sh: fake $HOME, stub service scripts ---
H="$T/home"; mkdir -p "$H/hq/ops/scripts" "$H/hq/ops/tmux"; : > "$H/hq/ops/tmux/hq.conf"
for f in monitor.sh git-sync.sh; do printf '#!/bin/sh\nexec sleep 3600\n' > "$H/hq/ops/scripts/$f"; done
for f in canaries.sh notify.sh term.sh; do printf '#!/bin/sh\nexit 0\n' > "$H/hq/ops/scripts/$f"; done
mkdir -p "$H/hq/tools/hq-watch"
for f in stall-watch.sh cpu-watch.sh; do printf '#!/bin/sh\nexec sleep 3600\n' > "$H/hq/tools/hq-watch/$f"; done
chmod +x "$H/hq/ops/scripts/"* "$H/hq/tools/hq-watch/"*
# hq already on the hqterm stand-in: lands there (no tty, so prints) and builds nothing
reset_servers; mk_decoy; mk_hq "$ALT"
out="$(HOME="$H" bash "$S/hq.sh" </dev/null 2>&1)"
echo "$out" | grep -q "hq session ready.*$SOCKDIR/$ALT" && ok "hq.sh: lands on hq on the hqterm stand-in" || no "hq.sh: lands on hqterm stand-in" "$out"
tmux -L default has-session 2>/dev/null && no "hq.sh: no second hq built" || ok "hq.sh: no second hq built"
eq "hq.sh (hq exists): decoy untouched" "$(decoy_sig)" "$DECOY_WANT"
# only the decoy exists: hq.sh builds a real hq (old code prefix-matched hq-errors and quit)
reset_servers; mk_decoy
out="$(HOME="$H" bash "$S/hq.sh" </dev/null 2>&1)"
eq "hq.sh (decoy only): builds =hq" "$(tmux -L default display-message -p -t '=hq:' '#S' 2>/dev/null)" "hq"
eq "hq.sh (decoy only): service windows on =hq" \
   "$(tmux -L default list-windows -t '=hq' -F '#W' 2>/dev/null | sort | tr '\n' ' ')" "cpu-watch monitor sync watch "
eq "hq.sh (decoy only): decoy untouched" "$(decoy_sig)" "$DECOY_WANT"
eq "hq.sh (decoy only): decoy server gained no window" "$(tx "$DEF" list-windows -a | wc -l | tr -d ' ')" "1"

# --- static: no bare hq target left in the owned scripts ---
bare="$(grep -nE "tmux .*-t +['\"]?hq([: '\"]|$)" "$S/wake.sh" "$S/finish.sh" "$S/snooze.sh" "$S/panic.sh" "$S/hq.sh" | grep -v '^\S*:[0-9]*: *#')"
[ -z "$bare" ] && ok "static: no bare -t hq in wake/finish/snooze/panic/hq.sh" || no "static: bare -t hq" "$bare"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
