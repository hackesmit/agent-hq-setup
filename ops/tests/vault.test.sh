#!/usr/bin/env bash
# Fixture tests for vault.sh — appends tagged knowledge to the outbox KB note.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
V="$DIR/../scripts/vault.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

export HQ_ROOT="$(mktemp -d)"; export CDP_TERMINAL_ID="t-test"
trap 'rm -rf "$HQ_ROOT"' EXIT
NOTE="$HQ_ROOT/outbox/vault/01 Projects/foo/Knowledge.md"

# first note creates the KB with a header + the entry
"$V" foo "always run migrations before the suite" --tag gotcha >/dev/null
[ -f "$NOTE" ] && ok "creates the KB note" || no "creates the KB note"
grep -q '^# foo — Knowledge base' "$NOTE" && ok "has a header" || no "has a header"
grep -q '#gotcha' "$NOTE" && grep -q 'migrations before the suite' "$NOTE" && ok "records tagged entry" || no "records tagged entry"
grep -q '(t-test)' "$NOTE" && ok "attributes the session" || no "attributes the session"

# second note appends (does not clobber)
"$V" foo "prefer the CLI over the MCP" --tag pattern >/dev/null
n=$(grep -c '^- ' "$NOTE")
[ "$n" = 2 ] && ok "appends (2 entries)" || no "appends (2 entries)" "n=$n"

# default tag is note
"$V" foo "misc thing" >/dev/null
grep -q '#note' "$NOTE" && ok "default tag is note" || no "default tag is note"

# rig="." infers rig from cwd (a rigs/<rig> dir)
mkdir -p "$HQ_ROOT/rigs/bar"; ( cd "$HQ_ROOT/rigs/bar" && git init -q 2>/dev/null; "$V" . "inferred" --tag command >/dev/null )
[ -f "$HQ_ROOT/outbox/vault/01 Projects/bar/Knowledge.md" ] && ok "rig='.' infers from cwd" || no "rig='.' infers from cwd"

# missing text errors
"$V" foo >/dev/null 2>&1; [ "$?" != 0 ] && ok "missing text errors" || no "missing text errors"

[ "$fail" = 0 ] && echo "VAULT TESTS: PASS" || { echo "VAULT TESTS: FAIL"; exit 1; }
