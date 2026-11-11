#!/usr/bin/env bash
# review-diff-selection.test.sh (hq-40n2x): lucy reviews the branch it is asked
# for, never another working tree. On 2026-11-05 `lucy --rig hq --base main` for a
# worktree branch sent ~/hq main's untracked client notes to the vendor as the diff.
# Offline through --dry-run: no key is read and nothing is sent. The text that
# would be sent is captured from a copy of review.sh that saves its temp diff.
#
# Run: bash ops/tests/review-diff-selection.test.sh   (exit 0 = ALL PASS)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HERE/../scripts/review.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

# a copy of review.sh that keeps the diff it would send in $T/sent
sed 's#^printf .%s. "\$diff" | head -c 200000 > "\$tmpdiff"#&; cp "\$tmpdiff" "$SENT"#' "$R" > "$T/review.sh"
grep -q 'cp "$tmpdiff" "$SENT"' "$T/review.sh" || { echo "FAIL  capture hook not installed"; exit 1; }

g(){ git -c user.email=t@t -c user.name=t -c init.defaultBranch=main "$@"; }
mkrepo(){ # $1 = dir: main has base.txt committed and an untracked secret note
  mkdir -p "$1" && g -C "$1" init -q && echo base >"$1/base.txt" && g -C "$1" add base.txt && g -C "$1" commit -qm base
  echo "CLIENT FINANCIAL NOTE" >"$1/client-notes.md"
}
H="$T/hq"; mkrepo "$H"; mkrepo "$H/rigs/demo"
printf 'rigs/\n.claude/\n' >"$H/.gitignore"; g -C "$H" add .gitignore; g -C "$H" commit -qm ignore
for r in "$H" "$H/rigs/demo"; do
  g -C "$r" worktree add -q -b feat "$r/.claude/worktrees/w" 2>/dev/null
  echo work >"$r/.claude/worktrees/w/feat.txt"; g -C "$r/.claude/worktrees/w" add feat.txt
  g -C "$r/.claude/worktrees/w" commit -qm feat
  echo scratch >"$r/.claude/worktrees/w/wip-untracked.txt"
done

run(){ # $1 = cwd, rest = args; sets rc, out (stdout+stderr), sent (file names in the diff)
  local d="$1"; shift; rm -f "$T/sent"
  out="$(cd "$d" && SENT="$T/sent" HQ_ROOT="$H" bash "$T/review.sh" --dry-run "$@" 2>&1)"; rc=$?
  sent="$( [ -f "$T/sent" ] && grep -oE '^diff --git a/[^ ]+' "$T/sent" | sed 's#^diff --git a/##' | sort | tr '\n' ' ')"
}

# 1. the incident: --rig hq --branch from the dirty main checkout sends the branch only
run "$H" --rig hq --base main --branch feat
[ "$rc" = 0 ] && [ "$sent" = "feat.txt " ] && ok "--rig hq --branch feat from dirty ~/hq sends exactly feat.txt" || no "--rig hq --branch" "rc=$rc sent=$sent out=$out"
grep -q 'CLIENT FINANCIAL' "$T/sent" 2>/dev/null && no "client note leaked" || ok "no untracked client note in the sent diff"
head="$(g -C "$H" rev-parse feat)"; mb="$(g -C "$H" merge-base main feat)"
grep -q "base=$mb head=$head" <<<"$out" && ok "plan names merge-base and branch head (call log fields)" || no "base/head" "$out"

# 2. the same from the worktree itself, and for a named rig
run "$H/.claude/worktrees/w" --rig hq --branch feat
[ "$rc" = 0 ] && [ "$sent" = "feat.txt " ] && ok "--branch from the worktree ignores its untracked scratch file" || no "worktree --branch" "rc=$rc sent=$sent"
run "$T" --rig demo --base main --branch feat
[ "$rc" = 0 ] && [ "$sent" = "feat.txt " ] && ok "--rig demo --branch feat sends exactly the branch's files" || no "--rig demo --branch" "rc=$rc sent=$sent out=$out"
run "$H/rigs/demo/.claude/worktrees/w" --branch "$(g -C "$H/rigs/demo" rev-parse feat)"
[ "$rc" = 0 ] && [ "$sent" = "feat.txt " ] && ok "--branch takes a commit sha, no --rig" || no "--branch sha" "rc=$rc sent=$sent"

