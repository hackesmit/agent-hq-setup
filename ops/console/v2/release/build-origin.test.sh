#!/usr/bin/env bash
# hq-oq30g.3: build.sh defers (exit 0) when the head is not yet on origin, builds
# once origin catches up within the wait, and still fails on a real build error.
# Offline: a throwaway mirror under /tmp; the "broken build" is a commit with no
# package-lock.json, which build.sh refuses before npm runs.
set -uo pipefail
export LC_ALL=C
HERE=$(cd "$(dirname "$0")" && pwd); BUILD="$HERE/build.sh"
T=$(mktemp -d /tmp/hq-build-origin.XXXXXX); trap 'rm -rf "$T"' EXIT
fail=0; ok(){ echo "PASS  $1"; }; no(){ echo "FAIL  $1 ($2)"; fail=1; }
g(){ git -c user.email=t@t -c user.name=t "$@"; }
mkdir -p "$T/repo/ops/console/v2" && cd "$T/repo" && git init -q -b main
echo '{"name":"x"}' > ops/console/v2/package.json
g add -A && g commit -qm A && A=$(git rev-parse HEAD)
g commit -q --allow-empty -m B && B=$(git rev-parse HEAD)
git clone -q --mirror "$T/repo" "$T/m.git"
git --git-dir="$T/m.git" update-ref refs/hub-origin/main "$A"   # origin lags: main=B, origin=A
run(){ HUB_ORIGIN_WAIT="$1" HUB_ORIGIN_POLL=1 RELEASE_NPM=/bin/true \
  bash "$BUILD" --mirror "$T/m.git" --ref main --out "$T/out" --src "$T/src" 2>&1; }

out=$(run 2); rc=$?
[ "$rc" = 0 ] && ok "origin lags: exit 0" || no "origin lags: exit 0" "rc=$rc"
case "$out" in *"deferred: $B"*) ok "origin lags: logs deferred";; *) no "origin lags: logs deferred" "$out";; esac
[ ! -e "$T/src/$B" ] && [ ! -e "$T/out/$B" ] && ok "origin lags: nothing built" || no "origin lags: nothing built" "src or out has $B"

# origin catches up during the wait: the build goes on (and fails on the missing
# lockfile, which proves it got past the gate and that a build error still fails)
( sleep 2; git --git-dir="$T/m.git" update-ref refs/hub-origin/main "$B" ) &
out=$(run 30); rc=$?; wait
[ "$rc" != 0 ] && ok "origin catches up, broken build: non-zero" || no "origin catches up, broken build: non-zero" "rc=0"
case "$out" in *"package-lock.json missing at $B"*) ok "origin catches up: builds $B";; *) no "origin catches up: builds $B" "$out";; esac
case "$out" in *deferred*) no "origin catches up: not deferred" "$out";; *) ok "origin catches up: not deferred";; esac

# broken build with origin current from the start: still fails, no deferral
out=$(run 0); rc=$?
[ "$rc" = 1 ] && ok "broken build: exit 1" || no "broken build: exit 1" "rc=$rc"

[ "$fail" = 0 ] && echo "BUILD ORIGIN TESTS: PASS" || { echo "BUILD ORIGIN TESTS: FAIL"; exit 1; }
