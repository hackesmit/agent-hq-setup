#!/usr/bin/env bash
# Fixture tests for snooze.sh + wake.sh: temp HQ + fake systemd-run/systemctl/bd, no tmux.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SNOOZE="$DIR/../scripts/snooze.sh"
WAKE="$DIR/../scripts/wake.sh"
SPAWN="$DIR/../scripts/spawn.sh"
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }
getf(){ "$REGSH" get "$1" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[\"$2\"])" 2>/dev/null; }

export HQ_ROOT="$(mktemp -d)"
export HQ_STATE_DIR="$HQ_ROOT/state"
export HQ_NO_TMUX=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
trap 'rm -rf "$HQ_ROOT"' EXIT

FAKE="$HQ_ROOT/fakebin"; mkdir -p "$FAKE"
export RUN_LOG="$HQ_ROOT/run.log" CTL_LOG="$HQ_ROOT/ctl.log"; : > "$RUN_LOG"; : > "$CTL_LOG"
# one call per line, args joined by a single space
cat > "$FAKE/systemd-run" <<'F'
#!/usr/bin/env bash
echo "$*" >> "$RUN_LOG"
exit "${FAKE_RUN_RC:-0}"
F
cat > "$FAKE/systemctl" <<'F'
#!/usr/bin/env bash
echo "$*" >> "$CTL_LOG"
exit "${FAKE_CTL_RC:-0}"
F
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE/bd"
chmod +x "$FAKE/systemd-run" "$FAKE/systemctl" "$FAKE/bd"
export PATH="$FAKE:$PATH" HQ_BD="$FAKE/bd"

mkrig(){ mkdir -p "$HQ_ROOT/rigs/$1"; git -C "$HQ_ROOT/rigs/$1" init -q
  git -C "$HQ_ROOT/rigs/$1" commit --allow-empty -qm base; }
mkrig r1
id="$("$SPAWN" r1 "blocked task" --interactive --dry-run | tail -1)"

# snooze: persists snoozed + future wake_at, schedules a systemd user timer for wake.sh <id>
out="$("$SNOOZE" "for 3 days" --id "$id" --reason "waiting on API key")"
eq "status snoozed" "$(getf "$id" status)" "snoozed"
wa="$(getf "$id" wake_at)"
[ "$wa" -gt "$(date +%s)" ] 2>/dev/null && ok "wake_at is future" || no "wake_at is future" "$wa"
run="$(tail -1 "$RUN_LOG")"
case "$run" in --user\ *) ok "systemd-run --user";; *) no "systemd-run --user" "$run";; esac
case "$run" in *"--unit=hq-wake-$id "*) ok "unit named hq-wake-<id>";; *) no "unit named hq-wake-<id>" "$run";; esac
case "$run" in *"--on-calendar=@$wa "*) ok "on-calendar is @wake_at";; *) no "on-calendar is @wake_at" "$run";; esac
case "$run" in *"ops/scripts/wake.sh $id") ok "timer runs wake.sh <id>";; *) no "timer runs wake.sh <id>" "$run";; esac
case "$run" in *"--setenv=PATH="*) ok "PATH carried into the unit";; *) no "PATH carried into the unit" "$run";; esac
grep -qxF -- "--user stop hq-wake-$id.timer hq-wake-$id.service" "$CTL_LOG" \
  && ok "snooze clears an older timer first" || no "snooze clears an older timer first" "$(head -3 "$CTL_LOG")"
case "$out" in *"schedule: hq-wake-$id.timer @ "*) ok "reports the timer";; *) no "reports the timer" "$out";; esac
grep -qi 'schtasks\|wsl\.exe' "$SNOOZE" "$WAKE" && no "no schtasks/wsl.exe left" || ok "no schtasks/wsl.exe left"

# systemd-run refused: nonzero exit, FAILED reported, window kept (exit precedes the kill), session left active

pre_status="$(getf "$id" status)"
out="$(FAKE_RUN_RC=1 "$SNOOZE" "for 2 days" --id "$id" 2>&1)"; rc=$?
eq "refused schedule exits nonzero" "$rc" "1"
case "$out" in *"FAILED"*) ok "refused schedule reported";; *) no "refused schedule reported" "$out";; esac
eq "refused schedule restores the prior status" "$(getf "$id" status)" "$pre_status"
case "$out" in *"snoozed $id until"*) no "refused schedule prints no success line" "$out";; *) ok "refused schedule prints no success line";; esac

# a bad id (unusable as a unit name) is refused before any registry write
badid="bad id;x"
"$REGSH" register --id "$badid" --window hq:bad >/dev/null 2>&1
"$SNOOZE" "for 1 day" --id "$badid" >/dev/null 2>&1; eq "bad id exits 2" "$?" "2"
eq "bad id leaves registry untouched" "$(getf "$badid" status)" "active"

