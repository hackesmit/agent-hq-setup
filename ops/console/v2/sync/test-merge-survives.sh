#!/usr/bin/env bash
# Regression test for hq-fgg3.13 / hq-h2ww: a --no-ff merge on a owner-side checkout
# must reach origin as the same merge commit (hub-sync must not flatten it), and the
# following git-sync pass must not report Diverged. Everything runs in a temp dir:
# a bare origin, the hub-sync mirror, and a sandbox HQ checkout whose remote is the
# mirror, with a copy of git-sync.sh and a stub notify.sh. Nothing touches ~/hq or GitHub.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GITSYNC="$HERE/../../../scripts/git-sync.sh"
T="$(mktemp -d /tmp/hubmerge.XXXXXX)"
export HUB_MIRRORS="$T/mirrors" HUB_REPOS_CONF="$T/repos.conf" HUB_CRED_FILE="$T/cred" HUB_LOCK="$T/lock" HUB_HEARTBEAT="$T/hb" HUB_STATUS="$T/status.json"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
pass=0; fail=0
ok(){ echo "PASS $1"; pass=$((pass+1)); }
ko(){ echo "FAIL $1"; fail=$((fail+1)); }
q(){ "$@" >/dev/null 2>&1; }

q git init --bare -b main "$T/origin.git"
q git clone -q "$T/origin.git" "$T/seed"; q git -C "$T/seed" commit --allow-empty -m init; q git -C "$T/seed" push -q origin main
: >"$HUB_CRED_FILE"; : >"$HUB_LOCK"
"$HERE/hub-sync.sh" --init demo "$T/origin.git" main >/dev/null 2>&1 || { echo "FAIL init"; exit 1; }

# sandbox HQ: a clone of the mirror with git-sync.sh at ops/scripts and no rigs
H="$T/hq"
q git clone -q "$HUB_MIRRORS/demo.git" "$H"
mkdir -p "$H/ops/scripts" "$H/rigs"
# the copy keeps git-sync's sync logic; only its side channels are neutered so the
# sandbox can never mail the live error system or take the box's real git lock
sed -e 's#python3 -m hq_mail\.report#true#' -e 's#python3 -m hq_mail\.heartbeat#true#' \
    -e "s#^GIT_LOCK=.*#GIT_LOCK=$T/no-lock#" "$GITSYNC" >"$H/ops/scripts/git-sync.sh"
printf '#!/bin/sh\necho "notify $*"\n' >"$H/ops/scripts/notify.sh"; printf '#!/bin/sh\nexit 0\n' >"$H/ops/scripts/vault-sync.sh"
chmod +x "$H/ops/scripts/"*.sh
printf 'ops/\nrigs/\n' >>"$H/.git/info/exclude"
gs(){ bash "$H/ops/scripts/git-sync.sh" 2>&1; }

# 1. merge a feature branch with --no-ff (what finish.sh does), git-sync pushes it to the mirror
q git -C "$H" checkout -q -b feat; echo f >"$H/f"; q git -C "$H" add f; q git -C "$H" commit -q -m feat-1
echo g >"$H/g"; q git -C "$H" add g; q git -C "$H" commit -q -m feat-2
q git -C "$H" checkout -q main; q git -C "$H" merge -q --no-ff --no-edit feat
M="$(git -C "$H" rev-parse HEAD)"
gs >"$T/gs1.log"
[ "$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)" = "$M" ] && ok "git-sync pushed the merge to the mirror" || ko "merge not on mirror"

# 2. hub-sync cycle: the merge commit must reach origin unchanged
"$HERE/hub-sync.sh" >"$T/hs1.log" 2>&1
[ "$(git -C "$T/origin.git" rev-parse main)" = "$M" ] && ok "origin has the merge commit itself" || ko "origin main is $(git -C "$T/origin.git" rev-parse --short main), not merge ${M:0:7} (flattened?)"
! grep -q 'rebased demo' "$T/hs1.log" && ok "no needless rebase when the mirror is only ahead" || ko "hub-sync rebased a fast-forwardable mirror"
"$HERE/hub-sync.sh" >"$T/hs2.log" 2>&1
! grep -qE 'rebased|DIVERGED|FAILED' "$T/hs2.log" && ok "second hub-sync cycle is quiet" || ko "second hub-sync cycle not quiet: $(head -2 "$T/hs2.log" | tr '\n' ' ')"

# 3. one git-sync pass afterwards: no Diverged, local main equals mirror
gs >"$T/gs2.log"
! grep -q 'DIVERGED' "$T/gs2.log" && ok "git-sync pass reports no Diverged" || ko "git-sync reported: $(grep DIVERGED "$T/gs2.log")"
[ "$(git -C "$H" rev-parse HEAD)" = "$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)" ] && ok "local main equals mirror" || ko "local main differs from mirror"

