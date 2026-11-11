#!/usr/bin/env bash
# Fixture tests for finish.sh — temp HQ + throwaway git rigs + fake `bd`.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
FINISH="$DIR/../scripts/finish.sh"
SPAWN="$DIR/../scripts/spawn.sh"
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }
st(){ "$REGSH" get "$1" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null; }

unset DRIFT_RIG_OVERRIDE HQ_DRIFT_BLOCK HQ_DRIFT_CHECK HQ_DIR
export HQ_ROOT="$(mktemp -d)"
export HQ_STATE_DIR="$HQ_ROOT/state"
export HQ_NO_TMUX=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
trap 'rm -rf "$HQ_ROOT"' EXIT

# fake bd: `show` prints a Verification line iff FAKE_RECEIPT=1 (default); `close` succeeds.
FAKE="$HQ_ROOT/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/bd" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  show)  echo "bead $2"
         [ "${FAKE_RECEIPT:-1}" = 1 ] && echo "Verification: code — pytest — PASS" || echo "no receipt" ;;
  close) exit 0 ;;
  *)     exit 0 ;;
esac
EOF
chmod +x "$FAKE/bd"
export HQ_BD="$FAKE/bd"

mkrig(){ mkdir -p "$HQ_ROOT/rigs/$1"; git -C "$HQ_ROOT/rigs/$1" init -q
  printf base > "$HQ_ROOT/rigs/$1/f"; git -C "$HQ_ROOT/rigs/$1" add -A
  git -C "$HQ_ROOT/rigs/$1" commit -qm base; }

# --- dry mode: prints plan, mutates nothing irreversible ---
mkrig r1
id1="$("$SPAWN" r1 "task one" --worker --dry-run | tail -1)"
wt1="$HQ_ROOT/rigs/r1-${id1#s-}"
out="$("$FINISH" "$id1")"
echo "$out" | grep -q "finish-plan for $id1" && ok "dry prints plan" || no "dry prints plan" "$out"
eq "dry leaves session active" "$(st "$id1")" "active"
[ -d "$wt1" ] && ok "dry keeps worktree" || no "dry keeps worktree"

# --- confirm happy path: clean merge + receipt -> merged, removed, deregistered ---
mkrig r2
id2="$("$SPAWN" r2 "task two" --worker --dry-run | tail -1)"
wt2="$HQ_ROOT/rigs/r2-${id2#s-}"
printf changed > "$wt2/newfile"   # uncommitted -> finish commits it
FAKE_RECEIPT=1 "$FINISH" "$id2" --confirm >/dev/null
[ ! -d "$wt2" ] && ok "happy: worktree removed" || no "happy: worktree removed"
"$REGSH" get "$id2" >/dev/null 2>&1; [ "$?" = 1 ] && ok "happy: deregistered" || no "happy: deregistered"

# --- confirm no receipt: merged but not closed -> finishable, worktree removed, entry kept ---
mkrig r3
id3="$("$SPAWN" r3 "task three" --worker --dry-run | tail -1)"
wt3="$HQ_ROOT/rigs/r3-${id3#s-}"
printf x > "$wt3/newfile"
FAKE_RECEIPT=0 "$FINISH" "$id3" --confirm >/dev/null
eq "no-receipt: finishable" "$(st "$id3")" "finishable"
[ ! -d "$wt3" ] && ok "no-receipt: worktree removed (merged)" || no "no-receipt: worktree removed"

# --- confirm conflict: divergent branch -> not merged, worktree kept, finishable, not closed ---
mkrig r4
id4="$("$SPAWN" r4 "task four" --worker --dry-run | tail -1)"
wt4="$HQ_ROOT/rigs/r4-${id4#s-}"
printf branchside > "$wt4/f"; git -C "$wt4" add -A; git -C "$wt4" commit -qm branchside
printf defaultside > "$HQ_ROOT/rigs/r4/f"; git -C "$HQ_ROOT/rigs/r4" add -A; git -C "$HQ_ROOT/rigs/r4" commit -qm defaultside
FAKE_RECEIPT=1 "$FINISH" "$id4" --confirm >/dev/null
eq "conflict: finishable" "$(st "$id4")" "finishable"
[ -d "$wt4" ] && ok "conflict: worktree kept" || no "conflict: worktree kept"

