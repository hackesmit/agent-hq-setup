#!/usr/bin/env bash
# console-test.sh: hermetic tests for the console control-center state machine
# (ops/console/ctl.sh + statelib.py). No framework; each case prints ok/FAIL.
# Everything runs against a temp HQ_STATE_DIR with the real session registry.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CTL="$REPO/ops/console/ctl.sh"
REG="$REPO/ops/scripts/session-registry.sh"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "ok   $1"; }
bad(){ fail=$((fail+1)); echo "FAIL $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3] got [$2])"; fi; }

# HQ_NOTIFY and HQ_NO_BELL stub the off-box side effects of ask. Not optional
# hygiene: without them a single run pushes ~60 real ntfy notifications or
# rings the owner's terminal 60 times, one per ask (case 2 alone fires 40).
export HQ_NOTIFY=/bin/true
export HQ_NO_BELL=1

fresh(){
  # Hermetic: a run from inside a console terminal or a tmux pane must not bind
  # asks to the caller's own session (ctl whoami reads these).
  unset HQ_CONSOLE_SID TMUX TMUX_PANE HQ_PANE
  TMP="$(mktemp -d)"
  export HQ_STATE_DIR="$TMP/state" HQ_ROOT="$REPO" HQ_NO_TMUX=1 HQ_NO_SCHEDULE=1
  # dispatch refuses a rig that does not exist, so the fixture provides one
  export HQ_RIGS_DIR="$TMP/rigs"; mkdir -p "$HQ_RIGS_DIR/demo/.git"
  export HQ_NOTIFY="${HQ_NOTIFY:-/bin/true}" HQ_NO_BELL="${HQ_NO_BELL:-1}"
  # ask routing: no orchestrator unless a case turns it on (hermetic on a box
  # where the real event runner is up)
  export HQ_ORCH=off; unset HQ_ORCH_EVENTS HQ_ORCH_FALLBACK_S
  mkdir -p "$HQ_STATE_DIR"
  WRD="$HQ_STATE_DIR/console"
}

# ---- 1. ask files an open request bound to the session generation
fresh
"$REG" register --id s-aaaa --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-1 --window w --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "what color?" --bead bead-1 --session s-aaaa)"
st="$(python3 -c "import json;r=json.load(open('$WRD/requests.json'))[0];print(r['status'],r['session'],bool(r['gen']))")"
check "ask files open request with gen" "$st" "open s-aaaa True"

# ---- 1b. routing policy: a plain ask RINGS the owner's terminal and must NOT
# touch ntfy; only --urgent pushes ntfy, at urgent priority. Both go through
# seams. Guards a live regression: this suite once pushed ~60 real ntfy
# notifications per run because ask hardcoded ops/scripts/notify.sh, so if
# anyone drops a seam these logs go empty and the case FAILS rather than
# ringing or paging the owner 40 times.
fresh
NLOG="$TMP/notify.log"; BLOG="$TMP/bell.log"
cat > "$TMP/notify-stub" <<EOF
#!/usr/bin/env bash
echo "\$1|\$2|\$3" >> "$NLOG"
EOF
cat > "$TMP/bell-stub" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$BLOG"
EOF
chmod +x "$TMP/notify-stub" "$TMP/bell-stub"
export HQ_NOTIFY="$TMP/notify-stub" HQ_BELL="$TMP/bell-stub"
unset HQ_NO_BELL
"$CTL" ask "seam q1" --bead bead-n >/dev/null
"$CTL" ask "seam q2" >/dev/null
# a never-created log is the proof that nothing was pushed, so count safely
lines(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
bells="$(lines "$BLOG")"; pushes="$(lines "$NLOG")"
firstbell="$(head -1 "$BLOG")"
check "a plain ask rings the terminal and never touches ntfy" \
  "$bells $pushes [$firstbell]" "2 0 [needs you: [bead-n] seam q1]"
"$CTL" ask "the box is on fire" --bead bead-u --urgent >/dev/null
check "only --urgent reaches ntfy, at urgent priority" \
  "$(lines "$BLOG") [$(cat "$NLOG")]" "3 [urgent|Console: URGENT|[bead-u] the box is on fire]"
export HQ_NOTIFY=/bin/true HQ_NO_BELL=1; unset HQ_BELL

# ---- 1c. bell.sh itself: it must actually write BEL (0x07) to every target,
# survive a dead one, and write NOTHING when suppressed. Without this the
# HQ_NO_BELL seam is only assumed to work; the suite execs bell.sh ~58 times
# per run, so "it exits early" needs to be proven, not trusted.
fresh
BELLSH="$REPO/ops/console/bell.sh"
t1="$TMP/tty1"; t2="$TMP/tty2"; : > "$t1"; : > "$t2"
dead="$TMP/nodir/tty"
unset HQ_NO_BELL
out="$(HQ_BELL_TTYS="$t1 $t2 $dead" "$BELLSH" "ring me")"; rc=$?
b1="$(od -An -tx1 < "$t1" | tr -d ' \n')"; b2="$(od -An -tx1 < "$t2" | tr -d ' \n')"
check "bell writes BEL to each live target and tolerates a dead one" \
  "$rc $out $b1 $b2" "0 rang 2 07 07"
: > "$t1"
HQ_NO_BELL=1 HQ_BELL_TTYS="$t1" "$BELLSH" "should be silent" >/dev/null; rc2=$?
sz="$(wc -c < "$t1" | tr -d ' ')"
check "HQ_NO_BELL writes nothing at all" "$rc2 $sz" "0 0"
# No terminal took the bell -> one quiet push via notify.sh away (2026-09-30),
# never when a tty rang, suppressed, or the caller pushes urgent itself.
alog="$TMP/away.log"; : > "$alog"
printf '#!/usr/bin/env bash\nprintf "%%s|%%s|%%s|%%s\\n" "$1" "$2" "$3" "${HQ_NO_BELL:-}" >> "%s"\n' "$alog" > "$TMP/away-stub"
chmod +x "$TMP/away-stub"
HQ_NOTIFY="$TMP/away-stub" HQ_BELL_TTYS=" " "$BELLSH" "nobody here" >/dev/null
HQ_NOTIFY="$TMP/away-stub" HQ_BELL_TTYS="$dead" "$BELLSH" "only dead ttys" >/dev/null
check "no attached terminal pushes away once per bell, with the bell suppressed" \
  "$(cat "$alog" | tr '\n' ';')" "away|HQ needs you|nobody here|1;away|HQ needs you|only dead ttys|1;"
: > "$alog"
HQ_NOTIFY="$TMP/away-stub" HQ_BELL_TTYS="$t1" "$BELLSH" "someone here" >/dev/null
HQ_NOTIFY="$TMP/away-stub" HQ_BELL_NO_PUSH=1 HQ_BELL_TTYS=" " "$BELLSH" "urgent follows" >/dev/null
HQ_NOTIFY="$TMP/away-stub" HQ_NO_BELL=1 HQ_BELL_TTYS=" " "$BELLSH" "silenced" >/dev/null
check "a rung tty, HQ_BELL_NO_PUSH, and HQ_NO_BELL never push" "$(wc -l < "$alog" | tr -d ' ')" "0"
# tmux display-message expands #(cmd) by RUNNING cmd, and this text comes from
# question bodies, which are hostile input. Escaping must survive: without it,
# `ctl.sh ask '#(touch X)'` was command execution as the owner.
pwn="$TMP/tmux-pwned"
rm -f "$pwn"
unset HQ_NO_BELL
HQ_NO_TMUX= "$BELLSH" "#(touch $pwn)" >/dev/null 2>&1
sleep 3   # tmux runs #() asynchronously; a short wait gives a false clean bill
check "question text cannot execute via the tmux status line" \
  "$([ -f "$pwn" ] && echo VULNERABLE || echo safe)" "safe"
export HQ_NO_BELL=1
# a glob in the seam must NOT expand: unquoted expansion would truncate every
# matching file in cwd to one byte
gdir="$TMP/globtest"; mkdir -p "$gdir"; echo "precious data" > "$gdir/keep.txt"
( cd "$gdir" && HQ_BELL_TTYS='*' "$BELLSH" >/dev/null 2>&1 )
check "a glob in HQ_BELL_TTYS does not truncate matching files" \
  "$(cat "$gdir/keep.txt")" "precious data"
export HQ_NO_BELL=1

# ---- 2. 40 concurrent asks all survive (lock keeps read-modify-write whole)
fresh
for i in $(seq 1 40); do "$CTL" ask "q$i" --bead "b$i" >/dev/null & done; wait
n="$(python3 -c "import json;print(len(json.load(open('$WRD/requests.json'))))")"
check "40 concurrent asks kept" "$n" "40"

# ---- 3. live answer + await delivery, idempotent re-read, refused double answer
fresh
"$REG" register --id s-bbbb --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-3 --window w --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "which db?" --bead bead-3 --session s-bbbb)"
"$CTL" answer "$rid" "use sqlite" >/dev/null; a1=$?
out="$("$CTL" await "$rid" --chunk 5)"; a2=$?
check "answer accepted then await delivers" "$a1 $a2 ${out##*$'\n'}" "0 0 use sqlite"
st="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
check "request is delivered" "$st" "delivered"
out2="$("$CTL" await "$rid" --chunk 5)"; a3=$?
check "await re-read after delivery is idempotent" "$a3 ${out2##*$'\n'}" "0 use sqlite"
"$CTL" answer "$rid" "too late" >/dev/null 2>&1; a4=$?
check "second answer refused" "$a4" "3"

# ---- 4. illegal transitions refused
fresh
rid="$("$CTL" ask "loose q")"
"$CTL" answer "$rid" "ans" >/dev/null
"$CTL" resolve "$rid" >/dev/null 2>&1; r1=$?
check "resolve on answered refused" "$r1" "3"
"$CTL" await "$rid" --chunk 5 >/dev/null
"$CTL" cancel "$rid" >/dev/null 2>&1; r2=$?
check "cancel on delivered refused" "$r2" "3"
rid2="$("$CTL" ask "another q")"
"$CTL" cancel "$rid2" >/dev/null; r3=$?
"$CTL" await "$rid2" --chunk 5 >/dev/null; r4=$?
check "cancel open ok then await reports cancelled" "$r3 $r4" "0 11"

# ---- 5. concurrent double answer: exactly one wins AND its text survives
fresh
rid="$("$CTL" ask "race q")"
"$CTL" answer "$rid" "A" >/dev/null 2>&1 & p1=$!
"$CTL" answer "$rid" "B" >/dev/null 2>&1 & p2=$!
wait $p1; e1=$?; wait $p2; e2=$?
wins=0; exp=""
[ "$e1" = 0 ] && { wins=$((wins+1)); exp="A"; }
[ "$e2" = 0 ] && { wins=$((wins+1)); exp="B"; }
got="$("$CTL" await "$rid" --chunk 5 | tail -1)"
check "concurrent answers: one winner, winner text delivered" "$wins $got" "1 $exp"

# ---- 5b. unreadable answer file leaves the request retryable, never lost
fresh
rid="$("$CTL" ask "fragile q")"
"$CTL" answer "$rid" "recoverable" >/dev/null
af="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['answer_file'])")"
chmod 000 "$af"
"$CTL" await "$rid" --chunk 3 >/dev/null; r1=$?
st="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
chmod 644 "$af"
out="$("$CTL" await "$rid" --chunk 5)"; r2=$?
check "unreadable answer stays answered then delivers" "$r1 $st $r2 ${out##*$'\n'}" "10 answered 0 recoverable"

# ---- 6. ask --wait picks up an answer arriving mid-wait
fresh
( sleep 2; "$CTL" answer "$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['id'])")" "midwait" >/dev/null ) &
out="$("$CTL" ask "waiting q" --wait --chunk 20)"; rc=$?
wait
check "ask --wait returns the answer" "$rc ${out##*$'\n'}" "0 midwait"

# ---- 7. wait chunk expiry returns WAITING exit 10
fresh
rid="$("$CTL" ask "never answered")"
out="$("$CTL" await "$rid" --chunk 3)"; rc=$?
check "await chunk expiry" "$rc ${out%% *}" "10 WAITING"

# ---- 8. stale: session finished before the answer
fresh
"$REG" register --id s-cccc --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-8 --window w --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "late q" --bead bead-8 --session s-cccc)"
"$REG" update s-cccc --status done >/dev/null
out="$("$CTL" answer "$rid" "too late")"; rc=$?
st="$(python3 -c "import json;r=json.load(open('$WRD/requests.json'))[0];print(r['status'],r.get('delivery'),open(r['answer_file']).read().strip())")"
check "answer to finished session is recorded, not dropped" "$rc $st" "0 delivered recorded too late"
case "$out" in *"recorded on the request"*) ok "stale answer says it is recorded" ;; *) bad "stale answer says it is recorded (got [$out])" ;; esac
# a restarted asker that awaits the request still gets the recorded answer
out="$("$CTL" await "$rid" --chunk 2)"; rc=$?
check "await on a recorded stale answer returns it" "$rc ${out##*$'\n'}" "0 too late"

