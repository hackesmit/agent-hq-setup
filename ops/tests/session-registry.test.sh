#!/usr/bin/env bash
# Fixture tests for session-registry.sh — isolated via HQ_STATE_DIR.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$DIR/../scripts/session-registry.sh"
export HQ_STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$HQ_STATE_DIR"' EXIT
fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
no()  { printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

# register creates an active entry, get reads it back
id=$("$REGSH" register --id s-t1 --kind interactive --rig chesski --window hq:t1)
eq "register echoes id" "$id" "s-t1"
status=$("$REGSH" get s-t1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
eq "new entry is active" "$status" "active"
rig=$("$REGSH" get s-t1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["rig"])')
eq "rig persisted" "$rig" "chesski"

# get on missing id exits 1
"$REGSH" get s-none >/dev/null 2>&1; eq "get missing exits 1" "$?" "1"

# corrupt registry fails loud (exit 3), does NOT silently wipe
printf 'not json{' > "$HQ_STATE_DIR/sessions.json"
"$REGSH" get s-anything >/dev/null 2>&1; eq "corrupt registry exits 3" "$?" "3"
printf '%s' '{}' > "$HQ_STATE_DIR/sessions.json"  # reset for any later cases

# update mutates status + wake_at
"$REGSH" register --id s-t2 --window hq:t2 >/dev/null
"$REGSH" update s-t2 --status snoozed --wake-at 1799999999 >/dev/null
st=$("$REGSH" get s-t2 | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
wa=$("$REGSH" get s-t2 | python3 -c 'import json,sys; print(json.load(sys.stdin)["wake_at"])')
eq "update sets status" "$st" "snoozed"
eq "update sets wake_at" "$wa" "1799999999"
# update missing exits 1
"$REGSH" update s-none --status done >/dev/null 2>&1; eq "update missing exits 1" "$?" "1"
# deregister removes
"$REGSH" deregister s-t2 >/dev/null
"$REGSH" get s-t2 >/dev/null 2>&1; eq "deregister removes entry" "$?" "1"

# list --status filters; --json returns an array
"$REGSH" register --id s-a --window hq:a >/dev/null
"$REGSH" register --id s-b --window hq:b >/dev/null
"$REGSH" update s-b --status snoozed >/dev/null
n_active=$("$REGSH" list --status active --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
eq "list --status active count" "$n_active" "1"
has_b=$("$REGSH" list --status snoozed --json | python3 -c 'import json,sys; print(any(e["id"]=="s-b" for e in json.load(sys.stdin)))')
eq "snoozed list has s-b" "$has_b" "True"

# reconcile marks active entries with a dead window as done (test seam: HQ_TMUX_WINDOWS)
"$REGSH" register --id s-live --window hq:live >/dev/null
"$REGSH" register --id s-dead --window hq:dead >/dev/null
HQ_TMUX_WINDOWS="hq:live" "$REGSH" reconcile >/dev/null
sl=$("$REGSH" get s-live | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
sd=$("$REGSH" get s-dead | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
eq "reconcile keeps live active" "$sl" "active"
eq "reconcile marks dead done" "$sd" "done"

# fail-safe: when tmux errors (non-zero exit), reconcile must NOT prune (live unknown)
FAKEBIN="$(mktemp -d)"; printf '#!/bin/sh\nexit 1\n' > "$FAKEBIN/tmux"; chmod +x "$FAKEBIN/tmux"
"$REGSH" register --id s-failsafe --window hq:fs >/dev/null
( unset HQ_TMUX_WINDOWS; PATH="$FAKEBIN:$PATH" "$REGSH" reconcile >/dev/null )
fs=$("$REGSH" get s-failsafe | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
eq "tmux-error fail-safe keeps active" "$fs" "active"
rm -rf "$FAKEBIN"

# the hook is fail-open for any session
HOOKSH="$DIR/../scripts/hook-session-register.sh"
CLAUDE_SESSION_ID="s-hook" bash "$HOOKSH" </dev/null; eq "hook exits 0" "$?" "0"
# the hook registers NOTHING: spawn.sh owns worker registration (no registry pollution)
"$REGSH" get s-hook >/dev/null 2>&1; eq "hook does not register the session" "$?" "1"
# the overseer branch and its HQ_FORCE_OVERSEER seam were removed 2026-08-20 (hq-qph1):
# forcing the old seam must still register nothing
HQ_FORCE_OVERSEER=1 CLAUDE_SESSION_ID="s-ovsr" bash "$HOOKSH" </dev/null
"$REGSH" get s-ovsr >/dev/null 2>&1; eq "retired overseer seam registers nothing" "$?" "1"

# reconcile still runs for any session: a pre-existing active entry with a dead window
# gets pruned to done when the hook runs (seam: HQ_TMUX_WINDOWS lists only live windows)
"$REGSH" register --id s-stale --window hq:gone >/dev/null
HQ_TMUX_WINDOWS="hq:hooklive" CLAUDE_SESSION_ID="s-hooklive" bash "$HOOKSH" </dev/null
stale=$("$REGSH" get s-stale | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
eq "hook reconcile prunes dead entry" "$stale" "done"

# deferred item (2026-07-14): update --objectives sets the objectives_file path (S5 compact)
"$REGSH" register --id s-obj --window hq:obj >/dev/null
"$REGSH" update s-obj --objectives state/objectives/s-obj.md >/dev/null
of=$("$REGSH" get s-obj | python3 -c 'import json,sys; print(json.load(sys.stdin)["objectives_file"])')
eq "update sets objectives_file" "$of" "state/objectives/s-obj.md"

# side-by-side panes: update --window records a new pane id (wake uses this); reconcile
# treats pane-id targets (%N) exactly like window targets against the live set (seam)
"$REGSH" update s-obj --window '%9' >/dev/null
win=$("$REGSH" get s-obj | python3 -c 'import json,sys; print(json.load(sys.stdin)["tmux_window"])')
eq "update sets tmux_window (pane id)" "$win" "%9"
"$REGSH" register --id s-pane --window '%42' >/dev/null
HQ_TMUX_WINDOWS='%42 hq:overseer' "$REGSH" reconcile >/dev/null
eq "reconcile keeps live pane" "$("$REGSH" get s-pane | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" "active"
"$REGSH" register --id s-pane2 --window '%43' >/dev/null
HQ_TMUX_WINDOWS='%42 hq:overseer' "$REGSH" reconcile >/dev/null
eq "reconcile prunes dead pane" "$("$REGSH" get s-pane2 | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" "done"

# hq-4npjr.25: reconcile holds the registry lock from load through save, so a
# register that lands while reconcile waits on tmux (or git) is not lost on save.
# Fake tmux: has-session sleeps 3 s, then the hq session lists only hq:x.
FAKEBIN="$(mktemp -d)"
cat > "$FAKEBIN/tmux" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *" has-session "*) sleep 3; exit 0 ;;
  *" list-windows "*) echo "hq:x"; exit 0 ;;
  *" list-panes "*) exit 0 ;;
esac
exit 1
SH
chmod +x "$FAKEBIN/tmux"
printf '%s' '{}' > "$HQ_STATE_DIR/sessions.json"
( PATH="$FAKEBIN:$PATH" HQ_TMUX_SERVERS=default "$REGSH" reconcile >/dev/null 2>&1 ) &
rpid=$!
sleep 1
"$REGSH" register --id s-new --window hq:x >/dev/null
wait "$rpid"
"$REGSH" get s-new >/dev/null 2>&1; eq "register during reconcile survives the save" "$?" "0"

# a held lock times out (never hangs SessionStart) and the write does not happen
python3 - "$HQ_STATE_DIR/sessions.json.lock" <<'PY' &
import fcntl, sys, time
fh = open(sys.argv[1], "a"); fcntl.flock(fh, fcntl.LOCK_EX); time.sleep(4)
PY
hpid=$!
sleep 0.5
t0=$(date +%s)
HQ_REGISTRY_LOCK_TIMEOUT=1 "$REGSH" register --id s-blocked --window hq:b >/dev/null 2>&1
rc=$?; dt=$(( $(date +%s) - t0 ))
wait "$hpid"
eq "held lock: register exits 4" "$rc" "4"
[ "$dt" -le 2 ] && ok "held lock: times out within the limit" || no "held lock: times out within the limit" "took ${dt}s"
"$REGSH" get s-blocked >/dev/null 2>&1; eq "held lock: no write" "$?" "1"
# reads do not take the lock: get and list work while it is held
python3 - "$HQ_STATE_DIR/sessions.json.lock" <<'PY' &
import fcntl, sys, time
fh = open(sys.argv[1], "a"); fcntl.flock(fh, fcntl.LOCK_EX); time.sleep(3)
PY
hpid=$!
sleep 0.5
HQ_REGISTRY_LOCK_TIMEOUT=1 "$REGSH" get s-new >/dev/null 2>&1; eq "held lock: get still reads" "$?" "0"
wait "$hpid"
rm -rf "$FAKEBIN"

[ "$fail" = 0 ] && echo "REGISTRY TESTS: PASS" || { echo "REGISTRY TESTS: FAIL"; exit 1; }