# --- orchestrator events (hq-4npjr.3): merged branches emit merge_done, a conflict emits nothing ---
EV="$HQ_STATE_DIR/orchestrator/events.jsonl"
eq "events: one merge_done per merged branch (happy + no-receipt)" "$(grep -c '"type": "merge_done"' "$EV" 2>/dev/null)" "2"
grep -q "$id2" "$EV" && ok "events: merge_done names the session" || no "events: merge_done names the session"
grep -q "$id4" "$EV" && no "events: conflict emitted an event" || ok "events: a conflicted merge emits nothing"
# fail-open: an unwritable events dir never breaks a merge
mkrig r4b
id4b="$("$SPAWN" r4b "task four b" --worker --dry-run | tail -1)"
wt4b="$HQ_ROOT/rigs/r4b-${id4b#s-}"; printf z > "$wt4b/newfile"
HQ_EVENTS_FILE=/proc/nope/events.jsonl FAKE_RECEIPT=1 "$FINISH" "$id4b" --confirm >/dev/null 2>&1; eq "events: unwritable events file, finish still exits 0" "$?" "0"
[ ! -d "$wt4b" ] && ok "events: merge completed despite emit failure" || no "events: merge completed despite emit failure"

# --- drift gate (hq-fgg3.1): decided BEFORE the merge on a throwaway preview ---
# Fake drift-check: call 1 runs at the default tip, call 2 at the would-be merge
# result. Each call logs whether DRIFT_RIG_OVERRIDE's tree holds the branch's
# file, which proves the two runs saw the two different trees. FAKE_DRIFT_UNKNOWN_*
# marks a check as could-not-check in that run.
cat > "$FAKE/drift-check" <<'EOF'
#!/usr/bin/env bash
n=$(( $(cat "$FAKE_DRIFT_COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DRIFT_COUNT"
tree="${DRIFT_RIG_OVERRIDE#*=}"
[ -e "$tree/drift-branch-file" ] && echo "call$n has-branch-file" >> "$FAKE_DRIFT_LOG" || echo "call$n no-branch-file" >> "$FAKE_DRIFT_LOG"
if [ "$n" = 1 ]; then ids="$FAKE_DRIFT_BEFORE"; unk="${FAKE_DRIFT_UNKNOWN_BEFORE:-}"; else ids="$FAKE_DRIFT_AFTER"; unk="${FAKE_DRIFT_UNKNOWN_AFTER:-}"; fi
# another terminal commits to the rig default branch while the gate runs
if [ "$n" = 2 ] && [ -n "${FAKE_DRIFT_CONCURRENT:-}" ]; then
  echo other > "$FAKE_DRIFT_CONCURRENT/concurrent"; git -C "$FAKE_DRIFT_CONCURRENT" add concurrent
  git -C "$FAKE_DRIFT_CONCURRENT" commit -qm CONCURRENT-WORK
fi
python3 -c 'import json,sys
ids=[i for i in sys.argv[1].split(",") if i]; unk=[u for u in sys.argv[2].split(",") if u]
print(json.dumps({"checks":["units","tmux","switches","coverage"],"items":[{"id":i,"check":i.split(":")[0],"detail":"d"} for i in ids],
                  "unknown":[{"check":u,"detail":"hiccup"} for u in unk],"clean":not ids}))' "$ids" "$unk"
[ -z "$ids" ]
EOF
chmod +x "$FAKE/drift-check"
export HQ_DRIFT_CHECK="$FAKE/drift-check"
drift_case(){  # <rig> <before> <after> [env...]: prints "<exit> <merged 0|1> <default-unchanged 0|1> <sid>"
  local rig="$1" before="$2" after="$3"; shift 3
  mkrig "$rig"
  local sid wt; sid="$("$SPAWN" "$rig" "drift $rig" --worker --dry-run | tail -1)"
  wt="$HQ_ROOT/rigs/$rig-${sid#s-}"
  printf x > "$wt/drift-branch-file"; [ -n "${DRIFT_EXTRA:-}" ] && printf y > "$wt/$DRIFT_EXTRA"
  git -C "$wt" add -A; git -C "$wt" commit -qm work
  local tip pre; tip="$(git -C "$wt" rev-parse HEAD)"; pre="$(git -C "$HQ_ROOT/rigs/$rig" rev-parse HEAD)"
  rm -f "$HQ_ROOT/drift-count" "$HQ_ROOT/drift-log"
  env FAKE_DRIFT_COUNT="$HQ_ROOT/drift-count" FAKE_DRIFT_LOG="$HQ_ROOT/drift-log" \
      FAKE_DRIFT_BEFORE="$before" FAKE_DRIFT_AFTER="$after" \
      FAKE_RECEIPT=1 "$@" "$FINISH" "$sid" --confirm >/dev/null 2>&1
  local rc=$? m=0 same=0
  git -C "$HQ_ROOT/rigs/$rig" merge-base --is-ancestor "$tip" HEAD && m=1
  [ "$(git -C "$HQ_ROOT/rigs/$rig" rev-parse HEAD)" = "$pre" ] && same=1
  # never reset: the old default tip is always still in the default branch
  git -C "$HQ_ROOT/rigs/$rig" merge-base --is-ancestor "$pre" HEAD || same=reset
  echo "$rc $m $same $sid"
}
set -- $(drift_case r5 "units:a:x,tmux:b:y" "units:a:x,tmux:b:y")
eq "drift: pre-existing drift does not block (exit)" "$1" "0"
eq "drift: pre-existing drift does not block (merged)" "$2" "1"
eq "drift: run 1 saw the default tip, run 2 the merge result" "$(tr '\n' ' ' < "$HQ_ROOT/drift-log")" "call1 no-branch-file call2 has-branch-file "
eq "drift: the preview worktree is cleaned up" "$(git -C "$HQ_ROOT/rigs/r5" worktree list | grep -c finish-drift)" "0"
set -- $(drift_case r6 "units:a:x" "units:a:x,switches:ops/mail/LOG_ONLY:on-undeclared")
eq "drift: new drift refuses (exit 5)" "$1" "5"
eq "drift: refused merge did not merge" "$2" "0"
eq "drift: refused merge leaves the default branch SHA unchanged" "$3" "1"
eq "drift: refused merge leaves session finishable" "$(st "$4")" "finishable"
[ -d "$HQ_ROOT/rigs/r6-${4#s-}" ] && ok "drift: refused merge keeps the worktree" || no "drift: refused merge keeps the worktree"
eq "drift: refused merge leaves no preview worktree" "$(git -C "$HQ_ROOT/rigs/r6" worktree list | grep -c finish-drift)" "0"
set -- $(drift_case r7 "" "units:new:x" HQ_DRIFT_BLOCK=0)
eq "drift: HQ_DRIFT_BLOCK=0 accepts new drift (exit)" "$1" "0"
eq "drift: HQ_DRIFT_BLOCK=0 keeps the merge" "$2" "1"
set -- $(drift_case r8 "units:a:x" "")
eq "drift: drift that went away does not block" "$1" "0"
eq "drift: a merge never resets the default branch" "$3" "0"
set -- $(drift_case r9 "units:a:x" "units:a:x,units:b:y" FAKE_DRIFT_UNKNOWN_BEFORE=units)
eq "drift: a check that could not run in one run is not compared" "$1" "0"
set -- $(drift_case r10 "" "tmux:hq:sync:missing" FAKE_DRIFT_UNKNOWN_AFTER=units)
eq "drift: other checks still compared when one could not run" "$1" "5"
# regression (review round 1, repro-concurrent.sh): a commit landing on the
# default branch while the gate runs is never reset away, refused or not
set -- $(drift_case r13 "" "units:new:x" FAKE_DRIFT_CONCURRENT="$HQ_ROOT/rigs/r13")
eq "drift: refused with a concurrent commit (exit 5)" "$1" "5"
eq "drift: the concurrent commit is still the default tip" "$(git -C "$HQ_ROOT/rigs/r13" log -1 --format=%s)" "CONCURRENT-WORK"
set -- $(drift_case r14 "" "" FAKE_DRIFT_CONCURRENT="$HQ_ROOT/rigs/r14")
eq "drift: merged with a concurrent commit (exit 0)" "$1" "0"
git -C "$HQ_ROOT/rigs/r14" log --format=%s | grep -qx CONCURRENT-WORK && ok "drift: the concurrent commit survives the merge" || no "drift: the concurrent commit survives the merge"
# regression (repro-unknown.sh): coverage could not run before, so an
# after-run coverage item is not blamed on the merge
set -- $(drift_case r15 "" "coverage:gym-tracker:gap-owner-closed" FAKE_DRIFT_UNKNOWN_BEFORE=coverage)
eq "drift: unknown-before check never yields a new item" "$1" "0"

# path gating: with a manifest present, a rig merge runs the gate only when it
# touches a coverage.json evidence file inside that rig
mkdir -p "$HQ_ROOT/ops/config" "$HQ_ROOT/ops/mail"
echo '{"units": [], "gate_paths": ["ops/services/*"]}' > "$HQ_ROOT/ops/config/runtime.json"
echo '{"projects": {"r12": {"status": "wired", "evidence": "rigs/r12/report.sh"}, "r11": {"status": "wired", "evidence": "rigs/r11/report.sh"}}}' > "$HQ_ROOT/ops/mail/coverage.json"
set -- $(drift_case r11 "" "units:new:x")
eq "drift: a merge touching nothing drift-check reads skips the gate" "$1" "0"
[ ! -e "$HQ_ROOT/drift-count" ] && ok "drift: skipped gate never ran drift-check" || no "drift: skipped gate never ran drift-check"
set -- $(DRIFT_EXTRA=report.sh drift_case r12 "" "units:new:x")
eq "drift: a merge touching coverage evidence runs the gate" "$1" "5"
rm -rf "$HQ_ROOT/ops"
unset HQ_DRIFT_CHECK

# hq-repo merge with the REAL checker (hq-fgg3.17 finding 1). The merge target
# is the hq repo itself (rigs/hq is a symlink to it), so the gate must judge
# the preview tree, not the live checkout twice. systemctl, tmux and crontab
# are shimmed to fail, so those checks are could-not-check in both runs and
# left out: the fixture exercises hooks and switches only.
HQ1="$HQ_ROOT"
H="$(mktemp -d)"; trap 'rm -rf "$HQ1" "$H"' EXIT
mkdir -p "$H/bin" "$H/hq/ops/config" "$H/hq/ops/scripts" "$H/hq/ops/mail" "$H/hq/.claude" "$H/hq/rigs" "$H/hq/state"
for t in systemctl tmux crontab; do printf '#!/bin/sh\necho "shim: broken" >&2\nexit 1\n' > "$H/bin/$t"; chmod +x "$H/bin/$t"; done
cat > "$H/hq/ops/config/runtime.json" <<'EOF'
{"units": [], "gate_paths": ["ops/config/runtime.json", "ops/scripts/hook-*.sh", ".claude/settings.json"],
 "hooks_unwired": {}, "cron": [], "claims": [],
 "switches": {"ops/mail/LOG_ONLY": {"what": "log only", "owner": "hq-mail", "on": null},
              "ops/flags/TRACKED_SW": {"what": "a tracked switch", "owner": "hq-mail",
                                       "on": {"since": "2026-10-01", "expires": "2099-01-01", "owner": "hq-mail"}}},
 "switch_scan": {"roots": ["ops"], "max_depth": 3}}
EOF
printf '#!/bin/sh\nexit 0\n' > "$H/hq/ops/scripts/hook-x.sh"; chmod +x "$H/hq/ops/scripts/hook-x.sh"
echo '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "$CLAUDE_PROJECT_DIR/ops/scripts/hook-x.sh"}]}]}}' > "$H/hq/.claude/settings.json"
printf 'rigs/\nstate/\n.claude/worktrees/\nops/mail/LOG_ONLY\n' > "$H/hq/.gitignore"
mkdir -p "$H/hq/ops/flags"; touch "$H/hq/ops/flags/TRACKED_SW"   # committed: a TRACKED switch, on
git -C "$H/hq" init -q -b main && git -C "$H/hq" add -A && git -C "$H/hq" commit -qm base
ln -s "$H/hq" "$H/hq/rigs/hq"
hq_case(){  # <setup-fn>: prints "<exit> <merged 0|1> <gate seconds>"
  local sid wt tip
  sid="$(HQ_ROOT="$H/hq" HQ_STATE_DIR="$H/hq/state" "$SPAWN" hq "hq $1" --worker --dry-run | tail -1)"
  # spawn.sh puts hq worktrees under .claude/worktrees (not rigs/); a wrong
  # path here edits nothing, the branch is empty and the gate skips (hq-enczq)
  wt="$H/hq/.claude/worktrees/hq-${sid#s-}"
  [ -d "$wt" ] || { echo "hq_case: no worktree at $wt" >&2; echo "99 9"; return; }
  "$1" "$wt"; git -C "$wt" add -A; git -C "$wt" commit -qm "$1"
  tip="$(git -C "$wt" rev-parse HEAD)"
  env -u HQ_DRIFT_CHECK -u DRIFT_LIVE_ROOT HQ_ROOT="$H/hq" HQ_STATE_DIR="$H/hq/state" PATH="$H/bin:$PATH" \
      DRIFT_USER_SETTINGS="$H/none.json" DRIFT_BD="" FAKE_RECEIPT=1 \
      "$FINISH" "$sid" --confirm >/dev/null 2>"$H/err"
  local rc=$? m=0
  git -C "$H/hq" merge-base --is-ancestor "$tip" main && m=1
  echo "$rc $m $(sed -n 's/^finish: drift gate took \([0-9]*\)s/\1/p' "$H/err")"
}
del_hook(){ git -C "$1" rm -q ops/scripts/hook-x.sh; }
set -- $(hq_case del_hook)
eq "drift hq: the gate judges the preview tree, so deleting a wired hook refuses (exit)" "$1" "5"
eq "drift hq: the refused hq merge did not merge" "$2" "0"
[ -x "$H/hq/ops/scripts/hook-x.sh" ] && ok "drift hq: the live checkout is untouched" || no "drift hq: the live checkout is untouched"
grep -q 'hooks:hook-x.sh:missing' "$H/err" && ok "drift hq: the refusal names the new item" || no "drift hq: refusal names item" "$(tail -3 "$H/err")"
grep -q 'install it from the branch, then re-run finish.sh' "$H/err" && grep -q 'HQ_DRIFT_BLOCK=0' "$H/err" \
  && ok "drift hq: the refusal says install then re-run, and names HQ_DRIFT_BLOCK=0" || no "drift hq: refusal text" "$(tail -1 "$H/err")"
# review round 1 (lucy): a TRACKED switch file the merge deletes must not be
# resurrected by its live (pre-merge) copy. Deleting it but keeping the on
# record is drift (stale-on-record); deleting it and clearing the record is not.
del_sw_keep(){ git -C "$1" rm -q ops/flags/TRACKED_SW; }
set -- $(hq_case del_sw_keep)
eq "drift hq: deleting a tracked switch but keeping its on record refuses" "$1" "5"
grep -q 'switches:ops/flags/TRACKED_SW:stale-on-record' "$H/err" && ok "drift hq: it is named stale-on-record" || no "drift hq: stale-on-record named" "$(tail -3 "$H/err")"
del_sw_clear(){ git -C "$1" rm -q ops/flags/TRACKED_SW; python3 - "$1/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["switches"]["ops/flags/TRACKED_SW"]["on"] = None
json.dump(d, open(p, "w"))
EOF
}
set -- $(hq_case del_sw_clear)
eq "drift hq: deleting a tracked switch and clearing its record merges (exit)" "$1" "0"
eq "drift hq: the switch-off merge merged" "$2" "1"
# A live, gitignored switch file stays visible to both runs: a branch that
# records it as on must not look like new drift (stale-on-record).
touch "$H/hq/ops/mail/LOG_ONLY"
rec_switch(){ python3 - "$1/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["switches"]["ops/mail/LOG_ONLY"]["on"] = {"since": "2026-10-01", "expires": "2099-01-01", "owner": "hq-mail"}
json.dump(d, open(p, "w"))
EOF
}
set -- $(hq_case rec_switch)
eq "drift hq: live state still counts, recording a live switch merges (exit)" "$1" "0"
eq "drift hq: recording a live switch merged" "$2" "1"
grep -q 'drift gate runs' "$H/err" && ok "drift hq: the gate actually ran for the switch merge" || no "drift hq: gate ran" "$(tail -3 "$H/err")"
# review round 2 (Opus): a MOVE out of the watched paths must still run the
# gate. With rename detection, diff --name-only lists only the new path
# (docs/...), which is not gate-relevant, so the gate was skipped and the
# wired hook silently went missing.
mv_hook(){ mkdir -p "$1/docs"; git -C "$1" mv ops/scripts/hook-x.sh docs/hook-x.sh.old; }
set -- $(hq_case mv_hook)
eq "drift hq: moving a wired hook out of the watched paths refuses (exit)" "$1" "5"
grep -q 'hooks:hook-x.sh:missing' "$H/err" && ok "drift hq: the moved hook is named missing" || no "drift hq: moved hook named" "$(tail -3 "$H/err")"
export HQ_ROOT="$HQ1" HQ_STATE_DIR="$HQ1/state"

# --- hq-1nkg.7: per-session launcher files are removed on finish and by the reaper ---
REAP="$DIR/../scripts/reap-worktrees.sh"
mkrig r20
id20="$("$SPAWN" r20 "task twenty" --worker --dry-run | tail -1)"
wt20="$HQ_ROOT/rigs/r20-${id20#s-}"
printf x > "$wt20/newfile"
mkdir -p "$HQ_STATE_DIR"
touch "$HQ_STATE_DIR/launch-$id20.sh" "$HQ_STATE_DIR/launch-$id20-wake.sh" "$HQ_STATE_DIR/wake-$id20.lock"
mkrig r21
id21="$("$SPAWN" r21 "task twenty-one" --worker --dry-run | tail -1)"
touch "$HQ_STATE_DIR/launch-$id21.sh"
FAKE_RECEIPT=1 "$FINISH" "$id20" --confirm >/dev/null
[ ! -e "$HQ_STATE_DIR/launch-$id20.sh" ] && [ ! -e "$HQ_STATE_DIR/launch-$id20-wake.sh" ] \
  && [ ! -e "$HQ_STATE_DIR/wake-$id20.lock" ] \
  && ok "finish: removes the session's launch files and wake lock" || no "finish: removes the session's launch files"
[ -e "$HQ_STATE_DIR/launch-$id21.sh" ] && ok "finish: keeps another active session's launch file" || no "finish: keeps other launch file"
# no receipt -> finishable -> launch files stay for a revive
mkrig r22
id22="$("$SPAWN" r22 "task 22" --worker --dry-run | tail -1)"
printf x > "$HQ_ROOT/rigs/r22-${id22#s-}/newfile"; touch "$HQ_STATE_DIR/launch-$id22.sh" "$HQ_STATE_DIR/wake-$id22.lock"
FAKE_RECEIPT=0 "$FINISH" "$id22" --confirm >/dev/null
[ -e "$HQ_STATE_DIR/launch-$id22.sh" ] && [ -e "$HQ_STATE_DIR/wake-$id22.lock" ] && ok "finish: finishable session keeps its launch file" || no "finish: finishable keeps launch file"

# reaper: done and unregistered sessions lose their files, active ones keep them
"$REGSH" register --id s-rlive --window hq:rlive >/dev/null
"$REGSH" register --id s-rdone --window hq:rdone >/dev/null
"$REGSH" update s-rdone --status done >/dev/null
for n in s-rlive s-rdone s-rorphan; do touch "$HQ_STATE_DIR/launch-$n.sh" "$HQ_STATE_DIR/launch-$n-wake.sh" "$HQ_STATE_DIR/wake-$n.lock"; done
touch "$HQ_STATE_DIR/wake-s-rfresh.lock"
touch "$HQ_STATE_DIR/touched-new-uuid"; touch -d '30 days ago' "$HQ_STATE_DIR/touched-old-uuid"
# launch files younger than 10 minutes survive (spawn.sh writes them before registering); age the rest
touch "$HQ_STATE_DIR/launch-s-rfresh.sh"
for lf in "$HQ_STATE_DIR"/launch-*.sh "$HQ_STATE_DIR"/wake-*.lock; do [ "$lf" = "$HQ_STATE_DIR/wake-s-rfresh.lock" ] && continue; [ "$lf" = "$HQ_STATE_DIR/launch-s-rfresh.sh" ] || touch -d '1 hour ago' "$lf"; done
HQ_TMUX_WINDOWS="hq:rlive" "$REAP" --out "$HQ_ROOT/reap-dry.txt" >/dev/null
[ -e "$HQ_STATE_DIR/launch-s-rdone.sh" ] && ok "reaper dry run removes nothing" || no "reaper dry run removes nothing"
HQ_TMUX_WINDOWS="hq:rlive" "$REAP" --apply --out "$HQ_ROOT/reap.txt" >/dev/null
[ ! -e "$HQ_STATE_DIR/launch-s-rdone.sh" ] && [ ! -e "$HQ_STATE_DIR/launch-s-rdone-wake.sh" ] \
  && [ ! -e "$HQ_STATE_DIR/wake-s-rdone.lock" ] && [ ! -e "$HQ_STATE_DIR/wake-s-rorphan.lock" ] \
  && ok "reaper: done and orphan sessions' launch files and wake locks removed" || no "reaper: done session's launch files and wake lock removed"
[ ! -e "$HQ_STATE_DIR/launch-s-rorphan.sh" ] && ok "reaper: unregistered session's launch file removed" || no "reaper: orphan removed"
[ -e "$HQ_STATE_DIR/launch-s-rlive.sh" ] && [ -e "$HQ_STATE_DIR/launch-s-rlive-wake.sh" ] \
  && [ -e "$HQ_STATE_DIR/wake-s-rlive.lock" ] && [ -e "$HQ_STATE_DIR/wake-s-rfresh.lock" ] \
  && ok "reaper: active session's launch files and fresh wake lock kept" || no "reaper: active session's launch files kept"
[ -e "$HQ_STATE_DIR/launch-s-rfresh.sh" ] && ok "reaper: fresh unregistered launch file kept" || no "reaper: fresh launch file kept"
# id21 had a clean merged worktree and no live pane, so the reaper closed its row this run
[ ! -e "$HQ_STATE_DIR/launch-$id21.sh" ] && ok "reaper: reaped session launch file removed" || no "reaper: reaped session file"
[ ! -e "$HQ_STATE_DIR/touched-old-uuid" ] && [ -e "$HQ_STATE_DIR/touched-new-uuid" ] \
  && ok "reaper: idle touched file removed, fresh one kept" || no "reaper: touched files"

# --- ambiguous resolve: no id + multiple active -> error exit 2 ---
"$REGSH" register --id s-x1 --window hq:x1 >/dev/null
"$REGSH" register --id s-x2 --window hq:x2 >/dev/null
"$FINISH" >/dev/null 2>&1; [ "$?" = 2 ] && ok "ambiguous resolve errors" || no "ambiguous resolve errors"

[ "$fail" = 0 ] && echo "FINISH TESTS: PASS" || { echo "FINISH TESTS: FAIL"; exit 1; }