# ---- 9. parked revival: claim exactly once, objectives appended, awaiting cleared
fresh
echo "# objectives" > "$TMP/obj.md"
"$REG" register --id s-dddd --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-9 --window w --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "parked q" --bead bead-9 --session s-dddd)"
"$REG" update s-dddd --status snoozed >/dev/null
"$CTL" park-mark "$rid" --session s-dddd >/dev/null
WAKELOG="$TMP/wake.log"
cat > "$TMP/wake-stub" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$WAKELOG"; exit 0
EOF
chmod +x "$TMP/wake-stub"
export HQ_WAKE="$TMP/wake-stub"
"$CTL" answer "$rid" "revive with this" >/dev/null 2>&1 & q1=$!
"$CTL" answer "$rid" "second racer" >/dev/null 2>&1 & q2=$!
wait $q1; e1=$?; wait $q2; e2=$?
wins=0; [ "$e1" = 0 ] && wins=$((wins+1)); [ "$e2" = 0 ] && wins=$((wins+1))
wakes="$(grep -c . "$WAKELOG" 2>&1)" || wakes=0
st="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
aw="$(python3 -c "import json;print(len(json.load(open('$WRD/awaiting.json'))))")"
objhit="$(grep -c "revive with this\|second racer" "$TMP/obj.md")"
check "revival: one winner, one wake, delivered, awaiting cleared, objectives appended" \
  "$wins $wakes $st $aw $objhit" "1 1 delivered 0 1"
unset HQ_WAKE

# ---- 9b. objectives append failure aborts revival and reverts to answered
fresh
"$REG" register --id s-obj --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-9b --window w --model m --objectives "$TMP/no-such-dir/obj.md" >/dev/null
rid="$("$CTL" ask "bad obj q" --bead bead-9b --session s-obj)"
"$REG" update s-obj --status snoozed >/dev/null
"$CTL" park-mark "$rid" --session s-obj >/dev/null
export HQ_WAKE="/bin/true"
"$CTL" answer "$rid" "cannot land" >/dev/null 2>&1; rc=$?
st="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
check "objectives append failure reverts to answered" "$rc $st" "5 answered"
unset HQ_WAKE

# ---- 10. wake failure reverts claim to answered; later await still delivers
fresh
echo "# objectives" > "$TMP/obj.md"
"$REG" register --id s-eeee --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-10 --window w --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "parked q2" --bead bead-10 --session s-eeee)"
"$REG" update s-eeee --status snoozed >/dev/null
"$CTL" park-mark "$rid" --session s-eeee >/dev/null
export HQ_WAKE="/bin/false"
"$CTL" answer "$rid" "wake will fail" >/dev/null 2>&1; rc=$?
st="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
out="$("$CTL" await "$rid" --chunk 5)"; rc2=$?
check "wake failure falls back to answered then await delivers" \
  "$rc $st $rc2 ${out##*$'\n'}" "5 answered 0 wake will fail"
unset HQ_WAKE

# ---- 11. concurrent log-change appends all survive
fresh
for i in $(seq 1 30); do "$CTL" log-change "c$i" >/dev/null & done; wait
n="$(grep -c . "$WRD/changes.jsonl")"
check "30 concurrent log-changes kept" "$n" "30"

# ---- 12. dispatch: claim once, second refused, expired claim reusable
fresh
SPAWNLOG="$TMP/spawn.log"
cat > "$TMP/spawn-stub" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$SPAWNLOG"; exit 0
EOF
chmod +x "$TMP/spawn-stub"
export HQ_SPAWN="$TMP/spawn-stub"
"$CTL" dispatch bead-12 --rig demo --model claude-sonnet-5 >/dev/null 2>&1; d1=$?
"$CTL" dispatch bead-12 --rig demo --model claude-sonnet-5 >/dev/null 2>&1; d2=$?
spawns="$(grep -c . "$SPAWNLOG")"
python3 - <<PY
import json, time
f = "$WRD/dispatch/bead-12.json"
d = json.load(open(f)); d["epoch"] = time.time() - 700
json.dump(d, open(f, "w"))
PY
"$CTL" dispatch bead-12 --rig demo --model claude-sonnet-5 >/dev/null 2>&1; d3=$?
check "dispatch claim once, refuse dup, allow expired" "$d1 $d2 $spawns $d3" "0 3 1 0"
"$CTL" dispatch "bad;id" --rig demo >/dev/null 2>&1; d4=$?
"$CTL" dispatch bead-x --rig demo --model gpt-4 >/dev/null 2>&1; d5=$?
check "dispatch validates ids and model allowlist" "$d4 $d5" "2 2"
# every model the picker offers must survive dispatch, and reach spawn verbatim
: > "$SPAWNLOG"
rc=""
for m in claude-fable-5 claude-opus-5 claude-opus-4-8 claude-opus-4-7 claude-sonnet-5; do
  "$CTL" dispatch "bead-m-$m" --rig demo --model "$m" >/dev/null 2>&1; rc="$rc$?"
done
passed_through="$(grep -c -- '--model claude-fable-5\|--model claude-opus-5\|--model claude-opus-4-8\|--model claude-opus-4-7\|--model claude-sonnet-5' "$SPAWNLOG")"
check "all five offered models dispatch and reach spawn" "$rc $passed_through" "00000 5"
unset HQ_SPAWN

# ---- 13. dispatch refused while a session holds the bead
fresh
export HQ_SPAWN="/bin/true"
"$REG" register --id s-ffff --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-13 --window w --model m --objectives o >/dev/null
"$CTL" dispatch bead-13 --rig demo >/dev/null 2>&1; d1=$?
"$REG" update s-ffff --status done >/dev/null
"$CTL" dispatch bead-13 --rig demo >/dev/null 2>&1; d2=$?
check "dispatch honors live session then frees on done" "$d1 $d2" "3 0"
unset HQ_SPAWN

# ---- 13c. hq-4npjr.10: a dead pane frees the bead; --force overrides a live one;
# dispatch hands spawn its claim nonce so spawn's own check passes
fresh
export HQ_SPAWN="$TMP/nonce-spawn"
printf '#!/bin/sh\necho "$HQ_CLAIM_NONCE $*" >>"%s/spawn.log"\n' "$TMP" >"$HQ_SPAWN"; chmod +x "$HQ_SPAWN"
"$REG" register --id s-dd --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-13c --window %31 --model m --objectives o >/dev/null
printf '{"%%31":{"dead":true,"pid":"1","path":"/x","cmd":"bash launch-s-dd.sh"}}' >"$TMP/panes.json"
HQ_PANES_FIXTURE="$TMP/panes.json" "$CTL" dispatch bead-13c --rig demo >/dev/null 2>&1; t1=$?
nonce="$(python3 -c "import json;print(json.load(open('$WRD/dispatch/bead-13c.json'))['nonce'])")"
case "$(tail -1 "$TMP/spawn.log")" in "$nonce "*) pn=passed;; *) pn=missing;; esac
"$REG" register --id s-live --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-13d --window %32 --model m --objectives o >/dev/null
"$CTL" dispatch bead-13d --rig demo >/dev/null 2>&1; t2=$?
"$CTL" dispatch bead-13d --rig demo --force >/dev/null 2>&1; t3=$?
case "$(tail -1 "$TMP/spawn.log")" in *"--force"*) pf=forwarded;; *) pf=dropped;; esac
check "dispatch: dead pane frees, nonce reaches spawn, live pane refuses, --force overrides" \
  "$t1 $pn $t2 $t3 $pf" "0 passed 3 0 forwarded"
out="$("$CTL" dispatch bead-13d --rig demo 2>&1)"
case "$out" in *s-live*) ok "dispatch refusal names the holder";; *) bad "dispatch refusal names the holder ($out)";; esac
unset HQ_SPAWN

# ---- 12b. failed spawn releases the dispatch claim for retry
fresh
export HQ_SPAWN="/bin/false"
"$CTL" dispatch bead-12b --rig demo >/dev/null 2>&1; f1=$?
claim="present"; [ -f "$WRD/dispatch/bead-12b.json" ] || claim="released"
export HQ_SPAWN="/bin/true"
"$CTL" dispatch bead-12b --rig demo >/dev/null 2>&1; f2=$?
check "failed spawn releases claim, retry works" "$claim $f2" "released 0"
[ "$f1" = 0 ] && bad "failed spawn must not exit 0" || ok "failed spawn propagates failure"
unset HQ_SPAWN

# ---- 12c. finishable session still holds its bead
fresh
export HQ_SPAWN="/bin/true"
"$REG" register --id s-fin --kind worker --rig demo --worktree w --branch b \
  --bead bead-12c --window w --model m --objectives o >/dev/null
"$REG" update s-fin --status finishable >/dev/null
"$CTL" dispatch bead-12c --rig demo >/dev/null 2>&1; f1=$?
check "finishable session blocks dispatch" "$f1" "3"
unset HQ_SPAWN

# ---- 13b. kill marks the session done
fresh
"$REG" register --id s-kill --kind worker --rig demo --worktree w \
  --branch b --bead bead-k --window w --model m --objectives o >/dev/null
"$CTL" kill s-kill >/dev/null; k1=$?
st="$("$REG" get s-kill | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')"
check "kill marks session done" "$k1 $st" "0 done"

# ---- 14. finish-check: sha-bound approval marker
fresh
mkdir -p "$TMP/repo" && cd "$TMP/repo" && git init -q . && git commit -q --allow-empty -m x
head="$(git rev-parse HEAD)"
cd "$REPO"
"$REG" register --id s-gggg --kind worker --rig hq --worktree "$TMP/repo" \
  --branch feat --bead bead-14 --window w --model m --objectives o >/dev/null
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bd" <<EOF
#!/usr/bin/env bash
echo "comment: Review-Approve: $head looks solid"
EOF
chmod +x "$TMP/bin/bd"
okv="$(HQ_BD="$TMP/bin/bd" "$CTL" finish-check bead-14 | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')"
cat > "$TMP/bin/bd" <<EOF
#!/usr/bin/env bash
echo "comment: Review-Approve: 0000000000000000000000000000000000000000 stale"
EOF
badv="$(HQ_BD="$TMP/bin/bd" "$CTL" finish-check bead-14 | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')"
cat > "$TMP/bin/bd" <<EOF
#!/usr/bin/env bash
echo "no approvals here"
EOF
none="$(HQ_BD="$TMP/bin/bd" "$CTL" finish-check bead-14 | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')"
check "finish-check sha match / stale / missing" "$okv $badv $none" "True False False"

# ---- 14b. finish-check by session; dirty worktree refused; done session refused
cat > "$TMP/bin/bd" <<EOF
#!/usr/bin/env bash
echo "comment: Review-Approve: $head looks solid"
EOF
bysess="$(HQ_BD="$TMP/bin/bd" "$CTL" finish-check --session s-gggg | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')"
touch "$TMP/repo/dirty-file"
dirty="$(HQ_BD="$TMP/bin/bd" "$CTL" finish-check --session s-gggg | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["ok"], "uncommitted" in d["reason"])')"
rm "$TMP/repo/dirty-file"
"$REG" update s-gggg --status done >/dev/null
donev="$(HQ_BD="$TMP/bin/bd" "$CTL" finish-check --session s-gggg | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')"
check "finish-check session ok / dirty refused / done refused" "$bysess $dirty $donev" "True False True False"

# state is the slow path (it shells to bd per rig); one helper, called sparingly
statejson(){ "$CTL" state; }

# ---- 15. self-naming: ctl name persists and lands on the card in state
fresh
"$REG" register --id s-name --kind terminal --rig "" --worktree "" --branch "" \
  --bead "" --window "%9" --model m --objectives o >/dev/null