# 4. true divergence with an AMENDED merge: origin moved (other box) while a local merge
#    waited, and the merge commit itself carries a change (merge --no-commit, add a file,
#    commit). hub-sync must merge origin in, never rewrite: the merge sha and its tree
#    survive on origin, and the local box then just fast-forwards (no Diverged)
q git -C "$T/seed" pull -q --ff-only; echo l >"$T/seed/l"; q git -C "$T/seed" add l; q git -C "$T/seed" commit -q -m laptop; q git -C "$T/seed" push -q origin main
q git -C "$H" checkout -q -b feat2; echo h >"$H/h"; q git -C "$H" add h; q git -C "$H" commit -q -m feat2-1
q git -C "$H" checkout -q main; q git -C "$H" merge -q --no-ff --no-commit feat2
echo "release=1" >"$H/release.conf"; q git -C "$H" add release.conf; q git -C "$H" commit -q --no-edit
M2="$(git -C "$H" rev-parse HEAD)"
git -C "$H" cat-file -e "$M2:release.conf" 2>/dev/null && ok "setup: the amended merge carries release.conf" || ko "setup: amended merge lacks release.conf"
gs >"$T/gs3.log"
"$HERE/hub-sync.sh" >"$T/hs3.log" 2>&1
grep -q 'merged origin into demo/main' "$T/hs3.log" && ok "diverged: origin merged into the mirror" || ko "diverged: no merge ($(head -2 "$T/hs3.log" | tr '\n' ' '))"
git -C "$T/origin.git" merge-base --is-ancestor "$M2" main && ok "diverged: the original merge commit is an ancestor of origin main" || ko "diverged: original merge $M2 not on origin"
[ "$(git -C "$T/origin.git" show main:release.conf 2>/dev/null)" = "release=1" ] && ok "diverged: release.conf survives on origin main" || ko "diverged: release.conf lost on origin"
[ "$(git -C "$T/origin.git" show main:l 2>/dev/null)" = "l" ] && ok "diverged: the other box's commit is kept" || ko "diverged: laptop commit lost"
grep -q '"demo":"ok"' "$HUB_STATUS" && ok "diverged: status ok" || ko "diverged: status not ok"
gs >"$T/gs4.log"
! grep -q 'DIVERGED' "$T/gs4.log" && ok "diverged: git-sync reports no Diverged" || ko "diverged: git-sync reported $(grep DIVERGED "$T/gs4.log")"
grep -q 'pulled demo\|pulled agent-hq' "$T/gs4.log" && ok "diverged: git-sync fast-forward pulled origin's merge" || ko "diverged: no fast-forward pull ($(head -2 "$T/gs4.log" | tr '\n' ' '))"
[ "$(git -C "$H" rev-parse HEAD)" = "$(git -C "$T/origin.git" rev-parse main)" ] && ok "diverged: local main equals origin" || ko "diverged: local main differs from origin"
[ -f "$H/release.conf" ] && ok "diverged: release.conf still in the local checkout" || ko "diverged: release.conf gone locally"

# 4b. conflicting divergence: hub-sync merges nothing, moves nothing, reports diverged
echo A >"$H/same"; q git -C "$H" add same; q git -C "$H" commit -q -m "local conflict"
LOCAL="$(git -C "$H" rev-parse HEAD)"
q git -C "$T/seed" pull -q --ff-only; echo B >"$T/seed/same"; q git -C "$T/seed" add same; q git -C "$T/seed" commit -q -m "laptop conflict"; q git -C "$T/seed" push -q origin main
ORIG="$(git -C "$T/origin.git" rev-parse main)"
gs >"$T/gs5.log"
"$HERE/hub-sync.sh" >"$T/hs5.log" 2>&1
grep -q 'DIVERGED demo' "$T/hs5.log" && grep -q '"demo":"diverged"' "$HUB_STATUS" && ok "conflict: reported as diverged" || ko "conflict: not reported"
[ "$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)" = "$LOCAL" ] && [ "$(git -C "$T/origin.git" rev-parse main)" = "$ORIG" ] && ok "conflict: mirror and origin untouched" || ko "conflict: something moved"
[ "$(git -C "$HUB_MIRRORS/demo.git" worktree list --porcelain | grep -c '^worktree /tmp/hub-merge')" = 0 ] && ok "conflict: throwaway worktree cleaned up" || ko "conflict: worktree left behind"
# resolve for the later cases: take origin everywhere
q git -C "$HUB_MIRRORS/demo.git" update-ref refs/heads/main "$ORIG"
q git -C "$H" fetch -q origin; q git -C "$H" reset -q --hard origin/main

# 4c. a hub-sync killed mid-merge leaves a registered /tmp/hub-merge.* worktree; the
#     next cycle removes it
STALE="$(mktemp -d /tmp/hub-merge.XXXXXX)"; rmdir "$STALE"
q git -C "$HUB_MIRRORS/demo.git" worktree add --detach "$STALE" main
git -C "$HUB_MIRRORS/demo.git" worktree list --porcelain | grep -q "^worktree $STALE$" && ok "setup: stale worktree registered" || ko "setup: stale worktree not registered"
"$HERE/hub-sync.sh" >/dev/null 2>&1
! git -C "$HUB_MIRRORS/demo.git" worktree list --porcelain | grep -q "^worktree $STALE$" && [ ! -e "$STALE" ] && ok "stale merge worktree removed by the next cycle" || ko "stale merge worktree still there"

# 5. the shadow refspec is added once, not once per cycle
n=$(git -C "$HUB_MIRRORS/demo.git" config --get-all remote.origin.fetch | grep -cxF '+refs/heads/*:refs/hub-origin/*')
[ "$n" = 1 ] && ok "shadow refspec present exactly once" || ko "shadow refspec present $n times"
# 6. an already-bloated mirror config is collapsed to one copy, other refspecs kept
for i in 1 2 3 4 5; do git -C "$HUB_MIRRORS/demo.git" config --add remote.origin.fetch '+refs/heads/*:refs/hub-origin/*'; done
"$HERE/hub-sync.sh" >/dev/null 2>&1
n=$(git -C "$HUB_MIRRORS/demo.git" config --get-all remote.origin.fetch | grep -cxF '+refs/heads/*:refs/hub-origin/*')
total=$(git -C "$HUB_MIRRORS/demo.git" config --get-all remote.origin.fetch | wc -l)
[ "$n" = 1 ] && [ "$total" = 3 ] && ok "bloated shadow refspec deduped (3 refspecs left)" || ko "dedupe: shadow $n, total $total"

echo "merge-survives tests: $pass passed, $fail failed (workdir $T)"
[ "$fail" -eq 0 ]
