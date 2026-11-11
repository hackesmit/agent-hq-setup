#!/usr/bin/env bash
# conflict-check.sh <branchA> <branchB> [--rig RIG]
# Predict whether two branches merge cleanly, BEFORE either merges. Prediction only —
# never merges, never writes a branch. Exit: 0 clean, 1 conflict, 2 usage/error.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
die(){ echo "conflict-check: $1" >&2; exit 2; }

a=""; b=""; rig=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rig) rig="${2:-}"; shift;;
    --*) die "unknown arg: $1";;
    *) if [ -z "$a" ]; then a="$1"; elif [ -z "$b" ]; then b="$1"; else die "too many args"; fi;;
  esac; shift
done
[ -n "$a" ] && [ -n "$b" ] || die "usage: conflict-check.sh <branchA> <branchB> [--rig RIG]"

if [ "$rig" = hq ]; then repo="$HQ"; elif [ -n "$rig" ]; then repo="$HQ/rigs/$rig"; else repo="$(git rev-parse --show-toplevel 2>/dev/null)"; fi
[ -n "$repo" ] && git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repo: ${rig:-$PWD}"
git -C "$repo" rev-parse --verify "$a" >/dev/null 2>&1 || die "no such ref: $a"
git -C "$repo" rev-parse --verify "$b" >/dev/null 2>&1 || die "no such ref: $b"

# Primary: modern merge-tree --write-tree (git >=2.38): exit 0 clean, 1 conflict.
git -C "$repo" merge-tree --write-tree "$a" "$b" >/dev/null 2>&1
rc=$?
case "$rc" in
  0) echo "clean"; exit 0;;
  1) echo "conflict"
     git -C "$repo" merge-tree --write-tree --name-only "$a" "$b" 2>/dev/null | tail -n +2 | sed 's/^/  /'
     exit 1;;
esac

# Fallback: classic 3-arg merge-tree marker scan (old git).
base="$(git -C "$repo" merge-base "$a" "$b" 2>/dev/null)"
[ -n "$base" ] || die "no common merge-base for $a and $b"
if git -C "$repo" merge-tree "$base" "$a" "$b" 2>/dev/null | grep -qE '^(<<<<<<<|changed in both)'; then
  echo "conflict"; exit 1
fi
echo "clean"; exit 0