"$CTL" name s-name "acme reconciliation" >/dev/null; n1=$?
nm="$(python3 -c "import json;print(json.load(open('$WRD/names.json'))['s-name']['name'])")"
shown="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(next(t["name"] for t in d["terminals"] if t["id"]=="s-name"))')"
"$CTL" name s-name --clear >/dev/null
gone="$(python3 -c "import json;print('s-name' in json.load(open('$WRD/names.json')))")"
check "name persists, renders in state, clears" "$n1 [$nm] [$shown] $gone" "0 [acme reconciliation] [acme reconciliation] False"
# a recycled session id must not inherit the dead terminal's label
"$CTL" name s-name "old label" >/dev/null
"$REG" deregister s-name >/dev/null
sleep 1   # registry generations are whole-second timestamps
"$REG" register --id s-name --kind terminal --window "%9" --model m >/dev/null
reused="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(repr(next(t["name"] for t in d["terminals"] if t["id"]=="s-name")))')"
check "a reused session id does not inherit the old name" "$reused" "''"
"$CTL" name "bad;id" "x" >/dev/null 2>&1; n2=$?
"$CTL" name s-name >/dev/null 2>&1; n3=$?
check "name validates session id and requires a label" "$n2 $n3" "2 2"

# ---- 15a. the name orchestrator is reserved (hq-4npjr.6): the console hides worker
# asks while a live session holds it, so never a worker, and one live holder only
fresh
"$REG" register --id s-och --kind terminal --window "%9" --model m >/dev/null
"$REG" register --id s-och2 --kind terminal --window "%8" --model m >/dev/null
"$REG" register --id s-owk --kind worker --rig demo --window "%7" --model m >/dev/null
"$CTL" name s-owk " Orchestrator " >/dev/null 2>&1; o1=$?
"$CTL" name s-och orchestrator >/dev/null 2>&1; o2=$?
"$CTL" name s-och orchestrator >/dev/null 2>&1; o3=$?
"$CTL" name s-och2 ORCHESTRATOR >/dev/null 2>&1; o4=$?
"$CTL" name s-owk "orchestrator tests" >/dev/null 2>&1; o5=$?
"$REG" update s-och --status done >/dev/null
"$CTL" name s-och2 orchestrator >/dev/null 2>&1; o6=$?
check "orchestrator name: no worker, one live holder, free once it is done" \
  "$o1 $o2 $o3 $o4 $o5 $o6" "1 0 0 1 0 0"

# ---- 15b. whoami resolves the current pane to the newest live session
fresh
"$REG" register --id s-old --kind terminal --window "%7" --model m >/dev/null
sleep 1   # registry timestamps are whole seconds; the newest must be unambiguous
"$REG" register --id s-new --kind terminal --window "%7" --model m >/dev/null
"$REG" register --id s-other --kind terminal --window "%8" --model m >/dev/null
w1="$(HQ_PANE="%7" "$CTL" whoami)"
"$REG" update s-new --status done >/dev/null
w2="$(HQ_PANE="%7" "$CTL" whoami)"
HQ_PANE="%99" "$CTL" whoami >/dev/null 2>&1; w3=$?
check "whoami: newest live session for the pane, skips done, fails unknown" "$w1 $w2 $w3" "s-new s-old 1"
# two live registrations in the same second are ambiguous: refuse, never guess.
# The timestamps are forced rather than raced: relying on two registers landing
# in the same wall-clock second made this pass or fail on timing.
"$REG" register --id s-tieb --kind terminal --window "%6" --model m >/dev/null
"$REG" register --id s-tiea --kind terminal --window "%6" --model m >/dev/null
python3 - <<PY
import json
f = "$HQ_STATE_DIR/sessions.json"
d = json.load(open(f))
d["s-tiea"]["started"] = d["s-tieb"]["started"] = "2026-08-12T12:00:00Z"
json.dump(d, open(f, "w"), indent=2, sort_keys=True)
PY
tie="$(HQ_PANE="%6" "$CTL" whoami 2>&1)"; w4=$?
check "whoami refuses a same-second tie instead of guessing" \
  "$w4 $(printf '%s' "$tie" | grep -c 's-tiea, s-tieb')" "1 1"

# ---- 15c. rig and task derived from the worktree/branch spawn.sh created
fresh
"$REG" register --id s-drv --kind worker --rig "" \
  --worktree "$REPO/rigs/acme-dashboard-1a2b" --branch "acme-dashboard-1a2b-fix-chart-axis" \
  --bead "" --window "%1" --model m --objectives o >/dev/null
drv="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin)
t=next(t for t in d["terminals"] if t["id"]=="s-drv")
print(t["derived_rig"], "|", t["derived_task"])')"
check "derive rig and task from worktree and branch" "$drv" "acme-dashboard | fix chart axis"
# a rig name that itself contains four hex characters must not split early
"$REG" register --id s-hex --kind worker --rig "" \
  --worktree "$REPO/rigs/foo-dead-bar-1a2b" --branch "foo-dead-bar-1a2b-fix-chart" \
  --bead "" --window "%2" --model m --objectives o >/dev/null
hex="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin)
t=next(t for t in d["terminals"] if t["id"]=="s-hex")
print(t["derived_rig"], "|", t["derived_task"])')"
check "hex-looking rig name derives on the exact prefix" "$hex" "foo-dead-bar | fix chart"
# a branch that does not fit the spawn shape is shown whole, never re-split
"$REG" register --id s-odd --kind worker --rig "actual-rig" --worktree "" \
  --branch "foo-dead-fix-cache" --bead "" --window "%3" --model m --objectives o >/dev/null
odd="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin)
t=next(t for t in d["terminals"] if t["id"]=="s-odd")
print(t["derived_rig"], "|", t["derived_task"])')"
check "known rig plus off-shape branch keeps the whole branch" "$odd" "actual-rig | foo dead fix cache"

# ---- 16. snoozing a question hides it from Needs-you until its date
fresh
rid="$("$CTL" ask "waiting on the accountant")"
other="$("$CTL" ask "answer me now")"
"$CTL" req-snooze "$rid" "+2 days" >/dev/null; s1=$?
hid="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(len(d["requests"]), len(d["snoozed"]), d["snoozed"][0]["id"] if d["snoozed"] else "-")')"
check "snoozed question leaves Needs-you" "$s1 $hid" "0 1 1 $rid"
# time passing re-surfaces it with no further action
python3 - <<PY
import json
f = "$WRD/requests.json"
reqs = json.load(open(f))
for r in reqs:
    if r["id"] == "$rid": r["snooze_until"] = "2020-01-01T00:00:00Z"
json.dump(reqs, open(f, "w"))
PY
back="$(statejson | python3 -c 'import json,sys
d=json.load(sys.stdin); print(len(d["requests"]), len(d["snoozed"]))')"
check "snooze expiry re-surfaces the question" "$back" "2 0"
# an answer still lands on a snoozed request: snoozing is a filter, not a state
"$CTL" req-snooze "$rid" "+2 days" >/dev/null
"$CTL" answer "$rid" "arrived anyway" >/dev/null; s2=$?
out="$("$CTL" await "$rid" --chunk 5)"
"$CTL" req-unsnooze "$other" >/dev/null; s3=$?
check "snoozed request still answerable; unsnooze is a no-op when not snoozed" \
  "$s2 ${out##*$'\n'} $s3" "0 arrived anyway 0"

# ---- 16b. unsnooze restores immediately; bad when values refused
fresh
rid="$("$CTL" ask "deferred q")"
"$CTL" req-snooze "$rid" "tomorrow 09:00" >/dev/null
"$CTL" req-unsnooze "$rid" >/dev/null
su="$(python3 -c "import json;print(repr(json.load(open('$WRD/requests.json'))[0].get('snooze_until')))")"
"$CTL" req-snooze "$rid" 'x;rm -rf /' >/dev/null 2>&1; b1=$?
"$CTL" req-snooze "$rid" "yesterday" >/dev/null 2>&1; b2=$?
"$CTL" req-snooze "r-nope" "+1 day" >/dev/null 2>&1; b3=$?
check "unsnooze clears; charset, past date and unknown id refused" "$su $b1 $b2 $b3" "'' 2 2 1"

# ---- 17. To bottom: sink reorders open requests and the order sticks
fresh
r1="$("$CTL" ask "first")"; r2="$("$CTL" ask "second")"; r3="$("$CTL" ask "third")"
order(){ statejson | python3 -c 'import json,sys
print(" ".join(r["id"] for r in json.load(sys.stdin)["requests"]))'; }
o1="$(order)"
"$CTL" sink "$r1" >/dev/null
o2="$(order)"
o3="$(order)"
"$CTL" sink "$r2" >/dev/null
o4="$(order)"
"$CTL" sink "$r2" --top >/dev/null
o5="$(order)"
# --top must beat the current minimum: raising the LAST request has to move it,
# and equal ranks fall back to storage order, so rank 0 alone would not
"$CTL" sink "$r1" --top >/dev/null
o6="$(order)"
check "sink moves to bottom, stays sunk across polls, --top raises to the front" \
  "[$o1] [$o2] [$o3] [$o4] [$o5] [$o6]" \
  "[$r1 $r2 $r3] [$r2 $r3 $r1] [$r2 $r3 $r1] [$r3 $r1 $r2] [$r2 $r3 $r1] [$r1 $r2 $r3]"
"$CTL" sink "r-nope" >/dev/null 2>&1; k1=$?
"$CTL" sink "bad;id" >/dev/null 2>&1; k2=$?
check "sink refuses unknown and malformed ids" "$k1 $k2" "1 2"

# ---- 18. delivery: ask binds a return address, and answering records HOW it
# landed. Injection itself needs a real tmux pane, so the hermetic run exercises
# the fallback path and asserts the delivery method is recorded either way.
fresh
"$REG" register --id s-deliv --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-18 --window "%77" --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "bound q" --bead bead-18 --session s-deliv)"
"$CTL" answer "$rid" "the answer" >/dev/null
"$CTL" await "$rid" --chunk 5 >/dev/null
how="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0].get('delivery',''))")"
check "poll delivery is recorded as such" "$how" "polled"
seen="$("$CTL" state | python3 -c 'import json,sys
d=json.load(sys.stdin)
r=[x for x in d["requests"] if x["id"]=="'"$rid"'"]
print(r[0]["status"], r[0].get("delivery","")) if r else print("GONE")')"
check "a just-delivered answer stays visible with its method" "$seen" "delivered polled"

# ---- 18b. injection must NEVER type into a pane whose Claude has exited: the
# text would execute as a shell command. With HQ_NO_TMUX the guard short
# circuits, so this asserts the fallback rather than a false positive.
fresh
"$REG" register --id s-shell --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-18b --window "%78" --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "shell q" --bead bead-18b --session s-shell)"
out="$("$CTL" answer "$rid" "rm -rf /")"
case "$out" in
  *"typed straight into"*) bad "answer must not claim injection without a live claude pane";;
  *) ok "no live claude pane means no injection, falls back to poll";;
esac

# ---- 19. clear: a request whose asker is gone must have a way off the board.
# It sits in "delivering" forever otherwise, because nothing will ever poll for
# an answered request with no live session.
fresh
rid="$("$CTL" ask "stuck question")"
"$CTL" answer "$rid" "answered into the void" >/dev/null
st1="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
vis1="$("$CTL" state | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["requests"]))')"
"$CTL" clear "$rid" >/dev/null; c1=$?
st2="$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['status'])")"
vis2="$("$CTL" state | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["requests"]))')"
check "clear cancels a stuck answered request and hides it" \
  "$st1 $vis1 $c1 $st2 $vis2" "answered 1 0 cancelled 0"
# already-terminal requests can still be hidden, and unknown ids are refused
rid2="$("$CTL" ask "another")"
"$CTL" cancel "$rid2" >/dev/null
"$CTL" clear "$rid2" >/dev/null; c2=$?
vis3="$("$CTL" state | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["requests"]))')"
"$CTL" clear r-nosuch >/dev/null 2>&1; c3=$?
check "clear also hides an already-cancelled one, refuses unknown ids" "$c2 $vis3 $c3" "0 0 1"
# clear must hide EXACTLY its target: a hide that walked off the end of the list
# would silently take an unrelated question off the owner's board
fresh
a="$("$CTL" ask "keep me A")"; b="$("$CTL" ask "clear me B")"; c="$("$CTL" ask "keep me C")"
"$CTL" clear "$b" >/dev/null
hid="$(python3 -c "import json
print(','.join(r['id'] for r in json.load(open('$WRD/requests.json')) if r.get('hidden')))")"
left="$("$CTL" state | python3 -c 'import json,sys
print(",".join(r["id"] for r in json.load(sys.stdin)["requests"]))')"
check "clear hides only its target, leaving the others on the board" \
  "[$hid] [$left]" "[$b] [$a,$c]"