# 3. fail closed: --rig without --branch from a dirty main checkout or from elsewhere
run "$H" --rig hq --base main
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q 'uncommitted or untracked' <<<"$out" && ok "--rig hq from dirty ~/hq without --branch refuses (exit 2)" || no "dirty main refuse" "rc=$rc out=$out"
run "$H/.claude/worktrees/w" --rig hq --base main
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q 'pass --branch' <<<"$out" && ok "--rig hq from a worktree without --branch refuses (exit 2)" || no "worktree refuse" "rc=$rc out=$out"
run "$T" --rig demo
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && ok "--rig demo from outside the rig without --branch refuses (exit 2)" || no "outside refuse" "rc=$rc out=$out"

# 4. fail closed: a missing ref, a missing rig, an empty diff
run "$H" --rig hq --branch no-such-branch
[ "$rc" = 2 ] && grep -q 'no such branch or commit' <<<"$out" && ok "--branch on a missing ref exits 2" || no "missing ref" "rc=$rc out=$out"
run "$H" --rig nope --branch feat
[ "$rc" = 2 ] && grep -q 'not a git repo' <<<"$out" && ok "--rig with no such repo exits 2" || no "missing rig" "rc=$rc out=$out"
run "$H" --rig hq --branch main
[ "$rc" = 2 ] && grep -q 'empty diff' <<<"$out" && ok "an empty branch diff exits 2, nothing reviewed" || no "empty diff" "rc=$rc out=$out"
run "$H" --rig hq --branch --dry-run
[ "$rc" = 2 ] && ok "--branch with an option-looking value exits 2" || no "dash ref" "rc=$rc out=$out"

# 5. unchanged: no --rig/--branch reviews what the caller stands in; --diff-file still works
run "$H/.claude/worktrees/w"
# (untracked files are synthetic --no-index diffs, so they carry an absolute path)
[ "$rc" = 0 ] && [[ "$sent" =~ ^feat\.txt\ [^\ ]*/w/wip-untracked\.txt\ $ ]] && ok "no --rig reviews the caller's worktree, untracked work included" || no "caller tree" "rc=$rc sent=$sent"
printf 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' >"$T/d.diff"
run "$H" --rig hq --diff-file "$T/d.diff"
[ "$rc" = 0 ] && [ "$sent" = "x " ] && ok "--diff-file with --rig is unchanged" || no "--diff-file" "rc=$rc sent=$sent"

# 6. lucy-bg refuses --rig without --branch at once, before any fork or mark
LB="$HERE/../scripts/lucy-bg.sh"
o="$(HQ_ORCH_DIR="$T/orch" HQ_LUCY_BIN=/bin/false "$LB" --bead hq-t --rig hq --base main "c" 2>&1)"; r=$?
[ "$r" = 2 ] && [ ! -d "$T/orch/lucy-started" ] && grep -q 'needs a --branch' <<<"$o" && ok "lucy-bg --rig without --branch exits 2 and starts nothing" || no "lucy-bg refuse" "rc=$r $o"

# 7. a rig dir with no repo of its own resolves to the enclosing hq repo: refuse,
# never export hq's branch diff (hq-40n2x.1, lucy finding 1)
g -C "$H" checkout -q -b priv && echo "PRIVATE" >"$H/private-notes.md" && g -C "$H" add private-notes.md \
  && g -C "$H" commit -qm priv && g -C "$H" checkout -q main
mkdir -p "$H/rigs/plain"
run "$T" --rig plain --base main --branch priv
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q "rig dir $H/rigs/plain is not its own repo, enclosing repo is $H" <<<"$out" \
  && ok "--rig plain (a dir with no own repo) --branch exits 2, names both paths, sends nothing" || no "plain rig dir" "rc=$rc sent=$sent out=$out"
run "$H/rigs/plain" --rig plain --base main
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q 'is not its own repo' <<<"$out" \
  && ok "--rig plain without --branch, standing in it, exits 2" || no "plain rig dir no branch" "rc=$rc sent=$sent out=$out"

# 8. diff attributes come from the reviewed commit, never the checkout (lucy finding 2)
g -C "$H" checkout -q -b js && printf 'a\n' >"$H/app.js" && g -C "$H" add app.js && g -C "$H" commit -qm js0 \
  && printf 'a\nREVIEWED-HUNK\n' >"$H/app.js" && g -C "$H" commit -qam js1 && g -C "$H" checkout -q main
