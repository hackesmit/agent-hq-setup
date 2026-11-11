#!/usr/bin/env bash
# Fixture tests for hook-push-tracker.sh: synthetic hook payloads against throwaway
# git repos. Core regression: in the SHARED hq tree, a neighbor session's uncommitted
# files must not flag this session at Stop; the session's own dirty files still must.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$DIR/../scripts/hook-push-tracker.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
HQR="$TMP/hq"; mkdir -p "$HQR/state"
git -C "$HQR" init -q
git -C "$HQR" -c user.email=t@t -c user.name=t commit --allow-empty -qm base
export CLAUDE_PROJECT_DIR="$HQR"

post(){ # post <sid> <tool> <file_path>
  printf '{"session_id":"%s","hook_event_name":"PostToolUse","tool_name":"%s","tool_input":{"file_path":"%s"}}' \
    "$1" "$2" "$3" | bash "$HOOK"
}
post_bash(){ # post_bash <sid> <command> <cwd>
  printf '{"session_id":"%s","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"cwd":"%s"}' \
    "$1" "$2" "$3" | bash "$HOOK"
}
stop(){ # stop <sid>  -> echoes hook exit code
  printf '{"session_id":"%s","hook_event_name":"Stop"}' "$1" | bash "$HOOK" 2>"$TMP/stderr"
  echo $?
}

# 1. neighbor's dirt does not flag this session (the reported bug)
echo mine > "$HQR/mine.txt"; git -C "$HQR" add mine.txt
git -C "$HQR" -c user.email=t@t -c user.name=t commit -qm mine
post s1 Edit "$HQR/mine.txt"
echo neighbor > "$HQR/neighbor.txt"        # another session's uncommitted work
[ "$(stop s1)" = 0 ] && ok "neighbor dirt ignored in shared hq" || no "neighbor dirt ignored in shared hq" "$(cat "$TMP/stderr")"

# 2. own dirty file still blocks
post s2 Edit "$HQR/own.txt"
echo wip > "$HQR/own.txt"
[ "$(stop s2)" = 2 ] && ok "own dirt still blocks" || no "own dirt still blocks"

# 3. own file committed -> clean stop even though neighbor.txt is still dirty
git -C "$HQR" add own.txt; git -C "$HQR" -c user.email=t@t -c user.name=t commit -qm own
post s3 Edit "$HQR/own.txt"
[ "$(stop s3)" = 0 ] && ok "own committed file passes" || no "own committed file passes"

# 4. bare git-commit record at hq root carries no path info: no whole-tree flag
post_bash s4 "git commit -m x" "$HQR"
[ "$(stop s4)" = 0 ] && ok "root-level git record ignores neighbor dirt" || no "root-level git record ignores neighbor dirt"

# 4b. bash-staged file at hq root IS caught (path parsed from the git add command)
echo staged > "$HQR/staged.txt"
post_bash s4b "git add staged.txt" "$HQR"
[ "$(stop s4b)" = 2 ] && ok "bash git-add path still blocks" || no "bash git-add path still blocks"
git -C "$HQR" add staged.txt
git -C "$HQR" -c user.email=t@t -c user.name=t commit -qm staged

# 4d. blanket add at hq root restores the whole-tree check for that session
echo blanket > "$HQR/blanket.txt"
post_bash s4d "git add ." "$HQR"
[ "$(stop s4d)" = 2 ] && ok "git add . claims whole tree, blocks" || no "git add . claims whole tree, blocks"
rm -f "$HQR/blanket.txt"

# 4e. quoted filename with a space is parsed and scoped correctly
echo sp > "$HQR/my file.txt"
post_bash s4e "git add 'my file.txt'" "$HQR"
[ "$(stop s4e)" = 2 ] && ok "quoted filename tracked and blocks" || no "quoted filename tracked and blocks"
rm -f "$HQR/my file.txt"

# 4c. filename that looks like pathspec magic is treated literally, still detected
mkdir -p "$HQR/odd"
touch "$HQR/odd/:(exclude)all"
post s4c Edit "$HQR/odd/:(exclude)all"
[ "$(stop s4c)" = 2 ] && ok "pathspec-magic filename treated literally" || no "pathspec-magic filename treated literally"
rm -rf "$HQR/odd"

# 5. a NON-shared repo (worktree/rig) keeps the whole-repo check
RIG="$TMP/rig"; mkdir -p "$RIG"
git -C "$RIG" init -q
git -C "$RIG" -c user.email=t@t -c user.name=t commit --allow-empty -qm base
post s5 Edit "$RIG/a.txt"
echo other > "$RIG/unrelated.txt"          # ANY dirt in an owned tree blocks
[ "$(stop s5)" = 2 ] && ok "worktree keeps whole-repo check" || no "worktree keeps whole-repo check"

# 6. deleted-but-tracked path: session touched a file that no longer exists on disk
post s6 Edit "$HQR/own.txt"
git -C "$HQR" rm -q own.txt                # staged deletion = dirty for this path
[ "$(stop s6)" = 2 ] && ok "staged deletion of touched file blocks" || no "staged deletion of touched file blocks"
git -C "$HQR" -c user.email=t@t -c user.name=t commit -qm rm

# 7. stop_hook_active passes through
printf '{"session_id":"s7","hook_event_name":"Stop","stop_hook_active":true}' | bash "$HOOK"
[ "$?" = 0 ] && ok "stop_hook_active passes" || no "stop_hook_active passes"

[ "$fail" = 0 ] && echo "PUSH-TRACKER TESTS: PASS" || { echo "PUSH-TRACKER TESTS: FAIL"; exit 1; }