# unparseable / past <when> exit 2
"$SNOOZE" "not a date at all" --id "$id" >/dev/null 2>&1; eq "unparseable when exits 2" "$?" "2"
"$SNOOZE" "2000-01-01 00:00" --id "$id" >/dev/null 2>&1; eq "past when exits 2" "$?" "2"

# wake: reactivates, clears wake_at, stops the timer (never its own service)
: > "$CTL_LOG"
"$WAKE" "$id" >/dev/null
eq "wake sets active" "$(getf "$id" status)" "active"
eq "wake clears wake_at" "$(getf "$id" wake_at)" "None"
grep -qxF -- "--user stop hq-wake-$id.timer" "$CTL_LOG" && ok "wake unschedules hq-wake-<id>.timer" \
  || no "wake unschedules hq-wake-<id>.timer" "$(head -3 "$CTL_LOG")"
grep -q "hq-wake-$id.service" "$CTL_LOG" && no "wake leaves its own service alone" || ok "wake leaves its own service alone"

# wake is tolerant when the timer is already gone
"$SNOOZE" "for 1 day" --id "$id" >/dev/null
FAKE_CTL_RC=5 "$WAKE" "$id" >/dev/null; rc=$?
eq "wake exits 0 with no timer" "$rc" "0"
eq "wake sets active with no timer" "$(getf "$id" status)" "active"

# --- hq-1nkg.11: after boot, overdue snoozed rows are woken and future ones rescheduled ---
RESUME="$DIR/../scripts/wake-resume.sh"
"$REGSH" register --id s-over --window hq:over >/dev/null
"$REGSH" register --id s-fut --window hq:fut >/dev/null
"$REGSH" register --id s-act --window hq:act >/dev/null
fut=$(( $(date +%s) + 7200 )); past=$(( $(date +%s) - 600 ))
"$REGSH" update s-over --status snoozed --wake-at "$past" >/dev/null
"$REGSH" update s-fut --status snoozed --wake-at "$fut" >/dev/null
: > "$RUN_LOG"; : > "$CTL_LOG"
out="$("$RESUME")"; rc=$?
eq "resume exits 0" "$rc" "0"
eq "resume wakes the overdue row" "$(getf s-over status)" "active"
eq "resume leaves the future row snoozed" "$(getf s-fut status)" "snoozed"
eq "resume keeps the future wake_at" "$(getf s-fut wake_at)" "$fut"
eq "resume leaves active rows alone" "$(getf s-act status)" "active"
eq "resume schedules exactly one timer" "$(wc -l < "$RUN_LOG" | tr -d ' ')" "1"
run="$(tail -1 "$RUN_LOG")"
case "$run" in *"--unit=hq-wake-s-fut "*"--on-calendar=@$fut "*"wake.sh s-fut") ok "resume reschedules the future row";; *) no "resume reschedules the future row" "$run";; esac
case "$out" in *"woke 1, rescheduled 1, failed 0"*) ok "resume summary";; *) no "resume summary" "$out";; esac
# a failing systemd-run makes the unit fail (OnFailure alert) but does not stop the walk
: > "$RUN_LOG"
FAKE_RUN_RC=1 "$RESUME" >/dev/null 2>&1; eq "resume exits 1 when a reschedule fails" "$?" "1"

# console-term rows belong to the runner: resume must not wake them or create timers
"$REGSH" register --id t-past --kind console-term --rig hq >/dev/null
"$REGSH" register --id t-fut --kind console-term --rig hq >/dev/null
"$REGSH" update t-past --status snoozed --wake-at "$past" >/dev/null
"$REGSH" update t-fut --status snoozed --wake-at "$fut" >/dev/null
: > "$RUN_LOG"
"$RESUME" >/dev/null 2>&1
eq "resume leaves overdue console-term snoozed" "$(getf t-past status)" "snoozed"
eq "resume leaves future console-term snoozed" "$(getf t-fut status)" "snoozed"
eq "resume creates no timer for console-term" "$(grep -c 'hq-wake-t-' "$RUN_LOG")" "0"

# one malformed wake_at is skipped and reported; the other rows are still handled; exit 1
"$REGSH" register --id s-bad --window hq:bad2 >/dev/null
"$REGSH" register --id s-over2 --window hq:over2 >/dev/null
"$REGSH" update s-bad --status snoozed --wake-at "$fut" >/dev/null
"$REGSH" update s-over2 --status snoozed --wake-at "$past" >/dev/null
python3 - "$HQ_STATE_DIR" <<'PYE'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/**/*.json", recursive=True):
    try: d = json.load(open(f))
    except Exception: continue
    if isinstance(d, dict) and "s-bad" in d:
        d["s-bad"]["wake_at"] = "soon"; json.dump(d, open(f, "w"))
