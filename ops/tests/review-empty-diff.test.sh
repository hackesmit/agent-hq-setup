#!/usr/bin/env bash
# review-empty-diff.test.sh (hq-4npjr.27): review.sh fails closed when there is
# no committed branch diff. On 2026-11-05 lucy ran from the hq main checkout
# (HEAD = main), the committed diff was empty, and every untracked file in ~/hq
# (client notes) went to the vendor as "the change".
# Offline: --dry-run, plus one run without it where a stub pp proves the key is
# never read. The text that would be sent is captured from a copy of review.sh.
#
# Run: bash ops/tests/review-empty-diff.test.sh   (exit 0 = ALL PASS)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HERE/../scripts/review.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

sed 's#^printf .%s. "\$diff" | head -c 200000 > "\$tmpdiff"#&; cp "\$tmpdiff" "$SENT"#' "$R" > "$T/review.sh"
grep -q 'cp "$tmpdiff" "$SENT"' "$T/review.sh" || { echo "FAIL  capture hook not installed"; exit 1; }
# a pp stub: any call leaves a marker, so "no key read, no API call" is checkable
mkdir -p "$T/bin"; printf '#!/bin/sh\ntouch "%s/pp-called"\n' "$T" >"$T/bin/pp"; chmod +x "$T/bin/pp"

g(){ git -c user.email=t@t -c user.name=t -c init.defaultBranch=main "$@"; }
H="$T/hq"; mkdir -p "$H"; g -C "$H" init -q
echo base >"$H/base.txt"; printf '.claude/\n' >"$H/.gitignore"; g -C "$H" add . ; g -C "$H" commit -qm base
echo "CLIENT FINANCIAL NOTE" >"$H/client-secret-notes.md"     # untracked, must never be sent
g -C "$H" worktree add -q -b feat "$H/.claude/worktrees/w" 2>/dev/null
W="$H/.claude/worktrees/w"
echo work >"$W/feat.txt"; g -C "$W" add feat.txt; g -C "$W" commit -qm feat

run(){ # $1 = cwd, rest = args; sets rc, out, sent (file names in the would-be diff)
  local d="$1"; shift; rm -f "$T/sent" "$T/pp-called"
  out="$(cd "$d" && PATH="$T/bin:$PATH" SENT="$T/sent" HQ_ROOT="$H" bash "$T/review.sh" "$@" 2>&1)"; rc=$?
  sent="$( [ -f "$T/sent" ] && grep -oE '^diff --git a/[^ ]+' "$T/sent" | sed 's#^diff --git a/##' | sort | tr '\n' ' ')"
}
clean(){ # $1 = label: nothing sent, no key read, no untracked path or content printed
  [ ! -f "$T/sent" ] && [ ! -e "$T/pp-called" ] && ! grep -q 'review-plan:' <<<"$out" \
    && ! grep -q 'client-secret-notes\|CLIENT FINANCIAL' <<<"$out" \
    && ok "$1: nothing sent, no key read, no untracked path printed" || no "$1 leak" "sent=$sent out=$out"
}

# (a) HEAD equals the base, untracked files present: exit 2 before any API call
run "$H" --base main --dry-run
[ "$rc" = 2 ] && grep -q 'HEAD of .* is the base main' <<<"$out" && grep -q -- '--branch' <<<"$out" \
  && ok "(a) main checkout at the base with untracked files exits 2 and names the fix" || no "(a) dry" "rc=$rc out=$out"
clean "(a) dry-run"
run "$H" --base main "ctx"
[ "$rc" = 2 ] && ok "(a) same without --dry-run exits 2" || no "(a) live" "rc=$rc out=$out"
clean "(a) live"
# a main checkout whose commits net to nothing (commit plus revert) is empty too
g -C "$H" checkout -q -b net0 && echo x >"$H/tmp.txt" && g -C "$H" add tmp.txt && g -C "$H" commit -qm add \
  && g -C "$H" rm -q tmp.txt && g -C "$H" commit -qm rm
run "$H" --base main --dry-run
[ "$rc" = 2 ] && grep -q 'empty committed diff' <<<"$out" && ok "(a) main checkout with a net-empty commit range exits 2" || no "(a) net0" "rc=$rc out=$out"
clean "(a) net-empty"
g -C "$H" checkout -q main

# (b) a worktree branch with a commit: diff built as today (committed + untracked work)
echo scratch >"$W/wip.txt"
run "$W" --base main --dry-run
[ "$rc" = 0 ] && [[ "$sent" =~ ^feat\.txt\ [^\ ]*/w/wip\.txt\ $ ]] && ! grep -q 'CLIENT FINANCIAL' "$T/sent" \
  && ok "(b) worktree with a commit reviews feat.txt plus its own untracked work" || no "(b)" "rc=$rc sent=$sent out=$out"

# (c) --branch from the main checkout: the sent diff equals git diff mb...ref
run "$H" --base main --branch feat --dry-run
want="$(g -C "$H" diff main...feat)"
[ "$rc" = 0 ] && [ "$(cat "$T/sent")" = "$want" ] && ok "(c) --branch feat from the main checkout sends exactly git diff main...feat" \
  || no "(c)" "rc=$rc sent=$sent out=$out"
run "$H" --base main --branch no-such-ref --dry-run
[ "$rc" = 2 ] && ok "(c) --branch with an unknown ref exits 2" || no "(c) unknown" "rc=$rc out=$out"
clean "(c) unknown ref"
run "$H" --base main --branch main --dry-run
[ "$rc" = 2 ] && grep -q 'empty diff' <<<"$out" && ok "(c) --branch whose merge-base is the ref exits 2 'empty diff'" || no "(c) empty" "rc=$rc out=$out"
clean "(c) empty branch"

# (d) --diff-file still works from the main checkout at the base
printf 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' >"$T/d.diff"
run "$H" --diff-file "$T/d.diff" --rig peel --dry-run
[ "$rc" = 0 ] && [ "$sent" = "x " ] && ok "(d) --diff-file is unchanged" || no "(d)" "rc=$rc sent=$sent out=$out"

exit $fail