g -C "$H" branch js-base js~1   # base where app.js exists, so the branch diff is a modification
# an untracked .gitattributes in the main checkout (main commits none)
echo '*.js -diff' >"$H/.gitattributes"
run "$H" --rig hq --base js-base --branch js
[ "$rc" = 0 ] && grep -q '^+REVIEWED-HUNK' "$T/sent" && ! grep -q '^Binary files' "$T/sent" \
  && ok "untracked .gitattributes with -diff does not hide the branch's app.js hunk" || no "untracked attrs" "rc=$rc out=$out $(cat "$T/sent" 2>/dev/null)"
g -C "$H" add .gitattributes && g -C "$H" commit -qm 'main-only attrs'
run "$H" --rig hq --base js-base --branch js
[ "$rc" = 0 ] && grep -q '^+REVIEWED-HUNK' "$T/sent" && ! grep -q '^Binary files' "$T/sent" \
  && ok "a main-only committed .gitattributes loses to the branch commit's attributes" || no "committed attrs" "rc=$rc out=$out $(cat "$T/sent" 2>/dev/null)"

# 9. lucy-bg refuses every call without --branch or --diff-file, --rig or not
# (the child runs from HQ_ROOT, whose untracked client-notes.md must never be sent)
printf '#!/usr/bin/env bash\nSENT="${SENT:-%s}" exec bash %q "$@"\n' "$T/sent" "$T/review.sh" >"$T/lucy-wrap"; chmod +x "$T/lucy-wrap"
lb(){ rm -f "$T/sent"; o="$(cd "$H" && SENT="$T/sent" HQ_ROOT="$H" HQ_ORCH_DIR="$T/orch2" HQ_LUCY_BIN="$T/lucy-wrap" \
  HQ_BD=/bin/true HQ_ORCH_RUN=/bin/true "$LB" "$@" 2>&1)"; r=$?; }
lb --bead hq-x --dry-run "ctx"
[ "$r" = 2 ] && [ ! -f "$T/sent" ] && [ ! -d "$T/orch2/lucy-started" ] && grep -q "never in the caller's tree" <<<"$o" \
  && ok "lucy-bg with no --rig and no --branch exits 2, no mark, no diff" || no "lucy-bg no-rig refuse" "rc=$r $o"
lb --child --bead hq-x --dry-run "ctx"
[ "$r" = 2 ] && [ ! -f "$T/sent" ] && ok "lucy-bg --child without --branch also refuses before running lucy" || no "lucy-bg child refuse" "rc=$r $o"
lb --child --bead hq-x --branch feat --dry-run "ctx"
[ "$r" = 0 ] && [ -f "$T/sent" ] && ! grep -q 'CLIENT FINANCIAL' "$T/sent" && grep -q '^diff --git a/feat.txt' "$T/sent" \
  && ok "lucy-bg --branch feat still runs (dry-run child) and sends only the branch" || no "lucy-bg --branch runs" "rc=$r $o"

# 10. argument shape (hq-40n2x.2): an empty, missing or option-shaped value never
# reaches a working-tree diff. Each refusal: exit 2, no mark, no diff captured.
lbno(){ # $1 = label, rest = lucy-bg args; fresh orch dir per case
  local label="$1"; shift; rm -rf "$T/orch2"; lb "$@"
  [ "$r" = 2 ] && [ ! -f "$T/sent" ] && [ ! -d "$T/orch2/lucy-started" ] && grep -q 'needs a' <<<"$o" \
    && ok "$label exits 2, no mark, no diff" || no "$label" "rc=$r $o"
}
lbno "lucy-bg --diff-file \"\"" --bead hq-x --diff-file "" --dry-run "ctx"
lbno "lucy-bg trailing --diff-file" --bead hq-x --dry-run "ctx" --diff-file
lbno "lucy-bg --model --branch feat (lucy's trigger)" --bead hq-x --model --branch feat "ctx"
lbno "lucy-bg --branch \"\"" --bead hq-x --branch "" --dry-run "ctx"
lbno "lucy-bg with \"--branch\" as the only positional" --bead hq-x --dry-run "--branch"
lbno "lucy-bg --child --diff-file \"\"" --child --bead hq-x --diff-file "" --dry-run "ctx"
lbno "lucy-bg --child --model --branch feat" --child --bead hq-x --model --branch feat --dry-run "ctx"
lbno "lucy-bg --branch -x (option-shaped value)" --bead hq-x --branch -x --dry-run "ctx"
lbno "lucy-bg unknown --opt never satisfies the guard" --bead hq-x --frob feat --dry-run "ctx"

run "$H" --diff-file ""
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q -- '--diff-file needs a value' <<<"$out" \
  && ok "review.sh --diff-file \"\" from a tree with an untracked file exits 2, sends nothing" || no "review --diff-file empty" "rc=$rc sent=$sent out=$out"