PYE
out="$("$RESUME" 2>&1)"; rc=$?
eq "malformed row makes resume exit 1" "$rc" "1"
eq "malformed row does not stop the others" "$(getf s-over2 status)" "active"
case "$out" in *"skipping s-bad"*) ok "malformed row reported";; *) no "malformed row reported" "$out";; esac

# a failed re-snooze restores the prior status and wake_at exactly
"$REGSH" register --id s-re --window hq:re >/dev/null
"$REGSH" update s-re --status snoozed --wake-at "$fut" >/dev/null
FAKE_RUN_RC=1 "$SNOOZE" "for 5 days" --id s-re >/dev/null 2>&1; eq "failed re-snooze exits 1" "$?" "1"
eq "failed re-snooze keeps status snoozed" "$(getf s-re status)" "snoozed"
eq "failed re-snooze keeps the old wake_at" "$(getf s-re wake_at)" "$fut"

# --- hq-1nkg.14: wake leaves the row snoozed when no pane launched; no-op when not snoozed ---
"$REGSH" register s-np --rig r1 --kind worker --worktree "$HQ_ROOT" --objectives-file x.md >/dev/null 2>&1 \
  || "$REGSH" register s-np >/dev/null 2>&1
npfut=$(( $(date +%s) + 86400 ))
"$REGSH" update s-np --status snoozed --wake-at "$npfut" >/dev/null
: > "$CTL_LOG"
( unset HQ_NO_TMUX; TMUX_TMPDIR="$HQ_ROOT" HQ_TMUX_SERVERS=hqtest-none TMUX= "$WAKE" s-np >/dev/null 2>&1 ); rc=$?
eq "wake with no hq tmux session exits nonzero" "$([ "$rc" -ne 0 ] && echo y || echo n)" "y"
eq "wake with no pane leaves the row snoozed" "$(getf s-np status)" "snoozed"
eq "wake with no pane keeps wake_at" "$(getf s-np wake_at)" "$npfut"
grep -q 'hq-wake-s-np' "$CTL_LOG" && no "wake with no pane keeps the timer" "$(head -2 "$CTL_LOG")" || ok "wake with no pane keeps the timer"
# not snoozed: nothing happens, exit 0, no timer stop, row untouched
"$REGSH" update s-np --status active --wake-at "" >/dev/null
: > "$CTL_LOG"
out="$("$WAKE" s-np 2>&1)"; rc=$?
eq "wake of an active row exits 3 (already revived)" "$rc" "3"
case "$out" in *"not snoozed"*) ok "wake of an active row says so";; *) no "wake of an active row says so" "$out";; esac
eq "wake of an active row stays active" "$(getf s-np status)" "active"
eq "wake of an active row touches no timer" "$(wc -c < "$CTL_LOG" | tr -d ' ')" "0"

# --- hq-1nkg.15: two wakes at once open one pane; resume treats exit 3 as not a failure ---
TD="$(mktemp -d /tmp/snz15.XXXXXX)"; mkdir -p "$TD/bin"
printf '#!/bin/bash\nsleep 120\n' > "$TD/bin/claude"; chmod +x "$TD/bin/claude"
tmx(){ TMUX_TMPDIR="$TD" tmux -L snz15 "$@"; }
TMUX_TMPDIR="$TD" tmux -L snz15 new-session -d -s hq -n work 'sleep 120'
"$REGSH" register s-race --rig r1 --kind worker --worktree "$HQ_ROOT" --objectives-file x.md >/dev/null 2>&1
"$REGSH" update s-race --status snoozed --wake-at "$(( $(date +%s) + 86400 ))" >/dev/null
before="$(tmx list-panes -t '=hq:work' | wc -l)"
( unset HQ_NO_TMUX TMUX; export TMUX_TMPDIR="$TD" HQ_TMUX_SERVERS=snz15 PATH="$TD/bin:$PATH"
  "$WAKE" s-race >"$TD/w1.out" 2>&1 & "$WAKE" s-race >"$TD/w2.out" 2>&1 & wait )