# ---- 20. undeliverable detection: an answer nobody can receive must not sit in
# "delivering" forever waiting for a poll that will never come.
fresh
# (a) never bound to a terminal
r1="$("$CTL" ask "unbound q")"
"$CTL" answer "$r1" "into the void" >/dev/null
# (b) bound to a terminal that has since finished
"$REG" register --id s-gone --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-20 --window "%80" --model m --objectives "$TMP/obj.md" >/dev/null
r2="$("$CTL" ask "bound q" --session s-gone)"
"$CTL" answer "$r2" "answered" >/dev/null
"$REG" update s-gone --status done >/dev/null
# (c) bound to a LIVE terminal: must be left alone, it may still poll
"$REG" register --id s-live --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-20c --window "%81" --model m --objectives "$TMP/obj.md" >/dev/null
r3="$("$CTL" ask "live q" --session s-live)"
"$CTL" answer "$r3" "still deliverable" >/dev/null
"$CTL" state >/dev/null   # the sweep runs here
st(){ python3 -c "import json;print([r['status'] for r in json.load(open('$WRD/requests.json')) if r['id']=='$1'][0])"; }
why="$(python3 -c "import json;print([r.get('undeliverable_why','') for r in json.load(open('$WRD/requests.json')) if r['id']=='$r2'][0])")"
# round 4 (hq-zqqu.1): an answer never bound to a terminal is not cancelled; it
# stays answered and listed as owed until the owner clears it. A finished WORKER's
# answer is still swept.
check "a finished worker's answer is swept, an unbound one stays owed, a live one is left to poll" \
  "$(st "$r1") $(st "$r2") $(st "$r3")" "answered cancelled answered"
check "the sweep records why it could not be delivered" \
  "$(printf '%s' "$why" | grep -c 'has finished')" "1"
# the live one still delivers normally afterwards
out="$("$CTL" await "$r3" --chunk 5)"
check "a swept board does not break real delivery" "${out##*$'\n'}" "still deliverable"

# ---- 21. no backticks inside ctl.sh. Its python heredocs are UNQUOTED (<<PY),
# so bash performs command substitution inside them, comments included. A
# comment mentioning a command in backticks actually ran that command and
# spliced its output into the python source, breaking ctl.sh state outright.
fresh
bt="$(grep -c '`' "$REPO/ops/console/ctl.sh")"
check "no backticks in ctl.sh (unquoted heredocs would execute them)" "$bt" "0"
out="$("$CTL" state 2>&1)"; sc=$?
valid="$(printf '%s' "$out" | python3 -c 'import json,sys
try:
    json.load(sys.stdin); print("json")
except Exception:
    print("broken")')"
check "ctl state still emits valid json" "$sc $valid" "0 json"

# ---- 21b. a registry past 128 KB still compiles (hq-4npjr.16). Twice a
# registry passed through one env string made exec fail with E2BIG, ctl state
# came back empty and every card lost its name (2026-08-26, 2026-11-04 at
# 140 KB). A 200 KB sessions.json must still list every terminal, named.
fresh
"$REG" register --id s-orch --kind terminal --rig "" --worktree "" --branch "" \
  --bead "" --window "%9" --model m --objectives o >/dev/null
"$CTL" name s-orch "orchestrator" >/dev/null
python3 - "$HQ_STATE_DIR/sessions.json" <<'PY'
import json, sys
p = sys.argv[1]
reg = json.load(open(p))
i = 0
while len(json.dumps(reg)) < 200 * 1024:
    sid = "s-%04x" % i
    reg[sid] = {"bead": "xd-af%d" % i, "branch": "acme-dashboard-%04x-work-bead-xd-af%d-patch-t" % (i, i),
                "id": sid, "kind": "worker", "last_seen": "2026-10-27T23:35:53Z", "model": "claude-opus-5-5",
                "objectives_file": "state/objectives/%s.md" % sid, "rig": "acme-dashboard",
                "started": "2026-10-27T23:35:53Z", "status": "done", "tmux_window": "%%%d" % (1000 + i),
                "wake_at": None, "worktree": "/home/owner/hq/rigs/acme-dashboard-%04x" % i}
    i += 1
json.dump(reg, open(p, "w"))
PY
regsize="$(wc -c <"$HQ_STATE_DIR/sessions.json")"
regn="$(python3 -c "import json;print(len(json.load(open('$HQ_STATE_DIR/sessions.json'))))")"
big="$("$CTL" state 2>/dev/null | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("broken"); sys.exit()
t = d.get("terminals") or []
orch = [x.get("name") for x in t if x.get("id") == "s-orch"]
print(len(t), orch[0] if orch else "missing")')"
check "a 200 KB registry is really past 200 KB" "$([ "$regsize" -ge 204800 ] && echo yes || echo "no $regsize")" "yes"
check "ctl state lists every terminal of a 200 KB registry, names intact" "$big" "$regn orchestrator"

# ---- 22. batch dispatch: several beads, ONE terminal. A session per bead is
# the biggest avoidable token cost, since every spawn re-reads CLAUDE.md and the
# seed before doing any work. Handing terminals this much power also has to be
# safe, so every refusal path is covered here.
fresh
SPAWNLOG="$TMP/batch-spawn.log"
cat > "$TMP/batch-spawn" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$SPAWNLOG"; exit 0
EOF
chmod +x "$TMP/batch-spawn"
export HQ_SPAWN="$TMP/batch-spawn"
# dispatch validates each bead against the rig before claiming, so the fixture
# needs a bd. It reports every id as an open bead unless the id says otherwise.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bd" <<'EOF'
#!/usr/bin/env bash
id="$2"
case "$id" in
  missing-*) exit 1 ;;
  closed-*)  printf '{"id":"%s","title":"a closed one","status":"closed"}\n' "$id" ;;
  running-*) printf '{"id":"%s","title":"already being worked","status":"in_progress"}\n' "$id" ;;
  weird-*)   printf '[]\n' ;;
  *)         printf '{"id":"%s","title":"fixture bead","status":"open"}\n' "$id" ;;
esac
EOF
chmod +x "$TMP/bin/bd"
export HQ_BD="$TMP/bin/bd"
"$CTL" dispatch-batch --rig demo --beads "d-1,d-2,d-3" --model claude-sonnet-5 >/dev/null; b1=$?
spawns="$(grep -c . "$SPAWNLOG")"
claims="$(ls "$WRD/dispatch" | wc -l | tr -d ' ')"
inseed="$(grep -c 'd-1.*d-2.*d-3' "$SPAWNLOG")"
check "three beads produce ONE spawn, three claims, all named in the seed" \
  "$b1 $spawns $claims $inseed" "0 1 3 1"
# each bead becomes a phase, so the card shows which one it is on
ph="$(python3 -c "import json;d=json.load(open('$WRD/phases/d-1.json'));print(len(d['phases']), d['title'])" 2>/dev/null)"
check "each bead in the batch becomes a phase on the card" "$ph" "3 3 beads"
# a bead already claimed must refuse the WHOLE batch, not half-dispatch it
: > "$SPAWNLOG"
"$CTL" dispatch-batch --rig demo --beads "d-3,d-9" >/dev/null 2>&1; b2=$?
check "a batch touching a claimed bead is refused whole" \
  "$b2 $(grep -c . "$SPAWNLOG") $([ -f "$WRD/dispatch/d-9.json" ] && echo leaked || echo clean)" \
  "3 0 clean"
# guardrails
"$CTL" dispatch-batch --rig demo --beads "a,b,c,d,e,f,g,h,i" >/dev/null 2>&1; b3=$?
"$CTL" dispatch-batch --rig demo --beads "bad;id" >/dev/null 2>&1; b4=$?
"$CTL" dispatch-batch --rig nope --beads "x" >/dev/null 2>&1; b5=$?
"$CTL" dispatch-batch --rig hq --beads "hq-1" >/dev/null 2>&1; b6=$?
"$CTL" dispatch-batch --rig demo --beads "z-1" --model gpt-4 >/dev/null 2>&1; b7=$?
check "batch refuses oversize, bad ids, unknown rig and bad models, and accepts the hq repo" \
  "$b3 $b4 $b5 $b6 $b7" "2 2 2 0 2"
# a bead that does not exist, or is closed, must not cost a terminal
: > "$SPAWNLOG"
"$CTL" dispatch-batch --rig demo --beads "ok-1,missing-2" >/dev/null 2>&1; v1=$?
"$CTL" dispatch-batch --rig demo --beads "ok-1,closed-2" >/dev/null 2>&1; v2=$?
"$CTL" dispatch-batch --rig demo --beads "ok-1,running-2" >/dev/null 2>&1; v3=$?
"$CTL" dispatch-batch --rig demo --beads "ok-1,weird-2" >/dev/null 2>&1; v4=$?
"$CTL" dispatch-batch --rig demo --beads "ok-1,ok-1" >/dev/null 2>&1; v5=$?
check "batch refuses missing, closed, in_progress, odd-shaped and duplicate beads" \
  "$v1 $v2 $v3 $v4 $v5 $(grep -c . "$SPAWNLOG") $([ -f "$WRD/dispatch/ok-1.json" ] && echo leaked || echo clean)" \
  "2 2 2 2 2 0 clean"

# a secondary bead stays held while its batch session lives, even once the ten
# minute claim has aged out; otherwise it is dispatched to a second terminal
"$REG" register --id s-batch --kind worker --rig demo --worktree w --branch b \
  --bead d-1 --window w --model m --objectives o >/dev/null
python3 - <<PY
import json, time
for b in ("d-1", "d-2", "d-3"):
    f = "$WRD/dispatch/%s.json" % b
    d = json.load(open(f)); d["epoch"] = time.time() - 3600   # long expired
    json.dump(d, open(f, "w"))
PY
"$CTL" dispatch-batch --rig demo --beads "d-2" >/dev/null 2>&1; h1=$?
"$REG" update s-batch --status done >/dev/null
"$CTL" dispatch-batch --rig demo --beads "d-2" >/dev/null 2>&1; h2=$?
check "an aged claim stays held while its batch session lives, frees when done" \
  "$h1 $h2" "3 0"

# a failed spawn must release every claim, not strand them
: > "$SPAWNLOG"
export HQ_SPAWN=/bin/false
"$CTL" dispatch-batch --rig demo --beads "r-1,r-2" >/dev/null 2>&1; b8=$?
left="$(ls "$WRD/dispatch" | grep -c '^r-' || true)"
check "a failed batch spawn releases all of its claims" "$b8 $left" "1 0"
unset HQ_SPAWN

# hq-4npjr.10: a batch whose bead an active session holds is refused (exit 3,
# naming the holder) unless the pane is dead; --force overrides and reaches spawn
export HQ_SPAWN="$TMP/batch-spawn"; : > "$SPAWNLOG"
"$REG" register --id s-bh --kind worker --rig demo --worktree w --branch b \
  --bead q-1 --window %41 --model m --objectives o >/dev/null
out="$("$CTL" dispatch-batch --rig demo --beads "q-0,q-1" 2>&1)"; q1=$?
case "$out" in *s-bh*) qn=named;; *) qn="unnamed:$out";; esac
printf '{"%%41":{"dead":true,"pid":"1","path":"/x","cmd":"bash launch-s-bh.sh"}}' >"$TMP/panes41.json"
HQ_PANES_FIXTURE="$TMP/panes41.json" "$CTL" dispatch-batch --rig demo --beads "q-0,q-1" >/dev/null 2>&1; q2=$?
"$REG" register --id s-bh2 --kind worker --rig demo --worktree w --branch b \
  --bead q-5 --window %42 --model m --objectives o >/dev/null
"$CTL" dispatch-batch --rig demo --beads "q-5" --force >/dev/null 2>&1; q3=$?
check "batch: live holder refuses and is named, dead pane frees, --force overrides" \
  "$q1 $qn $q2 $q3 $(grep -c -- '--force' "$SPAWNLOG")" "3 named 0 0 1"
unset HQ_SPAWN

# ---- structured handoff fields on ask (console v2, design section 5)
fresh
rid="$("$CTL" ask "run the migration" --kind run --cmd "supabase db push --linked" --link https://example.invalid/x --why "needs your key" --sev P2 --meta '{"branch":"autofix/abc"}')"
rec="$(python3 - "$WRD/requests.json" "$rid" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
r = [x for x in reqs if x["id"] == sys.argv[2]][0]
print(r["kind"], r["cmd"], r["link"], r["why"], r["sev"], r["meta"].get("branch"))
PY
)"
check "ask records kind/cmd/link/why/sev/meta" "$rec" "run supabase db push --linked https://example.invalid/x needs your key P2 autofix/abc"
rid2="$("$CTL" ask "plain question")"
rec2="$(python3 - "$WRD/requests.json" "$rid2" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
r = [x for x in reqs if x["id"] == sys.argv[2]][0]
print(r["kind"], r["sev"], r["cmd"] == "", r["meta"] == {})
PY
)"
check "plain ask defaults to decide/P1 with empty fields" "$rec2" "decide P1 True True"
"$CTL" ask "bad kind" --kind nope >/dev/null 2>&1; k=$?
"$CTL" ask "bad sev" --sev P9 >/dev/null 2>&1; v=$?
check "bad --kind and --sev are rejected" "$k $v" "2 2"

