#!/usr/bin/env bash
# Fixture: a new domain lands in egress-domains.jsonl, files no bead, and a second call is silent.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hook-egress-ledger.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/ops/scripts" "$T/bin" "$T/.claude"
cp "$HOOK" "$T/ops/scripts/"
printf '#!/bin/sh\nexit 0\n' > "$T/ops/scripts/notify.sh"; chmod +x "$T/ops/scripts/notify.sh"
# a bd stub that records any call: the hook must not call it
printf '#!/bin/sh\necho "$@" >> "%s/bd.calls"\n' "$T" > "$T/bin/bd"; chmod +x "$T/bin/bd"
run() { echo '{"tool_name":"Bash","session_id":"s-test","tool_input":{"command":"curl https://example-new.test/x"}}' \
  | PATH="$T/bin:$PATH" HOME="$T" CLAUDE_PROJECT_DIR="$T" bash "$T/ops/scripts/hook-egress-ledger.sh"; }
fail() { echo "FAIL: $1"; exit 1; }
run
J="$T/ops/metrics/egress-domains.jsonl"
[ "$(jq -r .domain "$J")" = example-new.test ] || fail "domain not logged"
[ "$(jq -r .session "$J")" = s-test ] || fail "session not logged"
[ ! -e "$T/bd.calls" ] || fail "hook called bd"
run
[ "$(wc -l < "$J")" = 1 ] || fail "known domain logged twice"
echo "PASS"
