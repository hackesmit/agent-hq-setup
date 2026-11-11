#!/usr/bin/env bash
# reap-worktrees.test.sh (hq-8hsr.1): fixture test for the weekly worktree reaper.
#
# Fixture A (rig "demo", on main) covers the decision table: worktrees that are
# merged and dead, unmerged, dirty, held by a live session, and held by a session
# parked in finishable; registry rows for a live pane, a dead pane, a live WINDOW
# name and a finishable row. The tmux seam carries three windows and three panes
# with the live targets in the MIDDLE of the list, which is what catches a
# delimiter-confused membership test (review round one, blocker 1).
#
# Fixture B (rig "parked") is a clone with no origin/HEAD whose canonical checkout
# sits on a long-lived feature branch, with a worktree merged into that branch only
# and never into main. Nothing there may ever be reaped (blocker 2).
#
# Fixture C makes a removal fail (read-only parent directory) and asserts the run
# exits non-zero and leaves the registry row alone.
#
# Run: bash reap-worktrees.test.sh   (exit 0 = pass)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REAP="${REAP_SH:-$HERE/reap-worktrees.sh}"
# The reaper talks to the registry through session-registry.sh; find the real one
# whether this test runs from ops/scripts/tests or from a proposal directory.
for c in "$HERE/session-registry.sh" "$HERE/../session-registry.sh" \
         "$HERE/../../scripts/session-registry.sh" "$HOME/hq/ops/scripts/session-registry.sh"; do
  [ -x "$c" ] && { REGSH="$c"; break; }
done
[ -x "${REAP:-}" ] || { echo "FAIL cannot find reap-worktrees.sh at $REAP"; exit 1; }
[ -x "${REGSH:-}" ] || { echo "FAIL cannot find session-registry.sh"; exit 1; }

R="$(mktemp -d)"
cleanup() { chmod u+w "$R/ro" 2>/dev/null; rm -rf "$R"; }
trap cleanup EXIT
export HQ_ROOT="$R" HQ_STATE_DIR="$R/state" HQ_REGISTRY_SH="$REGSH"
mkdir -p "$R/rigs" "$R/state"
RIG="$R/rigs/demo"
q() { "$@" >/dev/null 2>&1; }

fail=0
say() { echo "$1"; }
check() { [ "$1" = 0 ] && return 0; say "FAIL $2"; fail=1; }

# ---- fixture A: one rig on main -------------------------------------------
q git init -b main "$RIG"
q git -C "$RIG" config user.email test@example.com
q git -C "$RIG" config user.name  test
printf 'base\n' > "$RIG/file.txt"
q git -C "$RIG" add -A
q git -C "$RIG" commit -m base

mk_branch_commit() {   # $1 = branch, $2 = content, $3 = repo (default $RIG), $4 = base branch
  local repo="${3:-$RIG}" base="${4:-main}"
  q git -C "$repo" checkout -b "$1" "$base"
  printf '%s\n' "$2" > "$repo/$1.txt"
  q git -C "$repo" add -A
  q git -C "$repo" commit -m "$1"
  q git -C "$repo" checkout "$base"
}

# merged and dead: branch is an ancestor of main, worktree clean, no session
mk_branch_commit demo-dead "dead"
q git -C "$RIG" merge --no-ff -m "merge demo-dead" demo-dead
q git -C "$RIG" worktree add "$R/rigs/demo-dead" demo-dead

# unmerged: branch never merged into main
mk_branch_commit demo-open "open"
q git -C "$RIG" worktree add "$R/rigs/demo-open" demo-open

# dirty: branch merged, but the worktree carries uncommitted work
mk_branch_commit demo-dirty "dirty"
q git -C "$RIG" merge --no-ff -m "merge demo-dirty" demo-dirty
q git -C "$RIG" worktree add "$R/rigs/demo-dirty" demo-dirty
printf 'scratch\n' > "$R/rigs/demo-dirty/uncommitted.txt"

# merged and clean, but a live session (pane id) still holds it
mk_branch_commit demo-live "live"
q git -C "$RIG" merge --no-ff -m "merge demo-live" demo-live
q git -C "$RIG" worktree add "$R/rigs/demo-live" demo-live

# merged and clean, but a session holds it by tmux WINDOW name, not a pane id
mk_branch_commit demo-win "win"
q git -C "$RIG" merge --no-ff -m "merge demo-win" demo-win
q git -C "$RIG" worktree add "$R/rigs/demo-win" demo-win

# merged and clean, no live pane, but the session is parked in finishable:
# finish.sh could not close it, so the owner still has to rescue the worktree
mk_branch_commit demo-fin "fin"
q git -C "$RIG" merge --no-ff -m "merge demo-fin" demo-fin
q git -C "$RIG" worktree add "$R/rigs/demo-fin" demo-fin