# ---- 24. the manual-command store is retired (proposal 58): cmd add refuses
TMP="$(mktemp -d)"; fresh
"$CTL" cmd add 'supabase db push --linked' --why 'no service key here' --shell hqbox >/dev/null 2>&1; rc=$?
check "cmd add is refused (exit 3)" "$rc" "3"
rm -rf "$TMP"

# ---- SLA sweep: an unanswered question escalates itself, twice at most, and
# the clock pauses while snoozed. Timestamps are back-dated directly in
# requests.json because the sweep reads wall-clock; helpers below rewrite the
# anchor fields under the same JSON shape statelib writes.
backdate(){ # backdate <rid> <field> <seconds-ago>
  python3 - "$WRD/requests.json" "$1" "$2" "$3" <<'PY'
import json, sys, time
path, rid, field, ago = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
reqs = json.load(open(path))
r = [x for x in reqs if x["id"] == rid][0]
r[field] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - ago))
json.dump(reqs, open(path, "w"))
PY
}
field(){ # field <rid> <field>
  python3 - "$WRD/requests.json" "$1" "$2" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
r = [x for x in reqs if x["id"] == sys.argv[2]][0]
print(r.get(sys.argv[3], ""))
PY
}

# a fresh P1 does not breach
fresh
rid="$("$CTL" ask "fresh question" --sev P1)"
out="$("$CTL" req-sla-sweep)"
check "fresh question does not breach" "$out" "no breaches"

# a P1 older than 4h escalates to P0 and pushes ntfy (P0 policy)
fresh
NLOG="$TMP/n.log"; BLOG="$TMP/b.log"
printf '#!/usr/bin/env bash
echo "$1|$2" >> %q
' "$NLOG" > "$TMP/nstub"
printf '#!/usr/bin/env bash
echo "$1" >> %q
' "$BLOG" > "$TMP/bstub"
chmod +x "$TMP/nstub" "$TMP/bstub"
rid="$(HQ_NOTIFY="$TMP/nstub" "$CTL" ask "old question" --sev P1 --bead bead-9)"
: > "$NLOG" 2>/dev/null || true   # drop the ask's own pushes; the sweep's are the test
backdate "$rid" ts $((5*3600))
out="$(HQ_NOTIFY="$TMP/nstub" HQ_BELL="$TMP/bstub" "$CTL" req-sla-sweep)"
sv="$(field "$rid" sev)"; n="$(field "$rid" sla_escalations)"
check "P1 past 4h re-rings at P1, never climbs to P0 (2026-11-04)" "$out|$sv|$n" "escalated $rid P1 -> P1|P1|1"
! grep -q "^urgent|" "$NLOG" && ok "a P1 re-ring sends no urgent push" || bad "a P1 re-ring sends no urgent push"
grep -q "unanswered" "$BLOG" && ok "escalation rings the bell" || bad "escalation rings the bell"

# each severity's own threshold: P2 needs 24h, P0 needs 30m
fresh
r2="$("$CTL" ask "p2 question" --sev P2)"
backdate "$r2" ts $((5*3600))
out="$("$CTL" req-sla-sweep)"
check "P2 at 5h is inside its 24h SLA" "$out" "no breaches"
backdate "$r2" ts $((25*3600))
out="$("$CTL" req-sla-sweep)"
check "P2 past 24h escalates to P1" "$out" "escalated $r2 P2 -> P1"

# no third escalation, and the crossing resets the clock (no double ring)
fresh
r3="$("$CTL" ask "stubborn question" --sev P2)"
backdate "$r3" ts $((49*3600))
"$CTL" req-sla-sweep >/dev/null            # P2 -> P1, sla_ts = now
out="$("$CTL" req-sla-sweep)"
check "a crossing resets the clock" "$out" "no breaches"
backdate "$r3" sla_ts $((5*3600))
"$CTL" req-sla-sweep >/dev/null            # P1 -> P1 (re-ring)
backdate "$r3" sla_ts $((3600))
out="$("$CTL" req-sla-sweep)"
sv="$(field "$r3" sev)"; n="$(field "$r3" sla_escalations)"
check "two escalations maximum" "$out|$sv|$n" "no breaches|P1|2"

# the clock pauses while snoozed, and unsnooze restarts it rather than breaching
fresh
r4="$("$CTL" ask "snoozed question" --sev P1)"
backdate "$r4" ts $((10*3600))
"$CTL" req-snooze "$r4" "+2 days" >/dev/null
out="$("$CTL" req-sla-sweep)"
check "snoozed question does not breach" "$out" "no breaches"
"$CTL" req-unsnooze "$r4" >/dev/null
out="$("$CTL" req-sla-sweep)"
check "unsnooze restarts the clock instead of breaching" "$out" "no breaches"

# answered questions are off the clock
fresh
r5="$("$CTL" ask "answered question" --sev P1)"
"$CTL" answer "$r5" "here you go" >/dev/null
backdate "$r5" ts $((10*3600))
out="$("$CTL" req-sla-sweep)"
check "answered question is off the clock" "$out" "no breaches"

# ---- hq-zqqu.1: no Needs-you panel. The question prints in the asking terminal (stderr;
# stdout stays the rid contract), the card is marked waiting through the session binding,
# and an answer given in the terminal is recorded with answer --here.
fresh
"$REG" register --id s-term --kind console-term --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-t --window "" --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "Pick one? Options: 1. A. 2. B." --session s-term --kind decide 2>"$TMP/ask.err")"
case "$rid" in r-*) ok "ask stdout is still just the rid" ;; *) bad "ask stdout is still just the rid (got [$rid])" ;; esac
grep -q "QUESTION FOR OWNER ($rid)" "$TMP/ask.err" && grep -q "Pick one? Options" "$TMP/ask.err" \
  && grep -q "answer $rid --here" "$TMP/ask.err" \
  && ok "ask prints the question and the --here hint in the asking terminal" \
  || bad "ask prints the question and the --here hint in the asking terminal ($(tr '\n' '|' < "$TMP/ask.err"))"
out="$("$CTL" answer "$rid" --here "B")"
st="$(python3 -c "import json;r=[x for x in json.load(open('$WRD/requests.json')) if x['id']=='$rid'][0];print(r['status'],r.get('delivery'),open(r['answer_file']).read().strip())")"
check "answer --here settles delivered, no injection" "$st" "delivered terminal B"
"$CTL" answer "$rid" --here "again" >/dev/null 2>&1; rc=$?
check "answer --here twice is refused" "$rc" "3"

# a worker that waits is told so; a question with no session says where it is listed
fresh
"$REG" register --id s-wk --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-w --window w --model m --objectives "$TMP/obj.md" >/dev/null
"$CTL" ask "worker q" --session s-wk --wait --chunk 1 >/dev/null 2>"$TMP/w.err"
grep -q "Waiting here. Session s-wk" "$TMP/w.err" && ok "a waiting worker is told its card shows the question" \
  || bad "a waiting worker is told its card shows the question ($(tr '\n' '|' < "$TMP/w.err"))"
"$CTL" ask "orphan q" >/dev/null 2>"$TMP/o.err"
grep -q "Questions with no terminal" "$TMP/o.err" && ok "a session-less ask says where it is listed" \
  || bad "a session-less ask says where it is listed ($(tr '\n' '|' < "$TMP/o.err"))"

# synthetic headless worker, end to end: it blocks on ask --wait, the answer comes in the
# way the card sends it (ctl answer <rid>), and the worker prints it and exits 0
fresh
"$REG" register --id s-hl --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-h --window w --model m --objectives "$TMP/obj.md" >/dev/null
( sleep 2; "$CTL" answer "$(python3 -c "import json;print(json.load(open('$WRD/requests.json'))[0]['id'])")" "from the card" >/dev/null ) &
out="$("$CTL" ask "headless q" --session s-hl --wait --chunk 20 2>/dev/null)"; rc=$?
wait
check "headless worker gets the card's answer" "$rc ${out##*$'\n'}" "0 from the card"

# the legacy entrypoint files through ctl: same record shape, session bound, the STE
# sentence-length refusal kept, and the notify ping still sent
fresh
NLOG="$TMP/legacy-notify.log"
printf '#!/usr/bin/env bash\necho "$1|$2|$3" >> "%s"\n' "$NLOG" > "$TMP/notify-stub2"; chmod +x "$TMP/notify-stub2"
rid="$(HQ_NOTIFY="$TMP/notify-stub2" "$REPO/ops/scripts/console.sh" ask "Short legacy question? Yes." --bead bead-l --session s-term 2>/dev/null)"
st="$(python3 -c "import json;r=[x for x in json.load(open('$WRD/requests.json')) if x['id']=='$rid'][0];print(r['status'],r['session'],r['bead'],r['sev'])")"
check "console.sh ask files through ctl, bound to the session" "$st" "open s-term bead-l P1"
check "console.sh ask still pings" "$(cut -d'|' -f1,2 "$NLOG" 2>/dev/null)" "default|Console: question waiting"
HQ_NOTIFY="$TMP/notify-stub2" "$REPO/ops/scripts/console.sh" ask "$(printf 'word %.0s' $(seq 30))" >/dev/null 2>&1; rc=$?
check "console.sh ask keeps the 25-word STE refusal" "$rc" "2"

# review round 1 (hq-zqqu.1): the CLAUDE.md form `console.sh ask "<q>" --bead B` from a
# disposable terminal. On main it filed with no session, so an answer given after that
# terminal finished was still recorded on the request (the Understudy corpus and the
# card both read answer_file). Routed through ctl it now binds to the asking pane's
# session, and an answer after that session is done is cancelled with no answer_file:
# the owner's answer is dropped, while the "Questions with no terminal" copy says it is kept.
fresh
"$REG" register --id s-co --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-x --window %77 --model m --objectives "$TMP/obj.md" >/dev/null
rid="$(HQ_PANE=%77 "$REPO/ops/scripts/console.sh" ask "Which option? 1. A. 2. B." --bead bead-x 2>/dev/null)"
"$REG" update s-co --status done >/dev/null
"$CTL" answer "$rid" "Option A" >/dev/null 2>&1
st="$(python3 -c "import json;r=[x for x in json.load(open('$WRD/requests.json')) if x['id']=='$rid'][0];af=r.get('answer_file');print(open(af).read().strip() if af else 'NONE')")"
check "legacy console.sh ask: an answer after the asker finished is still recorded" "$st" "Option A"

# round 1 finding 2 (lucy): answer --here is ONE transaction, open -> delivered, with no
# "answered" state ever written, so no delivery path can claim it and type it back.
fresh
"$REG" register --id s-h2 --kind console-term --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-h2 --window "" --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "atomic q" --session s-h2 2>/dev/null)"
seen="$(RID="$rid" CTL_DIR="$REPO/ops/console" WR="$WRD" python3 - <<'PY'
import os, sys, json
sys.path.insert(0, os.environ["CTL_DIR"]); import statelib as sl
statuses = []
real = sl.save
def spy(name, data):
    if name == "requests.json":
        statuses.extend(r["status"] for r in data if r["id"] == os.environ["RID"])
    return real(name, data)
sl.save = spy
ok, _ = sl.record_here(os.environ["RID"], "/dev/null")
print(ok, ",".join(statuses))
PY
)"
check "record_here writes delivered directly, never answered" "$seen" "True delivered"
INJ="$TMP/inject.log"
printf '#!/usr/bin/env bash\necho "$1" >> "%s"\n' "$INJ" > "$TMP/inject-stub"; chmod +x "$TMP/inject-stub"
rid="$("$CTL" ask "atomic q2" --session s-h2 2>/dev/null)"
HQ_INJECT="$TMP/inject-stub" "$CTL" answer "$rid" --here "C" >/dev/null
backdate "$rid" answered_ts 600
"$CTL" state >/dev/null 2>&1
check "answer --here is never typed back into the terminal" "$(lines "$INJ")" "0"