after="$(tmx list-panes -t '=hq:work' | wc -l)"
eq "two wakes started at once add exactly one pane" "$((after - before))" "1"
eq "raced row ends active" "$(getf s-race status)" "active"
ones="$(grep -l '^woke s-race' "$TD/w1.out" "$TD/w2.out" 2>/dev/null | wc -l | tr -d ' ')"
eq "exactly one of the two wakes launched" "$ones" "1"
grep -q 'not snoozed' "$TD/w1.out" "$TD/w2.out" && ok "the other wake saw an active row" || no "the other wake saw an active row"
tmx kill-server 2>/dev/null; rm -rf "$TD"
# wake-resume: a row another wake already revived (wake.sh exit 3) is not counted as failed
SD="$(mktemp -d)"; mkdir -p "$SD/scripts"
cp "$DIR/../scripts/wake-resume.sh" "$DIR/../scripts/session-registry.sh" "$SD/scripts/"
ln -s "$DIR/../scripts/lib" "$SD/scripts/lib"
printf '#!/usr/bin/env bash\nexit 3\n' > "$SD/scripts/wake.sh"; chmod +x "$SD/scripts/wake.sh"
"$REGSH" register s-r3 --rig r1 --kind worker --worktree "$HQ_ROOT" --objectives-file x.md >/dev/null 2>&1
"$REGSH" update s-r3 --status snoozed --wake-at 1 >/dev/null
out="$("$SD/scripts/wake-resume.sh" 2>&1)"
case "$out" in *"already revived s-r3"*) ok "resume reports exit 3 as already revived";; *) no "resume reports exit 3 as already revived" "$out";; esac
case "$out" in *"wake.sh s-r3 failed"*) no "resume does not fail on exit 3" "$out";; *) ok "resume does not fail on exit 3";; esac
rm -rf "$SD"

# --- hq-1nkg.17: a held wake lock makes the reschedule skip the row; wake waits a bounded time ---
"$REGSH" register --id s-lk --window hq:lk >/dev/null
lkat=$(( $(date +%s) + 7200 ))
"$REGSH" update s-lk --status snoozed --wake-at "$lkat" >/dev/null
( exec 9>"$HQ_STATE_DIR/wake-s-lk.lock"; flock 9; sleep 6 ) & holder=$!
sleep 1
: > "$RUN_LOG"; : > "$CTL_LOG"
out="$("$RESUME" 2>&1)"; rc=$?
case "$out" in *"could not schedule hq-wake-s-lk"*) no "lock held: skip is not counted as a failure" "$out";; *) ok "lock held: skip is not counted as a failure";; esac
case "$out" in *"skipped s-lk, a wake is in progress"*) ok "lock held: resume skips the row";; *) no "lock held: resume skips the row" "$out";; esac
eq "lock held: no systemd-run for the row" "$(grep -c 'hq-wake-s-lk' "$RUN_LOG")" "0"
eq "lock held: no systemctl stop for the row" "$(grep -c 'hq-wake-s-lk' "$CTL_LOG")" "0"
# snooze of the same id while a wake holds the lock fails and restores the row
"$REGSH" update s-lk --status active --wake-at "" >/dev/null
out="$("$SNOOZE" "for 2 hours" --id s-lk 2>&1)"; rc=$?
eq "lock held: snooze exits 1" "$rc" "1"
case "$out" in *"wake of s-lk is in progress"*) ok "lock held: snooze says why";; *) no "lock held: snooze says why" "$out";; esac
eq "lock held: snooze restores the prior status" "$(getf s-lk status)" "active"
wait "$holder" 2>/dev/null
# lock free again: the same row reschedules
"$REGSH" update s-lk --status snoozed --wake-at "$lkat" >/dev/null
: > "$RUN_LOG"; out="$("$RESUME" 2>&1)"
eq "lock free: row is rescheduled" "$(grep -c 'hq-wake-s-lk' "$RUN_LOG")" "1"
# a wake.sh blocked on the lock gives up with exit 1 (timeout shortened to 1s by a flock shim)
SHIM="$(mktemp -d)"
cat > "$SHIM/flock" <<'F'
#!/usr/bin/env bash
if [ "$1" = -w ]; then shift 2; set -- -w 1 "$@"; fi
exec /usr/bin/flock "$@"
F
chmod +x "$SHIM/flock"
( exec 9>"$HQ_STATE_DIR/wake-s-lk.lock"; flock 9; sleep 4 ) & holder=$!
sleep 1
out="$(PATH="$SHIM:$PATH" "$DIR/../scripts/wake.sh" s-lk 2>&1)"; rc=$?
eq "wake lock timeout exits 1" "$rc" "1"
case "$out" in *"could not lock s-lk"*) ok "wake lock timeout message";; *) no "wake lock timeout message" "$out";; esac
eq "wake lock timeout leaves the row snoozed" "$(getf s-lk status)" "snoozed"
wait "$holder" 2>/dev/null; rm -rf "$SHIM"

[ "$fail" = 0 ] && echo "SNOOZE TESTS: PASS" || { echo "SNOOZE TESTS: FAIL"; exit 1; }
