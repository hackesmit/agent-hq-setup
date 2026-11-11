#!/usr/bin/env bash
# Fixture test for restore-drill.sh --local (needs root for docker; run with
# sudo). A whole archive with quoted names and an empty table passes; a
# truncated archive or a missing file fails.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; D="$HERE/../restore-drill.sh"; FIX="$HERE/fixtures"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
rc() { bash "$D" --local "$1" >"$T/out" 2>&1; echo $?; }
check "tiny archive restores" "$(rc "$FIX/tiny.dump")" 0
check "quoted names and empty table restore" "$(rc "$FIX/quoted.dump")" 0
check "quoted: four tables compared" "$(grep -c '^tables 4, mismatches 0, empty and not created 0' "$T/out")" 1
head -c 60000 "$FIX/quoted.dump" >"$T/trunc.dump"
check "truncated archive fails" "$(rc "$T/trunc.dump")" 1
check "missing file fails" "$(rc "$T/nope.dump")" 1
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