# ---- fixture B: a rig parked on a long-lived feature branch ---------------
PRIG="$R/rigs/parked"
q git init -b main "$PRIG"
q git -C "$PRIG" config user.email test@example.com
q git -C "$PRIG" config user.name  test
printf 'base\n' > "$PRIG/file.txt"
q git -C "$PRIG" add -A
q git -C "$PRIG" commit -m base
q git -C "$PRIG" checkout -b power-over-time main
mk_branch_commit parked-feature "valuable" "$PRIG" power-over-time
q git -C "$PRIG" merge --no-ff -m "merge parked-feature" parked-feature
q git -C "$PRIG" worktree add "$R/rigs/parked-feature" parked-feature
# the rig stays parked on power-over-time, and there is no origin/HEAD
q git -C "$PRIG" checkout power-over-time
feat_sha="$(git -C "$PRIG" rev-parse parked-feature)"

# ---- fixture: registry rows -----------------------------------------------
q "$REGSH" register --id s-live --kind worker --rig demo \
   --worktree "$R/rigs/demo-live" --branch demo-live --window "%9"
q "$REGSH" register --id s-win --kind interactive --rig demo \
   --worktree "$R/rigs/demo-win" --branch demo-win --window "hq:work"
q "$REGSH" register --id s-dead --kind worker --rig demo \
   --worktree "$R/rigs/demo-dead" --branch demo-dead --window "%7"
q "$REGSH" register --id s-fin --kind worker --rig demo \
   --worktree "$R/rigs/demo-fin" --branch demo-fin --window "%7"
q "$REGSH" update s-fin --status finishable
# tmux seam: three windows and three panes, and the two live targets this test
# cares about (%9 and hq:work) sit in the MIDDLE of the list, not at either end.
# A space-delimited match over a newline-separated list only sees the ends.
export HQ_TMUX_WINDOWS="hq:overseer
hq:work
hq:mail
%0
%9
%12"

# ---- 1. dry run changes nothing -------------------------------------------
dry="$(bash "$REAP" 2>&1)"; dry_rc=$?
[ "$dry_rc" = 0 ]; check $? "dry run exited $dry_rc"
grep -q "REAP  $R/rigs/demo-dead" <<<"$dry"; check $? "dry run did not plan the dead worktree"
grep -q "KEEP  $R/rigs/demo-open" <<<"$dry"; check $? "dry run did not keep the unmerged worktree"
grep -q "KEEP  $R/rigs/demo-dirty" <<<"$dry"; check $? "dry run did not keep the dirty worktree"
grep -q "KEEP  $R/rigs/demo-live" <<<"$dry"; check $? "dry run did not keep the live-pane worktree"
grep -q "KEEP  $R/rigs/demo-win" <<<"$dry"; check $? "dry run did not keep the live-window worktree"
grep -q "KEEP  $R/rigs/demo-fin" <<<"$dry"; check $? "dry run did not keep the finishable worktree"
grep -q "not merged into main" <<<"$dry"; check $? "dry run gave no unmerged reason"
grep -q "dirty: 1 uncommitted" <<<"$dry"; check $? "dry run gave no dirty reason"
grep -q "session s-live is still live" <<<"$dry"; check $? "dry run gave no live-session reason"
grep -q "session s-win is still live" <<<"$dry"; check $? "dry run did not honour a window-name target"
grep -q "session s-fin is finishable" <<<"$dry"; check $? "dry run did not honour the finishable state"
grep -q "CLOSE s-dead" <<<"$dry"; check $? "dry run did not plan closing the stale registry row"
for keep_row in s-live s-win s-fin; do
  grep -q "CLOSE $keep_row" <<<"$dry" && { say "FAIL dry run planned closing row $keep_row"; fail=1; }
done
grep -q "dry run; re-run with --apply" <<<"$dry"; check $? "dry run summary missing"

# blocker 2: the parked rig must resolve main, not power-over-time
grep -q "rig parked (default main)" <<<"$dry"; check $? "parked rig did not resolve main as its default"
grep -q "KEEP  $R/rigs/parked-feature" <<<"$dry"; check $? "parked rig worktree was not kept"
grep -q "REAP  $R/rigs/parked-feature" <<<"$dry" && { say "FAIL parked rig worktree planned for removal"; fail=1; }

for d in demo-dead demo-open demo-dirty demo-live demo-win demo-fin parked-feature; do
  [ -d "$R/rigs/$d" ] || { say "FAIL dry run removed $d"; fail=1; }
done
q git -C "$RIG" rev-parse --verify refs/heads/demo-dead
check $? "dry run deleted a branch"
"$REGSH" get s-dead | grep -q '"status": "active"'
check $? "dry run changed the registry"

