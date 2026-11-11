#!/usr/bin/env bash
# Fixture tests for term.sh — temp HQ + throwaway git rig. Covers the worktree-on-
# contention rule and registration (the tmux pane path is manual-verified).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TERM_SH="$DIR/../scripts/term.sh"
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }
getf(){ "$REGSH" get "$1" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[\"$2\"])" 2>/dev/null; }

export HQ_ROOT="$(mktemp -d)"; export HQ_STATE_DIR="$HQ_ROOT/state"
trap 'rm -rf "$HQ_ROOT"' EXIT
mkdir -p "$HQ_ROOT/rigs/foo"
git -C "$HQ_ROOT/rigs/foo" init -q
git -C "$HQ_ROOT/rigs/foo" -c user.email=t@t -c user.name=t commit --allow-empty -qm base

# no rig -> cwd is HQ, no worktree, kind=terminal
id0="$("$TERM_SH" --dry-run | tail -1)"
case "$id0" in t-*) ok "term prints t- id";; *) no "term prints t- id" "$id0";; esac
eq "no-rig kind terminal" "$(getf "$id0" kind)" "terminal"
eq "no-rig worktree empty" "$(getf "$id0" worktree)" ""

# first rig terminal holds the MAIN checkout (worktree == rig dir, no branch)
id1="$("$TERM_SH" foo --dry-run | tail -1)"
eq "first rig term uses main" "$(getf "$id1" worktree)" "$HQ_ROOT/rigs/foo"
eq "first rig term no branch" "$(getf "$id1" branch)" ""

# second rig terminal (contention) gets its OWN worktree + branch
id2="$("$TERM_SH" foo --dry-run | tail -1)"
w2="$(getf "$id2" worktree)"
[ "$w2" = "$HQ_ROOT/rigs/foo-${id2#t-}" ] && ok "2nd rig term gets a worktree" || no "2nd rig term gets a worktree" "$w2"
[ -d "$w2" ] && ok "worktree dir created" || no "worktree dir created"
[ -n "$(getf "$id2" branch)" ] && ok "2nd rig term has a branch" || no "2nd rig term has a branch"

# after the first is deregistered, contention clears -> next uses main again
"$REGSH" deregister "$id1" >/dev/null
id3="$("$TERM_SH" foo --dry-run | tail -1)"
eq "freed rig term uses main again" "$(getf "$id3" worktree)" "$HQ_ROOT/rigs/foo"

# bad rig fails
"$TERM_SH" nope --dry-run >/dev/null 2>&1; [ "$?" != 0 ] && ok "bad rig fails" || no "bad rig fails"

[ "$fail" = 0 ] && echo "TERM TESTS: PASS" || { echo "TERM TESTS: FAIL"; exit 1; }