# round 1 finding 4: no escalation for a question whose asker has ended, one asked by an
# interactive terminal (a forgotten answer --here must not re-ring the owner), or one that
# already carries an answer; a live headless worker's question still escalates.
fresh
"$REG" register --id s-iv --kind console-term --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-iv --window "" --model m --objectives "$TMP/obj.md" >/dev/null
"$REG" register --id s-wd --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-wd --window w --model m --objectives "$TMP/obj.md" >/dev/null
"$REG" register --id s-wl --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-wl --window w --model m --objectives "$TMP/obj.md" >/dev/null
ri="$("$CTL" ask "interactive q" --session s-iv 2>/dev/null)"
rd="$("$CTL" ask "ended worker q" --session s-wd 2>/dev/null)"
rl="$("$CTL" ask "live worker q" --session s-wl 2>/dev/null)"
"$REG" update s-wd --status done >/dev/null
for r in "$ri" "$rd" "$rl"; do backdate "$r" ts $((5*3600)); done
out="$("$CTL" req-sla-sweep)"
check "SLA skips interactive and ended askers, escalates a live worker" "$out" "escalated $rl P1 -> P1"
python3 - "$WRD/requests.json" "$rl" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
for r in reqs:
    if r["id"] == sys.argv[2]:
        r["answer_file"] = "/dev/null"; r["sla_ts"] = "2000-01-01T00:00:00Z"
json.dump(reqs, open(sys.argv[1], "w"))
PY
out="$("$CTL" req-sla-sweep)"
check "SLA skips a request that carries a recorded answer" "$out" "no breaches"

# round 3: an interactive terminal that ends (or that the registry wrongly calls
# done) keeps its open question OPEN and answerable; nothing auto-closes it, and an
# ended worker's question stays open too.
"$REG" update s-iv --status done >/dev/null
"$CTL" state >/dev/null 2>&1
check "ended interactive terminal: its question stays open" "$(field "$ri" status)" "open"
check "ended worker: its question stays open" "$(field "$rd" status)" "open"
listed="$("$CTL" state | python3 -c 'import json,sys
print(" ".join(r["id"] for r in json.load(sys.stdin)["requests"]))')"
case " $listed " in *" $ri "*) ok "the open question is still on the board";; *) bad "the open question is still on the board ($listed)";; esac
out="$("$CTL" answer "$ri" "late answer")"
# round 4: with no live pane bound to it, the answer is recorded and the request
# stays answered (owed, listed as not yet in a terminal) rather than settling
if [ -f "$(field "$ri" answer_file)" ]; then rec=recorded; else rec=missing; fi
check "it stays answerable, and the answer is recorded and owed" "$(field "$ri" status) $rec" "answered recorded"

# round 3: no re-delivery. A card answer whose one typing attempt failed (or may
# have typed part of the text) is never typed again: it stays "answered" and on the
# board, and no state compile retries it.
fresh
"$REG" register --id s-rd --kind console-term --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-rd --window "" --model m --objectives "$TMP/obj.md" >/dev/null
rid="$("$CTL" ask "redeliver q" --session s-rd 2>/dev/null)"
INJ="$TMP/inject-half.log"
# types (records) and then reports failure: the "maybe typed" case
printf '#!/usr/bin/env bash\necho "$1" >> "%s"\nexit 1\n' "$INJ" > "$TMP/inject-half"; chmod +x "$TMP/inject-half"
HQ_INJECT="$TMP/inject-half" "$CTL" answer "$rid" "D" >/dev/null
for i in 1 2 3; do
  backdate "$rid" answered_ts 3600
  HQ_INJECT="$TMP/inject-half" "$CTL" state >/dev/null 2>&1
done
check "a failed injection is tried once and never again" "$(lines "$INJ") $(field "$rid" status)" "1 answered"
"$CTL" req-redeliver >/dev/null 2>&1; rc=$?
check "the retry verb is gone" "$rc" "2"
# an interactive terminal the registry calls done: its owed answer is not swept away
"$REG" update s-rd --status done >/dev/null
HQ_INJECT="$TMP/inject-half" "$CTL" state >/dev/null 2>&1
check "an owed answer to an interactive terminal is never cancelled by the sweep" "$(lines "$INJ") $(field "$rid" status)" "1 answered"
listed="$("$CTL" state | python3 -c 'import json,sys
print(" ".join(r["id"]+":"+r["status"] for r in json.load(sys.stdin)["requests"]))')"
case " $listed " in *" $rid:answered "*) ok "the owed answer stays on the board for the foot list";; *) bad "the owed answer stays on the board ($listed)";; esac
"$CTL" clear "$rid" >/dev/null
check "the owner can clear it" "$(field "$rid" status) $(field "$rid" hidden)" "cancelled True"

# ---- review round 2 (hq-zqqu.1): a STILL-RUNNING interactive terminal must not lose
# its open question. hqbox runs two tmux servers that both hold an 'hq' session
# (default and hqterm). The SessionStart hook's registry reconcile lists only the
# server of the pane it runs in, so a Claude session starting in a console terminal
# (hqterm) marks a live interactive pane on the default server "done". On main the
# question then stays open and answerable; round 2's settle_ended_interactive resolved it (removed in round 3).
# Private TMUX_TMPDIR: never touches the real tmux servers.
if command -v tmux >/dev/null; then
  fresh
  export TMUX_TMPDIR="$TMP/tmx"; mkdir -p "$TMUX_TMPDIR"
  tmux -L default new-session -d -s hq -x 80 -y 20 'sleep 600'
  ipane="$(tmux -L default new-window -t hq -PF '#{pane_id}' 'sleep 600')"
  tmux -L hqterm new-session -d -s hqt-x 'sleep 600'
  "$REG" register --id s-ilive --kind interactive --rig demo --worktree "$TMP/wt" \
    --branch b --bead bead-il --window "$ipane" >/dev/null
  rid="$("$CTL" ask "pick A or B?" --session s-ilive 2>/dev/null | tail -1)"
  TMUX="$TMUX_TMPDIR/tmux-$(id -u)/hqterm,1,0" bash "$REPO/ops/scripts/hook-session-register.sh" </dev/null
  "$CTL" state >/dev/null 2>&1
  alive="$(tmux -L default list-panes -a -F '#{pane_id}' | grep -cx "$ipane")"
  check "a running interactive terminal's question stays open" "$alive $(field "$rid" status)" "1 open"
  tmux -L default kill-server 2>/dev/null; tmux -L hqterm kill-server 2>/dev/null
  unset TMUX_TMPDIR
fi

# ---- review round 3 (hq-zqqu.1): a card answer is typed only into the pane bound to
# that exact session, looked up on BOTH tmux servers (pane ids are per server), and
# bound by the session identity its claude process carries. Anything ambiguous, a
# bare shell, or someone else's claude gets nothing. Private TMUX_TMPDIR: never
# touches the real tmux servers.
if command -v tmux >/dev/null; then
  fresh
  export TMUX_TMPDIR="$TMP/tmx3"; mkdir -p "$TMUX_TMPDIR"
  fake(){ printf "env %s=%s bash -c 'exec -a claude sleep 600'" "$1" "$2"; }
  d0="$(tmux -L default new-session -d -s hq -x 200 -y 20 -PF '#{pane_id}' "$(fake CDP_TERMINAL_ID s-other)")"
  h0="$(tmux -L hqterm new-session -d -s hqt-y -x 200 -y 20 -PF '#{pane_id}' "$(fake CDP_TERMINAL_ID s-hq)")"
  d1="$(tmux -L default new-window -t hq -PF '#{pane_id}' "$(fake CDP_TERMINAL_ID s-dup)")"
  h1="$(tmux -L hqterm new-window -t hqt-y -PF '#{pane_id}' "$(fake CDP_TERMINAL_ID s-dup)")"
  d2="$(tmux -L default new-window -t hq -PF '#{pane_id}' "env CDP_TERMINAL_ID=s-sh sleep 600")"
  tmux -L hqterm new-session -d -s hqt-s-ct -x 200 -y 20 "$(fake HQ_CONSOLE_SID s-ct)"
  sleep 0.3
  shown(){ tmux -L "$1" capture-pane -p -t "$2" | grep -c "$3"; }
  reg(){ "$REG" register --id "$1" --kind "$2" --rig demo --worktree "$TMP/wt" \
    --branch b --bead bead-r3 --window "$3" --model m --objectives "$TMP/obj.md" >/dev/null; }
  if [ "$d0" = "$h0" ] && [ "$d1" = "$h1" ]; then
    # same pane id on both servers, only the hqterm one is this session's claude
    reg s-hq terminal "$h0"
    rid="$("$CTL" ask "q hq" --session s-hq 2>/dev/null)"
    out="$(HQ_NO_TMUX= "$CTL" answer "$rid" "ANSWER-HQ")"; sleep 0.3
    check "the answer goes to the bound pane on the other server, not the same id here" \
      "$(shown hqterm "$h0" ANSWER-HQ) $(shown default "$d0" ANSWER-HQ) $(field "$rid" status)" "1 0 delivered"
    # registry pane id whose claude on both servers belongs to someone else
    reg s-none terminal "$d0"
    rid="$("$CTL" ask "q none" --session s-none 2>/dev/null)"
    HQ_NO_TMUX= "$CTL" answer "$rid" "ANSWER-NONE" >/dev/null; sleep 0.3
    check "a pane held by another session's claude gets nothing" \
      "$(shown hqterm "$h0" ANSWER-NONE) $(shown default "$d0" ANSWER-NONE) $(field "$rid" status)" "0 0 answered"
    # the same session identity on both servers: not resolvable to one pane
    reg s-dup terminal "$d1"
    rid="$("$CTL" ask "q dup" --session s-dup 2>/dev/null)"
    HQ_NO_TMUX= "$CTL" answer "$rid" "ANSWER-DUP" >/dev/null; sleep 0.3
    check "an ambiguous pane gets nothing" \
      "$(shown hqterm "$h1" ANSWER-DUP) $(shown default "$d1" ANSWER-DUP) $(field "$rid" status)" "0 0 answered"
  else
    bad "round 3 tmux fixture: pane ids did not line up ($d0/$h0 $d1/$h1)"
  fi
  # bound by identity but no claude in the pane (a bare process): nothing typed
  reg s-sh terminal "$d2"
  rid="$("$CTL" ask "q sh" --session s-sh 2>/dev/null)"
  HQ_NO_TMUX= "$CTL" answer "$rid" "ANSWER-SH" >/dev/null; sleep 0.3
  check "a pane with no claude gets nothing" "$(shown default "$d2" ANSWER-SH) $(field "$rid" status)" "0 answered"
  # a console terminal (hqt-<sid> on hqterm, no pane id in the registry)
  "$REG" register --id s-ct --kind console-term --rig demo --worktree "$TMP/wt" \
    --branch b --bead bead-r3 --window "" --model m --objectives "$TMP/obj.md" >/dev/null
  rid="$("$CTL" ask "q ct" --session s-ct 2>/dev/null)"
  HQ_NO_TMUX= "$CTL" answer "$rid" "ANSWER-CT" >/dev/null; sleep 0.3
  check "a console terminal gets its answer through hqt-<sid>" \
    "$(tmux -L hqterm capture-pane -p -t "hqt-s-ct" | grep -c ANSWER-CT) $(field "$rid" status)" "1 delivered"
  tmux -L default kill-server 2>/dev/null; tmux -L hqterm kill-server 2>/dev/null
  unset TMUX_TMPDIR
fi

# ---- review round 3 (hq-zqqu.1): an answer to a question from a STILL-RUNNING
# interactive terminal that the registry calls "done" must not drop off the board.
# Round 3 keeps such a question open and answerable (under Questions with no
# terminal), because the registry status is wrong on hqbox. But answer_request
# then routes it "stale": it settles straight to delivered (delivery recorded),
# nothing is typed, and the web lists only answered/revival_claimed as owed, so
# the answer leaves the board while the terminal still waits for it.
if command -v tmux >/dev/null; then
  fresh
  export TMUX_TMPDIR="$TMP/tmx3r"; mkdir -p "$TMUX_TMPDIR"
  tmux -L default new-session -d -s hq -x 80 -y 20 'sleep 600'
  ipane="$(tmux -L default new-window -t hq -PF '#{pane_id}' 'sleep 600')"
  tmux -L hqterm new-session -d -s hqt-x 'sleep 600'
  "$REG" register --id s-ilive3 --kind interactive --rig demo --worktree "$TMP/wt" \
    --branch b --bead bead-il --window "$ipane" >/dev/null
  rid="$("$CTL" ask "pick A or B?" --session s-ilive3 2>/dev/null | tail -1)"
  TMUX="$TMUX_TMPDIR/tmux-$(id -u)/hqterm,1,0" bash "$REPO/ops/scripts/hook-session-register.sh" </dev/null
  "$CTL" state >/dev/null 2>&1
  printf '#!/bin/sh\necho "$1" >> "%s/typed3"\n' "$TMP" > "$TMP/inject-rec3"; chmod +x "$TMP/inject-rec3"
  HQ_INJECT="$TMP/inject-rec3" "$CTL" answer "$rid" "A" >/dev/null 2>&1
  HQ_INJECT="$TMP/inject-rec3" "$CTL" state >/dev/null 2>&1
  alive="$(tmux -L default list-panes -a -F '#{pane_id}' | grep -cx "$ipane")"
  typed="$(lines "$TMP/typed3")"
  case "$(field "$rid" status)" in answered|revival_claimed) owed=1 ;; *) owed=0 ;; esac
  # on the board as owed, or actually typed into the terminal: either is fine
  if [ "$owed" = 1 ] || [ "$typed" -ge 1 ]; then onboard=yes; else onboard="no:$(field "$rid" status)/$(field "$rid" delivery)"; fi
  check "an answer to a running terminal the registry calls done stays on the board" "$alive $onboard" "1 yes"
  tmux -L default kill-server 2>/dev/null; tmux -L hqterm kill-server 2>/dev/null
  unset TMUX_TMPDIR