run "$H" --model --branch feat
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q -- '--model needs a value' <<<"$out" \
  && ok "review.sh --model --branch feat exits 2, sends nothing" || no "review --model swallow" "rc=$rc sent=$sent out=$out"
run "$H" --self-test-response ""
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && ok "review.sh --self-test-response \"\" exits 2" || no "review replay empty" "rc=$rc out=$out"
run "$H" --branch feat --rig
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && ok "review.sh trailing --rig exits 2" || no "review trailing rig" "rc=$rc out=$out"
run "$T" --rig .. --base main --branch feat
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q -- '--rig must be a plain rig name, got: \.\.' <<<"$out" \
  && ok "review.sh --rig .. exits 2 naming the value" || no "rig .." "rc=$rc sent=$sent out=$out"
run "$T" --rig demo/.. --base main --branch feat
[ "$rc" = 2 ] && [ ! -f "$T/sent" ] && grep -q -- '--rig must be a plain rig name' <<<"$out" \
  && ok "review.sh --rig a/b (demo/..) exits 2" || no "rig a/b" "rc=$rc sent=$sent out=$out"

# the reviewer's runnable check (s-6e4e, hq-40n2x.1 comment 19:14), verbatim
cat >"$T/difffile-empty.sh" <<'EOS'
#!/bin/bash
set -u; SRC="$1"; X=$(mktemp -d); trap 'rm -rf "$X"' EXIT
git -c init.defaultBranch=main init -q "$X/hq"; cd "$X/hq"
git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
echo CLIENT-SECRET-42 > client-notes.md
sed 's#^printf .%s. "\$diff" | head -c 200000 > "\$tmpdiff"#&; cp "\$tmpdiff" "$SENT"#' "$SRC/ops/scripts/review.sh" > "$X/review.sh"
printf '#!/bin/bash\nSENT=%s/sent HQ_ROOT=%s/hq bash %s/review.sh --dry-run "$@" >%s/child.out 2>&1; echo "rc=$?" >>%s/child.out\n' "$X" "$X" "$X" "$X" "$X" > "$X/lucy"; chmod +x "$X/lucy"
cd /
HQ_ROOT="$X/hq" HQ_LUCY_BIN="$X/lucy" HQ_ORCH_RUN=/bin/true HQ_BD=true HQ_ORCH_DIR="$X/orch" bash "$SRC/ops/scripts/lucy-bg.sh" --bead hq-x --diff-file "" "ctx" >/dev/null 2>&1; echo "lucy-bg rc=$?"
for i in $(seq 40); do grep -q rc= "$X/child.out" 2>/dev/null && break; sleep 0.25; done
if grep -q CLIENT-SECRET-42 "$X/sent" 2>/dev/null; then echo "FAIL: untracked client-notes.md from \$ROOT was in the sent diff"; exit 1; else echo "PASS: nothing from the working tree sent"; fi
EOS
o="$(bash "$T/difffile-empty.sh" "$HERE/../.." 2>&1)"
grep -q 'lucy-bg rc=2' <<<"$o" && grep -q '^PASS' <<<"$o" && ok "reviewer's difffile-empty.sh: lucy-bg rc=2, PASS" || no "difffile-empty.sh" "$o"

# positive: a real --branch and a real --diff-file still start lucy (dry-run child)
waitsent(){ local i; for i in $(seq 60); do [ -s "$T/sent" ] && return 0; sleep 0.25; done; return 1; }
rm -rf "$T/orch2"; lb --bead hq-p1 --rig hq --base main --branch feat --dry-run "ctx"
[ "$r" = 0 ] && grep -q 'started for hq-p1' <<<"$o" && waitsent && grep -q '^diff --git a/feat.txt' "$T/sent" && ! grep -q 'CLIENT FINANCIAL' "$T/sent" \
  && ok "lucy-bg --branch feat (dry-run) starts and sends only the branch" || no "lucy-bg --branch positive" "rc=$r $o"
rm -rf "$T/orch2"; lb --bead hq-p2 --diff-file "$T/d.diff" --dry-run "ctx"
[ "$r" = 0 ] && grep -q 'started for hq-p2' <<<"$o" && waitsent && grep -q '^diff --git a/x' "$T/sent" \
  && ok "lucy-bg --diff-file <real file> (dry-run) starts and sends that file" || no "lucy-bg --diff-file positive" "rc=$r $o"

[ "$fail" = 0 ] && echo "ALL PASS"
exit $fail
