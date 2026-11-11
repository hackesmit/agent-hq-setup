#!/usr/bin/env bash
# Fixture tests for hook-hq-blanket-add-guard.sh (proposal 12): it must block
# blanket staging forms in the shared HQ working tree and stay out of the way
# everywhere else. Self-contained: a throwaway repo stands in for ~/hq via the
# HQ_DIR seam, so the tests never depend on the real repo's dirt or location.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$DIR/../scripts/hook-hq-blanket-add-guard.sh"
if [ ! -f "$HOOK" ]; then
  echo "SKIP: proposal 12 is not applied (no $HOOK)"
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
HQR="$TMP/hq"; mkdir -p "$HQR"
git -C "$HQR" init -q
git -C "$HQR" -c user.email=t@t -c user.name=t commit --allow-empty -qm base
OTHER="$TMP/other"; mkdir -p "$OTHER"
git -C "$OTHER" init -q
git -C "$OTHER" -c user.email=t@t -c user.name=t commit --allow-empty -qm base
WT="$TMP/hq-wt"
git -C "$HQR" worktree add -q "$WT" -b wt-branch
export HQ_DIR="$HQR"

pass=0; fail=0
try(){ # <want block|allow> <cwd> <command> <label>
  local want="$1" cwd="$2" cmd="$3" label="$4" rc
  printf '%s' "{\"tool_name\":\"Bash\",\"cwd\":\"$cwd\",\"tool_input\":{\"command\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$cmd")}}" \
    | bash "$HOOK" >/dev/null 2>&1
  rc=$?
  local got=allow; [ "$rc" = 2 ] && got=block
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   $label"
  else fail=$((fail+1)); echo "FAIL $label (want $want got $got)"; fi
}

echo "--- must BLOCK in the shared hq tree ---"
try block "$HQR" 'git add -A'                          "git add -A"
try block "$HQR" 'git add --all'                       "git add --all"
try block "$HQR" 'git add .'                           "git add ."
try block "$HQR" 'git add ./'                          "git add ./"
try block "$HQR" 'git add :/'                          "git add :/ pathspec"
try block "$HQR" 'git add -u'                          "git add -u sweeps tracked changes"
try block "$HQR" 'git add --update'                    "git add --update"
try block "$HQR" 'git add --pathspec-from-file=list'   "pathspec-from-file"
try block "$HQR" 'git commit -a -m x'                  "git commit -a"
try block "$HQR" 'git commit -am "msg"'                "git commit -am"
try block "$HQR" 'git add -A && git commit -q -F f'    "chained add -A"
try block "$TMP" "cd $HQR && git add -A"               "cd into hq then add -A"

echo "--- bypasses lucy found (rounds 1 and 2) ---"
try block "$HQR" 'git add explicit.txt && git add -A'          "second invocation is blanket"
try block "$TMP" "git -C $HQR add -A"                          "git -C into hq"
try block "$HQR" 'env git add -A'                              "env git"
try block "$HQR" 'command git commit -am x'                    "command git"
try block "$HQR" 'git add --dry-run foo; git add -A'           "dry-run does not mask the next invocation"
try block "$TMP" "git -C $OTHER add -A && git -C $HQR add -A"  "foreign -C then hq -C"

echo "--- bypasses lucy found (round 2) ---"
try block "$HQR" ' git add -A'                                 "leading whitespace"
try block "$TMP" "git -C $OTHER add foo
git -C $HQR add -A"                                            "newline-separated repos"
try block "$HQR" "(cd $OTHER && git status); git add -A"       "subshell cd must not leak"

echo "--- must ALLOW ---"
try allow "$HQR" 'git add ops/console/ctl.sh'          "explicit paths"
try allow "$HQR" 'git add ops/console tests/x.sh'      "several explicit paths"
try allow "$HQR" 'git commit -q -F msg.txt'            "commit without -a"
try allow "$HQR" 'git add --dry-run -A'                "--dry-run"
try allow "$HQR" 'git add -n -A'                       "-n dry run"
try allow "$HQR" 'git status --porcelain'              "unrelated git"
try allow "$HQR" 'echo git add -A is a string'         "not an invocation"
try allow "$OTHER" 'git add -A'                        "other repo"
try allow "$WT" 'git add -A'                           "hq worktree owns its tree"
try allow "$TMP" "git -C $OTHER add -A"                "-C other repo only"
try allow "$TMP/nonexistent" 'git add -A'              "missing cwd fails open"

echo
echo "hq-blanket-add-guard: $pass pass, $fail fail"
[ "$fail" = 0 ] || exit 1
