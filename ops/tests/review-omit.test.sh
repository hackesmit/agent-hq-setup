#!/usr/bin/env bash
# review-omit.test.sh: lucy sends lock and generated files as a header line plus
# a changed-line count, not their contents; source files go whole; --full sends
# everything. Offline through --dry-run: no key is read and nothing is sent.
#
# Run: bash ops/tests/review-omit.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HERE/../scripts/review.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
big(){ for i in $(seq 1 400); do printf '+    "pkg-%s": "1.0.%s",\n' "$i" "$i"; done; }
{
  printf 'diff --git a/src/pay.js b/src/pay.js\n--- a/src/pay.js\n+++ b/src/pay.js\n@@ -1 +1 @@\n-a\n+b\n'
  printf 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1,400 @@\n'; big
  printf 'diff --git a/web/dist/app.min.js b/web/dist/app.min.js\n--- a/web/dist/app.min.js\n+++ b/web/dist/app.min.js\n@@ -1 +1 @@\n-x\n+y\n'
  printf 'diff --git a/uv.lock.md b/uv.lock.md\n--- a/uv.lock.md\n+++ b/uv.lock.md\n@@ -1 +1 @@\n-x\n+y\n'
} > "$T/d.diff"
plan(){ "$R" --diff-file "$T/d.diff" --dry-run --rig peel "$@" 2>/dev/null; }
p="$(plan)"; f="$(plan --full)"
grep -q 'omitted=2 ' <<<"$p" && ok "lockfile and minified bundle are omitted, a lookalike name is not" || no "omitted count" "$p"
b=$(grep -o 'diff_bytes=[0-9]*' <<<"$p" | cut -d= -f2); fb=$(grep -o 'diff_bytes=[0-9]*' <<<"$f" | cut -d= -f2)
[ "$b" -lt 1500 ] && [ "$fb" -gt 10000 ] && ok "omitted diff is small ($b bytes), --full sends it whole ($fb bytes)" || no "sizes" "$b vs $fb"
grep -q 'omitted=0 ' <<<"$f" && ok "--full omits nothing" || no "--full" "$f"
# the sent text keeps source hunks and the note, via a copy of the temp diff
out="$(HQ_ROOT="$HERE/../.." bash -c '
  sed "s#^printf .%s. \"\$diff\" | head -c 200000 > \"\$tmpdiff\"#&; cp \"\$tmpdiff\" '"$T"'/sent#" "$1" > '"$T"'/r.sh; bash '"$T"'/r.sh --diff-file '"$T"'/d.diff --dry-run --rig peel' _ "$R" 2>/dev/null)"
grep -q '^+b$' "$T/sent" && grep -q 'contents omitted (400 changed lines)' "$T/sent" && ! grep -q 'pkg-7' "$T/sent" \
  && ok "source hunk kept, lockfile reduced to its header and a 400-line note" || no "sent text" "$(head -c 300 "$T/sent" 2>/dev/null)"
exit $fail
