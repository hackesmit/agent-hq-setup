#!/usr/bin/env bash
# review-effort.test.sh (hq-pgbpq.5): lucy sends an explicit reasoning_effort.
# The effort fallback runs offline through review.sh --self-test (a stub API:
# a rejected effort steps down, xhigh to high to no param, and any other 400
# fails at once). The effort choice is read from --dry-run: xhigh for a money,
# auth, data or unknown rig, high otherwise, --effort wins, a bad value exits 2.
# No key is read and nothing is sent. hq-pgbpq.15: a corrupt tiers file is xhigh,
# and an empty answer or finish_reason length exits 5 after one larger retry.
#
# Run: bash ops/tests/review-effort.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HERE/../scripts/review.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

out="$("$R" --self-test 2>/dev/null)"; rc=$?
[ $rc = 0 ] && ! grep -q '^FAIL' <<<"$out" && ok "self-test: fallback chain and no-retry on other errors" || no "self-test" "rc=$rc $out"

printf 'diff --git a/x b/x\n+y\n' > "$T/d.diff"
plan(){ "$R" --diff-file "$T/d.diff" --dry-run "$@" 2>&1 | grep -o 'effort=[a-z]*'; }
for c in "lodgeco-system xhigh" "acme-avance xhigh" "hq xhigh" "peel high" "studioco-digital high" "no-such-rig xhigh"; do
  set -- $c
  [ "$(plan --rig "$1")" = "effort=$2" ] && ok "rig $1 reviews at $2" || no "rig $1 reviews at $2" "$(plan --rig "$1")"
done
[ "$(plan)" = "effort=xhigh" ] && ok "a diff file with no rig counts as unknown (xhigh)" || no "no rig is xhigh" "$(plan)"
[ "$(plan --rig lodgeco-system --effort medium)" = "effort=medium" ] && ok "--effort overrides the rig class" || no "--effort overrides" "$(plan --rig lodgeco-system --effort medium)"
"$R" --diff-file "$T/d.diff" --dry-run --effort extreme >/dev/null 2>&1; rc=$?
[ $rc = 2 ] && ok "an unknown --effort exits 2" || no "an unknown --effort exits 2" "rc=$rc"
out="$(cd "$HERE" && "$R" --dry-run 2>&1)"
grep -q 'effort=xhigh rig=hq' <<<"$out" && ok "a worktree of hq maps to rig hq" || no "worktree maps to hq" "$out"

# hq-pgbpq.15: a corrupt tiers file fails closed to xhigh, never down to high
mkdir -p "$T/hq/ops/config"; printf '{"rigs": {"peel": ' > "$T/hq/ops/config/security-tiers.json"
got="$(HQ_ROOT="$T/hq" "$R" --diff-file "$T/d.diff" --dry-run --rig peel 2>&1 | grep -o 'effort=[a-z]*')"
[ "$got" = "effort=xhigh" ] && ok "a corrupt tiers file reviews at xhigh" || no "corrupt tiers is xhigh" "$got"
# valid JSON with its keys missing is no better than a corrupt file
for body in '{}' '{"rigs":{}}' '{"rigs":{"peel":{}}}' '{"rigs":{"peel":{"classes":"public"}}}' '[]' 'null'; do
  printf '%s' "$body" > "$T/hq/ops/config/security-tiers.json"
  got="$(HQ_ROOT="$T/hq" "$R" --diff-file "$T/d.diff" --dry-run --rig peel 2>&1 | grep -o 'effort=[a-z]*')"
  [ "$got" = "effort=xhigh" ] && ok "tiers file $body reviews at xhigh" || no "tiers $body is xhigh" "$got"
done
# an explicit empty classes array is still a real no-class rig
printf '{"rigs":{"peel":{"classes":[]}}}' > "$T/hq/ops/config/security-tiers.json"
got="$(HQ_ROOT="$T/hq" "$R" --diff-file "$T/d.diff" --dry-run --rig peel 2>&1 | grep -o 'effort=[a-z]*')"
[ "$got" = "effort=high" ] && ok "classes [] in a minimal tiers file reviews at high" || no "classes [] is high" "$got"

# hq-pgbpq.15: an empty answer or a token cutoff is a failed review (exit 5), never a
# quiet empty one; one retry at twice the token budget gets a chance first.
# --self-test-response replays fixture API responses in order, offline.
good='{"choices":[{"message":{"content":"no defects\nVERDICT: SHIP"},"finish_reason":"stop"}],"usage":{}}'
empty='{"choices":[{"message":{"content":""},"finish_reason":"stop"}],"usage":{}}'
nullc='{"choices":[{"message":{"content":null},"finish_reason":"stop"}],"usage":{}}'
cut='{"choices":[{"message":{"content":"half a rev"},"finish_reason":"length"}],"usage":{"completion_tokens":16000}}'
replay(){ printf '%s' "$1" > "$T/resp.json"; "$R" --self-test-response "$T/resp.json" >"$T/o" 2>"$T/e"; echo $?; }
[ "$(replay "[$good]")" = 0 ] && grep -q 'VERDICT: SHIP' "$T/o" && ok "a full answer prints and exits 0" || no "full answer" "$(cat "$T/o" "$T/e")"
for c in "empty:$empty" "null:$nullc" "length:$cut" "nochoices:{\"choices\":[]}"; do
  n="${c%%:*}"; r="${c#*:}"
  rc="$(replay "[$r,$r]")"
  [ "$rc" = 5 ] && [ ! -s "$T/o" ] && grep -q 'retrying once with max_completion_tokens=32000' "$T/e" && grep -q 'no usable review' "$T/e" \
    && ok "$n twice exits 5 with nothing on stdout" || no "$n twice exits 5" "rc=$rc $(cat "$T/o" "$T/e")"
done
[ "$(replay "[$cut,$good]")" = 0 ] && grep -q 'VERDICT: SHIP' "$T/o" && ok "a cutoff then a full answer passes on the retry" || no "retry recovers" "$(cat "$T/o" "$T/e")"

[ "$fail" = 0 ] && echo "ALL PASS"
exit "$fail"
