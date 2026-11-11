#!/usr/bin/env bash
# review-timeout.test.sh (hq-kptb3.3): a lucy transport timeout (HTTP 0) is retried
# once at effort high, visibly, with the cap checked again first; a second timeout
# exits 7 with the did-not-run text. Offline: --self-test drives the real send
# against a slow local server (a read timeout is HTTP 0), and --self-test-response
# replays fixture responses where {"transport_error": "..."} is a simulated timeout.
# No key is read and nothing is sent to the vendor.
#
# Run: bash ops/tests/review-timeout.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HERE/../scripts/review.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0; n=0
ok(){ n=$((n+1)); printf 'PASS  %s\n' "$1"; }
no(){ n=$((n+1)); printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

bash -n "$R" && ok "bash -n review.sh" || no "bash -n review.sh"

out="$("$R" --self-test 2>&1)"; rc=$?
grep -q '^PASS  a read timeout is HTTP 0 and raises Transport' <<<"$out" \
  && ok "the real send maps a read timeout to HTTP 0" || no "send timeout is HTTP 0" "$out"
grep -q '^PASS  read timeout 2400 s' <<<"$out" && ok "read timeout is 2400 s, retry effort high or lower" || no "2400 s" "$out"
[ $rc = 0 ] && ok "self-test exits 0" || no "self-test exits 0" "rc=$rc"

good='{"choices":[{"message":{"content":"no defects\nVERDICT: SHIP"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":100}}'
tmo='{"transport_error":"The read operation timed out"}'
replay(){ # $1 = JSON array of responses; env passes through
  printf '%s' "$1" > "$T/resp.json"; : > "$T/log"
  LUCY_REPLAY_LOG="$T/log" "$R" --self-test-response "$T/resp.json" >"$T/o" 2>"$T/e"; echo $?; }
sent(){ grep -o 'sent effort=[a-zA-Z]*' "$T/e" | sed 's/sent effort=//' | paste -sd, -; }

# a timeout then a success: exit 0, retried at high, visible, both attempts logged
rc="$(replay "[$tmo,$good]")"
[ "$rc" = 0 ] && grep -q 'VERDICT: SHIP' "$T/o" && ok "timeout then success exits 0 with the VERDICT" || no "timeout then success" "rc=$rc $(cat "$T/o" "$T/e")"
grep -q 'retry 1 of 1 at effort high after a transport timeout' "$T/e" && ok "the retry is visible on stderr" || no "retry visible" "$(cat "$T/e")"
[ "$(sent)" = "xhigh,high" ] && ok "the retry downgrades xhigh to high" || no "effort downgrade" "$(sent)"
st="$(jq -r '.status' "$T/log" | paste -sd, -)"
[ "$st" = "transport-failed,ok" ] && ok "both attempts are logged (cap counts the retry)" || no "two log lines" "$st"
est="$(jq -r 'select(.status=="transport-failed") | "\(.usage_estimated) \(.prompt_tokens > 0) \(.cost_usd > 0)"' "$T/log")"
[ "$est" = "true true true" ] && ok "the failed attempt carries an estimated input cost" || no "estimated cost" "$est"
eff="$(jq -r '.effort' "$T/log" | paste -sd, -)"
[ "$eff" = "xhigh,high" ] && ok "log lines record xhigh then high" || no "logged efforts" "$eff"

# two timeouts: exit 7, nothing on stdout, did-not-run text, exactly two sends
rc="$(replay "[$tmo,$tmo]")"
[ "$rc" = 7 ] && [ ! -s "$T/o" ] && ok "two timeouts exit 7 with nothing on stdout" || no "two timeouts exit 7" "rc=$rc $(cat "$T/o")"
grep -q 'lucy did NOT run' "$T/e" && ok "the second failure prints the did-not-run text" || no "did-not-run text" "$(cat "$T/e")"
[ "$(sent)" = "xhigh,high" ] && ok "exactly one retry, never a third send" || no "one retry only" "$(sent)"
[ "$(jq -r '.status' "$T/log" | paste -sd, -)" = "transport-failed,transport-failed" ] \
  && ok "both failed attempts are logged" || no "two failed lines" "$(cat "$T/log")"

# the asked effort is kept when it is already high or lower
rc="$(REPLAY_EFFORT=medium replay "[$tmo,$good]")"
[ "$rc" = 0 ] && [ "$(sent)" = "medium,medium" ] && grep -q 'retry 1 of 1 at effort medium' "$T/e" \
  && ok "a medium review retries at medium, never higher" || no "medium stays medium" "rc=$rc $(sent)"

# the cap is checked again before the retry: over it, exit 6 and no second send
printf '{"ts":"%s","cost_usd":9}\n' "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$T/full.log"
printf '%s' "[$tmo,$good]" > "$T/resp.json"
LUCY_REPLAY_LOG="$T/full.log" LUCY_REPLAY_CAP_USD=5 "$R" --self-test-response "$T/resp.json" >"$T/o" 2>"$T/e"; rc=$?
[ "$rc" = 6 ] && [ "$(sent)" = "xhigh" ] && grep -q 'refused the retry' "$T/e" \
  && ok "over the cap after a timeout: exit 6, no retry sent" || no "cap before retry" "rc=$rc $(sent) $(cat "$T/e")"
# the recheck reads the log fresh, failed attempt included: under the cap before the
# first send, over it only once that attempt's estimated cost is logged
printf '{"ts":"%s","cost_usd":4.99999}\n' "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$T/edge.log"
LUCY_REPLAY_LOG="$T/edge.log" LUCY_REPLAY_CAP_USD=5 "$R" --self-test-response "$T/resp.json" >"$T/o" 2>"$T/e"; rc=$?
[ "$rc" = 6 ] && [ "$(sent)" = "xhigh" ] && [ "$(jq -r '.status' "$T/edge.log" | tail -1)" = "transport-failed" ] \
  && ok "the failed attempt's own cost counts toward the retry's cap check" || no "fresh recheck" "rc=$rc $(sent) $(cat "$T/e")"
LUCY_REPLAY_LOG="$T/log2" LUCY_REPLAY_CAP_USD=5 "$R" --self-test-response "$T/resp.json" >"$T/o" 2>"$T/e"; rc=$?
[ "$rc" = 0 ] && [ "$(sent)" = "xhigh,high" ] && ok "under the cap the retry runs" || no "under cap retries" "rc=$rc $(sent)"

# a non-transport failure is unchanged: an HTTP error still exits 4 with no retry
# (covered by --self-test 'any other 400'); a success with no timeout sends once
rc="$(replay "[$good]")"
[ "$rc" = 0 ] && [ "$(sent)" = "xhigh" ] && ! grep -q 'retry 1 of 1' "$T/e" && ok "no timeout, no retry" || no "no retry on success" "rc=$rc $(sent)"

echo "$n cases"
[ "$fail" = 0 ] && echo "ALL PASS"
exit "$fail"