fi

# ---- review round 4 (hq-zqqu.1) ------------------------------------------------
# (1) the registry calls a terminal done but exactly one live pane is bound to it:
# the answer is typed once, like any live terminal. Private TMUX_TMPDIR.
if command -v tmux >/dev/null; then
  fresh
  export TMUX_TMPDIR="$TMP/tmx4"; mkdir -p "$TMUX_TMPDIR"
  p4="$(tmux -L default new-session -d -s hq -x 200 -y 20 -PF '#{pane_id}' "env CDP_TERMINAL_ID=s-done4 bash -c 'exec -a claude sleep 600'")"
  sleep 0.3
  "$REG" register --id s-done4 --kind interactive --rig demo --worktree "$TMP/wt" \
    --branch b --bead bead-r4 --window "$p4" >/dev/null
  rid="$("$CTL" ask "q done4" --session s-done4 2>/dev/null | tail -1)"
  "$REG" update s-done4 --status done >/dev/null
  HQ_NO_TMUX= "$CTL" answer "$rid" "ANSWER-DONE4" >/dev/null 2>&1; sleep 0.3
  HQ_NO_TMUX= "$CTL" state >/dev/null 2>&1
  check "a terminal the registry calls done but whose bound pane is live gets the answer typed once" \
    "$(tmux -L default capture-pane -p -t "$p4" | grep -c ANSWER-DONE4) $(field "$rid" status)" "1 delivered"
  tmux -L default kill-server 2>/dev/null; tmux -L hqterm kill-server 2>/dev/null
  unset TMUX_TMPDIR
fi

# (1) no pane resolves for a terminal the registry calls done: the answer is
# recorded and the request stays answered (owed) across a state pass
fresh
"$REG" register --id s-nop4 --kind interactive --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-r4 --window "%999" >/dev/null
rid="$("$CTL" ask "q nopane" --session s-nop4 2>/dev/null | tail -1)"
"$REG" update s-nop4 --status done >/dev/null
"$CTL" answer "$rid" "ANSWER-NOP" >/dev/null 2>&1
"$CTL" state >/dev/null 2>&1
if [ -n "$(field "$rid" answer_file)" ] && [ -f "$(field "$rid" answer_file)" ]; then rec=recorded; else rec=missing; fi
check "an answer to a done terminal with no live pane is recorded and stays owed" \
  "$(field "$rid" status) $rec $(field "$rid" hidden)" "answered recorded "

# (2) ctl clear --owed (the console's Clear) refuses an open question and takes an
# answered one off the board
fresh
ro="$("$CTL" ask "q open4" 2>/dev/null | tail -1)"
if "$CTL" clear "$ro" --owed >/dev/null 2>&1; then rc=0; else rc=1; fi
check "clear --owed refuses an open question and leaves it open and shown" \
  "$rc $(field "$ro" status) [$(field "$ro" hidden)]" "1 open []"
ra="$("$CTL" ask "q ans4" 2>/dev/null | tail -1)"
"$CTL" answer "$ra" "X" >/dev/null 2>&1
if "$CTL" clear "$ra" --owed >/dev/null 2>&1; then rc=0; else rc=1; fi
check "clear --owed takes an owed answer off the board" \
  "$rc $(field "$ra" status) $(field "$ra" hidden)" "0 cancelled True"

# (4) the sweep never cancels an answered request with no bound session, or whose
# session is no longer registered: it stays answered and listed as owed
fresh
rn="$("$CTL" ask "q unbound4" 2>/dev/null | tail -1)"
"$CTL" answer "$rn" "Y" >/dev/null 2>&1
"$REG" register --id s-ghost4 --kind interactive --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-r4 --window "%998" >/dev/null
rg="$("$CTL" ask "q ghost4" --session s-ghost4 2>/dev/null | tail -1)"
"$CTL" answer "$rg" "Z" >/dev/null 2>&1
SJ="$(find "$HQ_STATE_DIR" -name sessions.json | head -1)"
python3 - "$SJ" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d.pop("s-ghost4", None)
json.dump(d, open(sys.argv[1], "w"))
PY
listed="$("$CTL" state 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(sorted(r['id'] for r in d.get('requests', []) if r.get('status') == 'answered')))")"
check "the sweep keeps an unbound and an unregistered answer owed and listed" \
  "$(field "$rn" status) $(field "$rg" status) [$listed]" "answered answered [$(printf '%s\n%s\n' "$rn" "$rg" | sort | tr '\n' ' ' | sed 's/ $//')]"

# ---- hq-je3fk.5: no ghost sessions. Kill is idempotent, a row is bound to its
# pane by evidence (tmux reuses pane ids), state reconciles on read, and
# ctl reconcile writes the result. Private TMUX_TMPDIR: never the real servers.
fresh
if "$CTL" kill s-never >/dev/null 2>&1; then rc=0; else rc=$?; fi
check "kill on a session that was never registered succeeds" "$rc" "0"
"$REG" register --id s-twice --kind worker --rig demo --worktree w --branch b \
  --bead bead-k2 --window %77 >/dev/null
"$CTL" kill s-twice >/dev/null 2>&1
if "$CTL" kill s-twice >/dev/null 2>&1; then rc=0; else rc=$?; fi
check "kill on a session already killed succeeds" "$rc $("$REG" get s-twice | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')" "0 done"

if command -v tmux >/dev/null; then
  fresh
  export TMUX_TMPDIR="$TMP/tmx5"; mkdir -p "$TMUX_TMPDIR"
  gitwt(){  # a rig with main checked out and a worker worktree on its own branch
    git init -q -b main "$TMP/rig" 2>/dev/null || { git init -q "$TMP/rig"; git -C "$TMP/rig" checkout -q -b main; }
    git -C "$TMP/rig" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
    git -C "$TMP/rig" worktree add -q -b "$1" "$TMP/$1" main
  }
  gitwt merged; gitwt unmerged
  git -C "$TMP/unmerged" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
  sw(){ "$REG" register --id "$1" --kind worker --rig demo --worktree "$2" --branch b \
    --bead "bead-$1" --window "$3" >/dev/null; [ -z "${4:-}" ] || "$REG" update "$1" --status "$4" >/dev/null; }
  # the hq session; its first pane is someone else's (a monitor at another path)
  other="$(tmux -L default new-session -d -s hq -x 200 -y 20 -c "$TMP" -PF '#{pane_id}' 'sleep 600')"
  live="$(tmux -L default new-window -t hq -c "$TMP/merged" -PF '#{pane_id}' \
    "env CDP_TERMINAL_ID=s-live bash -c 'exec -a claude sleep 600'")"
  shell="$(tmux -L default new-window -t hq -c "$TMP/unmerged" -PF '#{pane_id}' 'sleep 600')"
  sleep 0.3
  sw s-live "$TMP/merged" "$live"
  sw s-shell "$TMP/unmerged" "$shell"
  sw s-reuse "$TMP/merged" "$other" finishable      # its old pane id now names the monitor
  sw s-gonewt "$TMP/nowhere" %4242 finishable       # pane and worktree both gone
  sw s-goneun "$TMP/unmerged" %4243                 # active, pane gone, unmerged work
  sw s-gonemg "$TMP/merged" %4244                   # active, pane gone, nothing unmerged
  # s-shell launched long ago; a launch under 10 minutes old keeps its row (claude may not
  # have started yet), so age it, and add a fresh twin that reconcile must leave active
  fresh="$(tmux -L default new-window -t hq -c "$TMP/merged" -PF '#{pane_id}' 'sleep 600')"
  sw s-fresh "$TMP/merged" "$fresh"
  python3 - "$HQ_STATE_DIR/sessions.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
rows = d.get("sessions", d) if isinstance(d, dict) else d
for r in (rows.values() if isinstance(rows, dict) else rows):
    if r.get("id") == "s-shell": r["started"] = "2026-01-01T00:00:00Z"
json.dump(d, open(p, "w"))
PY
  stj="$(HQ_NO_TMUX= "$CTL" state 2>/dev/null)"
  row(){ printf '%s' "$stj" | python3 -c "import json,sys
t=[x for x in json.load(sys.stdin)['terminals'] if x['id']=='$1'][0]
print(t['status'], t.get('pane_state'), t.get('needs_finish'))"; }
  check "state: a worker pane running its claude stays active" "$(row s-live)" "active live False"
  check "state: a worker pane back at a bare shell is not active" "$(row s-shell)" "exited shell True"
  check "state: a reused pane id is not this row's pane" "$(row s-reuse)" "finishable gone True"
  check "state: pane and worktree gone means nothing to finish" "$(row s-gonewt)" "done gone False"
  check "state: an active row whose pane is gone needs finish" "$(row s-goneun)" "exited gone True"
  before="$(md5sum < "$HQ_STATE_DIR/sessions.json")"
  dry="$(HQ_NO_TMUX= "$CTL" reconcile --dry-run 2>&1)"
  check "reconcile --dry-run writes nothing" "$(md5sum < "$HQ_STATE_DIR/sessions.json")" "$before"
  check "reconcile --dry-run lists what it would do" \
    "$(printf '%s\n' "$dry" | grep -c '^would s-')" "5"
  HQ_NO_TMUX= "$CTL" reconcile >/dev/null 2>&1
  regst(){ "$REG" get "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])'; }
  check "reconcile: a launch under 10 minutes old keeps its row active" "$(regst s-fresh)" "active"
  check "reconcile: settles rows by pane and unmerged work" \
    "$(regst s-live) $(regst s-shell) $(regst s-reuse) $(regst s-gonewt) $(regst s-goneun) $(regst s-gonemg)" \
    "active finishable done done finishable done"
  check "reconcile never kills a pane" \
    "$(tmux -L default list-panes -a -F '#{pane_id}' | grep -cx -e "$live" -e "$shell" -e "$other")" "3"
  # kill on the reused row must not end the monitor that now holds its pane id
  "$REG" update s-reuse --status finishable >/dev/null
  if HQ_NO_TMUX= "$CTL" kill s-reuse >/dev/null 2>&1; then rc=0; else rc=$?; fi
  check "kill on a row whose pane id was reused leaves that pane alone" \
    "$rc $(regst s-reuse) $(tmux -L default list-panes -a -F '#{pane_id}' | grep -cx "$other")" "0 done 1"
  if HQ_NO_TMUX= "$CTL" kill s-live >/dev/null 2>&1; then rc=0; else rc=$?; fi
  check "kill on a live worker ends its own pane" \
    "$rc $(regst s-live) $(tmux -L default list-panes -a -F '#{pane_id}' | grep -cx "$live")" "0 done 0"
  tmux -L default kill-server 2>/dev/null; tmux -L hqterm kill-server 2>/dev/null
  unset TMUX_TMPDIR
fi

echo
# Review round 2 (lucy, hq-je3fk.5): a conflicting identity beats a matching path, and a
# git failure never reads as "nothing unmerged".
r2="$(cd "$REPO/ops/console" && WR="$(mktemp -d)" python3 - <<'PY'
import os, subprocess, tempfile, statelib as sl
out = []
row = {"id": "s-old", "kind": "worker", "tmux_window": "%9", "worktree": "/tmp/w"}
panes = {"%9": {"pid": 1, "dead": False, "path": "/tmp/w", "cmd": "bash"}}
sl._identity = lambda q: "s-new"
sl._tree = lambda pid, kids: {1}
sl._argv = lambda q: ["claude"]
out.append("conflict=" + sl.pane_status(row, panes, kids={1: []}))
d = tempfile.mkdtemp()
subprocess.run(["git", "init", "-q", d]); subprocess.run(["git", "-C", d, "commit", "-q", "--allow-empty", "-m", "a"])
os.environ["PATH"] = "/nonexistent"   # git cannot run at all
out.append("gitfail=" + str(sl.reconcile_row({"status": "active", "kind": "worker", "worktree": d}, "gone")))
print(" ".join(out))
PY
)"
case "$r2" in *"conflict=gone"*) ok "explicit other identity on a reused pane id reads gone";; *) bad "explicit other identity on a reused pane id reads gone: $r2";; esac
case "$r2" in *"gitfail=('finishable'"*) ok "git failure keeps a row finishable";; *) bad "git failure keeps a row finishable: $r2";; esac