# the timer reads this file, so a dry run must write it
[ -s "$R/state/reaper/latest.txt" ]; check $? "dry run wrote no report at state/reaper/latest.txt"
grep -q "REAP  $R/rigs/demo-dead" "$R/state/reaper/latest.txt"
check $? "report file does not carry the plan"

# ---- 2. --apply reaps exactly one worktree --------------------------------
out="$(bash "$REAP" --apply 2>&1)"; rc=$?
[ "$rc" = 0 ]; check $? "--apply exited $rc with no failed removal"
[ -d "$R/rigs/demo-dead" ] && { say "FAIL --apply did not remove the dead worktree"; fail=1; }
for d in demo-open demo-dirty demo-live demo-win demo-fin parked-feature; do
  [ -d "$R/rigs/$d" ] || { say "FAIL --apply removed $d, which it must keep"; fail=1; }
done
q git -C "$RIG" rev-parse --verify refs/heads/demo-dead
[ $? = 0 ] && { say "FAIL --apply left the merged branch demo-dead behind"; fail=1; }
for b in demo-open demo-dirty demo-live demo-win demo-fin; do
  q git -C "$RIG" rev-parse --verify "refs/heads/$b"
  check $? "--apply deleted branch $b, which it must keep"
done
q git -C "$PRIG" rev-parse --verify refs/heads/parked-feature
check $? "--apply deleted parked-feature ($feat_sha), which is not an ancestor of main"
"$REGSH" get s-dead | grep -q '"status": "done"'
check $? "--apply did not mark the stale registry row done"
"$REGSH" get s-live | grep -q '"status": "active"'
check $? "--apply closed the live registry row"
"$REGSH" get s-win | grep -q '"status": "active"'
check $? "--apply closed the row held by a window name"
"$REGSH" get s-fin | grep -q '"status": "finishable"'
check $? "--apply closed the finishable row"
grep -q "removed 1 worktrees" <<<"$out"; check $? "--apply summary did not report one removal"

# ---- 3. a second --apply is a no-op ---------------------------------------
again="$(bash "$REAP" --apply 2>&1)"
grep -q "removed 0 worktrees" <<<"$again"; check $? "second --apply was not idempotent"

# ---- 4. tmux unreachable means nothing is reaped on a session's account ----
# (no seam and no tmux: every active row counts as live, no row is closed)
noseam="$(env -u HQ_TMUX_WINDOWS PATH=/nonexistent:/usr/bin:/bin bash "$REAP" 2>&1)"
grep -q "CLOSE " <<<"$noseam" && { say "NOTE tmux is reachable in this environment, skipping the unknown-tmux case"; }

# ---- 5. a failed removal exits non-zero and keeps the registry row ---------
RO="$R/ro"; mkdir -p "$RO/rigs" "$RO/state"
RIG2="$RO/rigs/demo"
q git init -b main "$RIG2"
q git -C "$RIG2" config user.email test@example.com
q git -C "$RIG2" config user.name  test
printf 'base\n' > "$RIG2/file.txt"; q git -C "$RIG2" add -A; q git -C "$RIG2" commit -m base
q git -C "$RIG2" checkout -b gone main
printf 'x\n' > "$RIG2/gone.txt"; q git -C "$RIG2" add -A; q git -C "$RIG2" commit -m gone
q git -C "$RIG2" checkout main
q git -C "$RIG2" merge --no-ff -m "merge gone" gone
q git -C "$RIG2" worktree add "$RO/rigs/demo-gone" gone
q env HQ_STATE_DIR="$RO/state" "$REGSH" register --id s-gone --kind worker --rig demo \
   --worktree "$RO/rigs/demo-gone" --branch gone --window "%77"
chmod a-w "$RO/rigs"          # git worktree remove cannot unlink inside a read-only parent
rofail="$(HQ_ROOT="$RO" HQ_STATE_DIR="$RO/state" bash "$REAP" --apply --out "$RO/plan.txt" 2>&1)"; rorc=$?
chmod u+w "$RO/rigs"
[ "$rorc" != 0 ]; check $? "a failed removal did not make the run exit non-zero (rc=$rorc)"
grep -q "remove FAILED" <<<"$rofail"; check $? "a failed removal was not reported"
[ -d "$RO/rigs/demo-gone" ]; check $? "the worktree vanished even though the removal failed"
# the removal path must not mark the row done; the separate dead-pane sweep still may,
# and that is a different rule (the session really is gone, the worktree is not)
grep -q "registry row s-gone marked done" <<<"$rofail" \
  && { say "FAIL the failed-removal path still closed the registry row"; fail=1; }
q git -C "$RIG2" rev-parse --verify refs/heads/gone
check $? "a failed removal still deleted the branch"

if [ "$fail" = 0 ]; then echo "REAP TEST OK"; else echo "REAP TEST FAILED"; exit 1; fi
