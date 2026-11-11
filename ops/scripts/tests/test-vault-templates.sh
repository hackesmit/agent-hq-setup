#!/usr/bin/env bash
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../../.." && pwd)"
T="$HQ/ops/templates/vault-workspace"
fail=0
check(){ if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
check "rig template exists"      "[ -f '$T/_index.rig.md' ]"
check "bunker template exists"   "[ -f '$T/_index.bunker.md' ]"
check "readme exists"            "[ -f '$T/README.md' ]"
for f in _index.rig.md _index.bunker.md; do
  check "$f has ## Map"          "grep -q '^## Map' '$T/$f'"
  check "$f has ## Decisions"    "grep -q '^## Decisions' '$T/$f'"
  check "$f has {{NAME}} token"  "grep -q '{{NAME}}' '$T/$f'"
  check "$f has {{DATE}} token"  "grep -q '{{DATE}}' '$T/$f'"
  check "$f no em dash"          "! grep -qP '\\x{2014}' '$T/$f'"
done
[ "$fail" = 0 ] && echo "TEMPLATES OK" || exit 1