# ---- orchestrator ask routing (docs/designs/2026-11-04-orchestrator.md section 1, hq-4npjr.1)
orch_fixture(){
  fresh
  OBL="$TMP/obell.log"; ONL="$TMP/onotify.log"
  printf '#!/usr/bin/env bash\necho "$1" >> %s\n' "$OBL" > "$TMP/obell"
  printf '#!/usr/bin/env bash\necho "$1|$2|$3" >> %s\n' "$ONL" > "$TMP/onotify"
  chmod +x "$TMP/obell" "$TMP/onotify"
  export HQ_BELL="$TMP/obell" HQ_NOTIFY="$TMP/onotify"; unset HQ_NO_BELL
  "$REG" register --id s-wk --kind worker --rig demo --worktree "$TMP/wt" \
    --branch b --bead bead-o --window w --model m --objectives "$TMP/obj.md" >/dev/null
  "$REG" register --id s-int --kind interactive --rig demo --worktree "$TMP/wt2" \
    --branch b2 --bead "" --window w2 --model m --objectives "$TMP/obj2.md" >/dev/null
  EVF="$HQ_STATE_DIR/orchestrator/events.jsonl"
}
olines(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
rfield(){ RID="$1" F="$2" python3 -c 'import json,os
r=[x for x in json.load(open(os.environ["WRD"]+"/requests.json")) if x["id"]==os.environ["RID"]][0]
print(r.get(os.environ["F"],""))'; }
backdate(){ RID="$1" S="$2" python3 -c 'import json,os,time
p=os.environ["WRD"]+"/requests.json"; d=json.load(open(p))
for r in d:
    if r["id"]==os.environ["RID"]: r["ts"]=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-int(os.environ["S"])))
json.dump(d,open(p,"w"))'; }
export WRD

orch_fixture; export HQ_ORCH=on
rid="$("$CTL" ask "which table?" --bead bead-o --session s-wk 2>"$TMP/oerr")"
ev="$(python3 -c 'import json,sys;e=json.loads(open(sys.argv[1]).readlines()[-1]);print(e["type"],e["rid"],e["bead"],e["session"],e["id"][:2])' "$EVF" 2>&1)"
[ -f "$HQ_STATE_DIR/orchestrator/pending" ] && ok "worker ask touches the runner's pending flag" || bad "worker ask touches the runner's pending flag"
check "worker ask goes to the orchestrator, writes its event, rings nobody" \
  "$(rfield "$rid" to) $(rfield "$rid" status) [$ev] $(olines "$OBL")" "orchestrator open [worker_ask $rid bead-o s-wk e-] 0"
grep -q "QUESTION FOR THE ORCHESTRATOR ($rid)" "$TMP/oerr" && ok "worker ask names the orchestrator in its terminal" || bad "worker ask names the orchestrator in its terminal"

r2="$("$CTL" ask "pick a color?" --session s-int 2>/dev/null)"
check "interactive ask still goes to the owner and rings" "$(rfield "$r2" to) $(olines "$OBL")" "owner 1"
r3="$("$CTL" ask "prod is down" --session s-wk --sev P0 2>/dev/null)"
r3b="$("$CTL" ask "prod is down 2" --session s-wk --urgent 2>/dev/null)"
check "P0 and urgent worker asks skip the orchestrator" "$(rfield "$r3" to) $(rfield "$r3b" to) $(olines "$ONL")" "owner owner 2"
r4="$("$CTL" ask "no session q" 2>/dev/null)"
check "an ask with no session goes to the owner" "$(rfield "$r4" to)" "owner"

# fail closed: no orchestrator, a cap hit, an event that does not land
orch_fixture; export HQ_ORCH=off
rid="$("$CTL" ask "q off" --session s-wk 2>/dev/null)"
check "missing orchestrator: worker ask goes to the owner and rings" "$(rfield "$rid" to) $(olines "$OBL") $(olines "$EVF")" "owner 1 0"
export HQ_ORCH=on
rid="$(HQ_ORCH_EVENTS=/proc/nonexistent/events.jsonl "$CTL" ask "q no event" --session s-wk 2>/dev/null)"
check "event write failure reroutes to the owner at once and rings" \
  "$(rfield "$rid" to) $(rfield "$rid" forward_class) $(rfield "$rid" status) $(olines "$OBL")" "owner unrouted open 2"
mkdir -p "$HQ_STATE_DIR/orchestrator/events.jsonl"
rid="$("$CTL" ask "q dir" --session s-wk 2>/dev/null)"
check "events path that is a directory reroutes to the owner" "$(rfield "$rid" to) $(rfield "$rid" forward_class)" "owner unrouted"
rmdir "$HQ_STATE_DIR/orchestrator/events.jsonl"
out="$(HQ_ORCH=auto PATH="$TMP/nosysd:$PATH" bash -c 'mkdir -p "$1"; printf "#!/bin/sh\nexit 3\n" > "$1/systemctl"; chmod +x "$1/systemctl"; "$2" ask "q auto" --session s-wk 2>/dev/null' _ "$TMP/nosysd" "$CTL")"
check "auto mode with the path unit inactive goes to the owner" "$(rfield "$out" to)" "owner"
# the path unit up, but the runner script it executes is missing: the owner, so no
# ask sits 10 minutes with nobody to read it (review round 1, notes 2 and 3)
mkdir -p "$TMP/yessysd"; printf '#!/bin/sh\ncase "$*" in *--user*is-active*hq-orchestrator.path*) exit 0;; esac; exit 3\n' > "$TMP/yessysd/systemctl"; chmod +x "$TMP/yessysd/systemctl"
out="$(HQ_ORCH=auto HQ_ORCH_RUNNER="$TMP/no-such-runner.sh" PATH="$TMP/yessysd:$PATH" "$CTL" ask "q auto no runner" --session s-wk 2>/dev/null)"
check "auto mode with the unit active but no runner script goes to the owner" "$(rfield "$out" to) $(rfield "$out" forward_class)" "owner "
printf '#!/bin/bash\n' > "$TMP/orch-runner.sh"
out="$(HQ_ORCH=auto HQ_ORCH_RUNNER="$TMP/orch-runner.sh" PATH="$TMP/yessysd:$PATH" "$CTL" ask "q auto up" --session s-wk 2>/dev/null)"
check "auto mode with the user path unit active and the runner present goes to the orchestrator" "$(rfield "$out" to)" "orchestrator"
out="$(HQ_ORCH=auto HQ_ORCH_RUNNER="$TMP/orch-runner.sh" PATH="$TMP/nosysd:$PATH" "$CTL" ask "q auto runner only" --session s-wk 2>/dev/null)"
check "auto mode with the runner present but the unit inactive goes to the owner" "$(rfield "$out" to)" "owner"

# console.sh ask (the path CLAUDE.md and the seed name) adds its own notify ping.
# It pings only when the request went to the owner (review round 1, blocker 1).
orch_fixture; export HQ_ORCH=on
: > "$ONL"
rid="$("$REPO/ops/scripts/console.sh" ask "Which table holds the data?" --bead bead-o --session s-wk 2>/dev/null | tail -1)"
check "console.sh worker ask to the orchestrator pings nobody" "$(rfield "$rid" to) $(olines "$OBL") $(olines "$ONL")" "orchestrator 0 0"
out="$("$REPO/ops/scripts/console.sh" ask "Which table now?" --bead bead-o --session s-wk --wait --chunk 1 2>/dev/null)"
check "console.sh --wait worker ask to the orchestrator pings nobody" "${out%% *} $(olines "$OBL") $(olines "$ONL")" "WAITING 0 0"
rid="$(HQ_ORCH_EVENTS=/proc/nonexistent/events.jsonl "$REPO/ops/scripts/console.sh" ask "Which table, no event?" --bead bead-o --session s-wk 2>/dev/null | tail -1)"
check "console.sh worker ask rerouted to the owner still pings once" \
  "$(rfield "$rid" to) $(olines "$OBL") $(cut -d'|' -f1,2 "$ONL")" "owner 1 default|Console: question waiting"
: > "$ONL"
rid="$("$REPO/ops/scripts/console.sh" ask "Pick a color?" --session s-int 2>/dev/null | tail -1)"
check "console.sh interactive ask still pings the owner" "$(rfield "$rid" to) $(cut -d'|' -f1,2 "$ONL")" "owner default|Console: question waiting"
: > "$ONL"
out="$("$REPO/ops/scripts/console.sh" ask "Pick a size?" --session s-int --wait --chunk 1 2>/dev/null)"
check "console.sh --wait interactive ask still pings the owner" "${out%% *} $(cut -d'|' -f1,2 "$ONL")" "WAITING default|Console: question waiting"

# forward verb
orch_fixture; export HQ_ORCH=on
rid="$("$CTL" ask "which vendor?" --bead bead-o --session s-wk 2>/dev/null)"
"$CTL" forward "$rid" >/dev/null 2>&1; e1=$?
"$CTL" forward "$rid" --class whim >/dev/null 2>&1; e2=$?
check "forward refuses with no class or a bad class, and changes nothing" "$e1 $e2 $(rfield "$rid" to) $(olines "$OBL")" "2 2 orchestrator 0"
out="$("$CTL" forward "$rid" --class business --note "pricing call")"
check "forward hands the ask to the owner with its class and rings him" \
  "$out|$(rfield "$rid" to) $(rfield "$rid" forward_class) $(rfield "$rid" forwarded_by) $(rfield "$rid" status)|$(head -1 "$OBL")" \
  "forwarded $rid to the owner (business)|owner business orchestrator open|needs you: [bead-o] which vendor?"
"$CTL" forward "$rid" --class taste >/dev/null 2>&1; e3=$?
r2="$("$CTL" ask "owner q" --session s-int 2>/dev/null)"
"$CTL" forward "$r2" --class taste >/dev/null 2>&1; e4=$?
check "forward refuses a request already with the owner" "$e3 $e4" "3 3"

# the orchestrator answers with the normal answer verb; the worker collects it
r5="$("$CTL" ask "default branch?" --session s-wk 2>/dev/null)"
"$CTL" answer "$r5" "main, per the rig table" >/dev/null 2>&1
out="$("$CTL" await "$r5" --chunk 3)"; rc=$?
check "orchestrator answer reaches the worker through await" "$rc ${out##*$'\n'} $(rfield "$r5" to)" "0 main, per the rig table orchestrator"

# 10-minute fallback
orch_fixture; export HQ_ORCH=on
rid="$("$CTL" ask "stuck q" --bead bead-o --session s-wk 2>/dev/null)"
fresh_r="$("$CTL" ask "fresh q" --session s-wk 2>/dev/null)"
done_r="$("$CTL" ask "answered q" --session s-wk 2>/dev/null)"
"$CTL" answer "$done_r" "ok" >/dev/null 2>&1
backdate "$rid" 601; backdate "$done_r" 601
out="$("$CTL" orch-sweep)"
check "sweep forwards only an open orchestrator ask past 10 minutes, and rings" \
  "$out|$(rfield "$rid" to) $(rfield "$rid" forward_class) $(rfield "$rid" forwarded_by)|$(rfield "$fresh_r" to)|$(rfield "$done_r" to)|$(olines "$OBL")" \
  "forwarded $rid to the owner (timeout)|owner timeout fallback|orchestrator|orchestrator|1"
check "a second sweep forwards nothing" "$("$CTL" orch-sweep) $(olines "$OBL")" "nothing due 1"
backdate "$fresh_r" 5000
"$CTL" req-sla-sweep >/dev/null
check "the SLA sweep leaves orchestrator asks to the fallback" "$(rfield "$fresh_r" sla_escalations)" ""
"$CTL" state >/dev/null 2>&1
check "a state compile runs the fallback" "$(rfield "$fresh_r" to) $(rfield "$fresh_r" forward_class)" "owner timeout"
r6="$("$CTL" ask "waiting q" --session s-wk 2>/dev/null)"
out="$(HQ_ORCH_FALLBACK_S=0 "$CTL" await "$r6" --chunk 2)"
check "a waiting worker's loop runs the fallback with no console open" "$out $(rfield "$r6" to)" "WAITING $r6 owner"

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
