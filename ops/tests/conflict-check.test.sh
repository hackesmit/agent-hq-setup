#!/usr/bin/env bash
# Fixture tests for conflict-check.sh — temp rig with disjoint vs colliding branches.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CC="$DIR/../scripts/conflict-check.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

export HQ_ROOT="$(mktemp -d)"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
trap 'rm -rf "$HQ_ROOT"' EXIT
R="$HQ_ROOT/rigs/foo"; mkdir -p "$R"; git -C "$R" init -q
printf 'line1\nline2\nline3\n' > "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm base
def="$(git -C "$R" symbolic-ref --short HEAD)"

# disjoint branch: touches a different file -> clean
git -C "$R" checkout -q -b disjoint
printf 'other\n' > "$R/g"; git -C "$R" add -A; git -C "$R" commit -qm other
git -C "$R" checkout -q "$def"

# colliding branch: rewrites the same line as a later default change -> conflict
git -C "$R" checkout -q -b collide
printf 'line1\nCOLLIDE\nline3\n' > "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm collide
git -C "$R" checkout -q "$def"
printf 'line1\nDEFAULT\nline3\n' > "$R/f"; git -C "$R" add -A; git -C "$R" commit -qm defchange

"$CC" "$def" disjoint --rig foo >/dev/null 2>&1; eq "disjoint -> clean (exit 0)" "$?" "0"
"$CC" "$def" collide --rig foo >/dev/null 2>&1; eq "collide -> conflict (exit 1)" "$?" "1"
"$CC" "$def" nosuchbranch --rig foo >/dev/null 2>&1; eq "missing ref -> exit 2" "$?" "2"
out="$("$CC" "$def" disjoint --rig foo 2>/dev/null)"; eq "prints clean" "$out" "clean"

[ "$fail" = 0 ] && echo "CONFLICT-CHECK TESTS: PASS" || { echo "CONFLICT-CHECK TESTS: FAIL"; exit 1; }
