#!/usr/bin/env bash
# review-log.test.sh: every lucy call that reaches the API writes one JSON line
# with tokens, cost and verdict, failed calls too; a daily spend cap from
# LUCY_DAILY_CAP_USD refuses before the key is read (hq-7llgp.5). Offline: the
# replay path stands in for the API and a fake pp records whether it ran.
#
# Run: bash ops/tests/review-log.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HERE/../scripts/review.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

# 1. a good review logs ok, its tokens, its cost at the gpt-6.1-sol rate, verdict and classes
cat > "$T/good.json" <<'J'
[{"choices":[{"finish_reason":"stop","message":{"content":"1. SEVERITY: MAJOR, CLASS: correctness. off by one.\n2. SEVERITY: MINOR, CLASS: hardening. nit.\nVERDICT: REVISE. Fix the loop."}}],
  "usage":{"prompt_tokens":100000,"completion_tokens":20000,"completion_tokens_details":{"reasoning_tokens":15000}}}]
J
LUCY_REPLAY_LOG="$T/log1.jsonl" "$R" --self-test-response "$T/good.json" >/dev/null 2>&1; rc=$?
row="$(cat "$T/log1.jsonl" 2>/dev/null)"
[ "$rc" = 0 ] && [ "$(wc -l <"$T/log1.jsonl")" = 1 ] \
  && jq -e '.status=="ok" and .verdict=="REVISE" and .cost_usd==0.4 and .priced==true
    and .prompt_tokens==100000 and .reasoning_tokens==15000 and .requests==1
    and .severity.MAJOR==1 and .severity.MINOR==1 and .severity.BLOCKER==0
    and .classes.correctness==1 and .classes.hardening==1 and (.ts|test("^[0-9]{4}-"))' <<<"$row" >/dev/null \
  && ok "a review writes one line: tokens, cost 0.40 USD, verdict, severity and class counts" || no "good log" "rc=$rc $row"

# 2. a failed review (empty twice) still logs both billed requests
cat > "$T/empty.json" <<'J'
[{"choices":[{"finish_reason":"length","message":{"content":""}}],"usage":{"prompt_tokens":1000,"completion_tokens":16000}},
 {"choices":[{"finish_reason":"length","message":{"content":""}}],"usage":{"prompt_tokens":1000,"completion_tokens":32000}}]
J
LUCY_REPLAY_LOG="$T/log2.jsonl" "$R" --self-test-response "$T/empty.json" >/dev/null 2>&1; rc=$?
row="$(cat "$T/log2.jsonl" 2>/dev/null)"
[ "$rc" = 5 ] && jq -e '.status=="failed-exit-5" and .requests==2 and .completion_tokens==48000 and .verdict==null' <<<"$row" >/dev/null \
  && ok "a failed review logs its billed tokens with status failed-exit-5" || no "failed log" "rc=$rc $row"

# 2b. the header form the live model writes; a severity word in prose is not a finding
cat > "$T/live.json" <<'J'
[{"choices":[{"finish_reason":"stop","message":{"content":"1. **MAJOR | robustness \u2014 Logging fails open** (x).\n   - **Why:** not a BLOCKER.\n2. **MINOR | correctness \u2014 parse** (y).\nVERDICT: REVISE \u2014 fix it."}}],
  "usage":{"prompt_tokens":10,"completion_tokens":10}}]
J
LUCY_REPLAY_LOG="$T/log2b.jsonl" "$R" --self-test-response "$T/live.json" >/dev/null 2>&1
row="$(cat "$T/log2b.jsonl" 2>/dev/null)"
jq -e '.severity=={"BLOCKER":0,"MAJOR":1,"MINOR":1} and .classes=={"robustness":1,"correctness":1}' <<<"$row" >/dev/null \
  && ok "live header form parsed; a BLOCKER word in prose is not counted" || no "live parse" "$row"

# 3. no LUCY_REPLAY_LOG: replay writes nothing anywhere under the hq root
before="$(find "$HERE/../metrics" -name 'lucy-calls.jsonl' -newer "$T/good.json" 2>/dev/null | wc -l)"
"$R" --self-test-response "$T/good.json" >/dev/null 2>&1
after="$(find "$HERE/../metrics" -name 'lucy-calls.jsonl' -newer "$T/good.json" 2>/dev/null | wc -l)"
[ "$before" = "$after" ] && ok "replay with no LUCY_REPLAY_LOG leaves the real log alone" || no "replay pollution"

# cap cases run against a fake hq root and a fake pp that leaves a marker
H="$T/hq"; mkdir -p "$H/ops/scripts" "$H/ops/metrics" "$T/bin"
cp "$R" "$H/ops/scripts/review.sh"
printf '#!/bin/sh\ntouch "%s/pp-ran"\n' "$T" > "$T/bin/pp"; chmod +x "$T/bin/pp"
today="$(date -u +%Y-%m-%d)"
{ printf '{"ts":"%sT01:00:00+00:00","cost_usd":1.5}\n' "$today"
  printf '{"ts":"%sT02:00:00+00:00","cost_usd":1.5}\n' "$today"
  printf 'not json\n'
  printf '{"ts":"2020-01-01T02:00:00+00:00","cost_usd":99}\n'; } > "$H/ops/metrics/lucy-calls.jsonl"
printf 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' > "$T/d.diff"
# lucy [VAR=value ...] [-- review args]
lucy(){ local e=(); while [ $# -gt 0 ] && [ "$1" != -- ]; do e+=("$1"); shift; done; [ $# -gt 0 ] && shift
  rm -f "$T/pp-ran"; env PATH="$T/bin:$PATH" HQ_ROOT="$H" "${e[@]}" "$H/ops/scripts/review.sh" --diff-file "$T/d.diff" --rig peel "$@"; }

# 4. the dry-run plan shows today's spend (old days and bad lines ignored) and the cap
p="$(lucy LUCY_DAILY_CAP_USD=2 -- --dry-run 2>/dev/null)"
grep -q 'spent_today_usd=3.0000 cap_usd=2' <<<"$p" && ok "plan shows 3.00 USD spent today against cap 2" || no "plan" "$p"

# 5. at or over the cap: refused with exit 6 and a clear message, pp never runs
err="$(lucy LUCY_DAILY_CAP_USD=2 2>&1 >/dev/null)"; rc=$?
[ "$rc" = 6 ] && [ ! -e "$T/pp-ran" ] && grep -q 'refused: lucy spent 3.0000 USD today' <<<"$err" && grep -q 'did NOT run' <<<"$err" \
  && ok "over the cap: exit 6, clear refusal, no credential read" || no "cap refusal" "rc=$rc $err"

# 6. under the cap: the call goes on to the credential (fake pp gives none, exit 1)
lucy LUCY_DAILY_CAP_USD=10 >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && [ -e "$T/pp-ran" ] && ok "under the cap: the call proceeds to the credential" || no "under cap" "rc=$rc"

# 7. default cap is 5 USD
(unset LUCY_DAILY_CAP_USD; lucy >/dev/null 2>&1); rc=$?
[ "$rc" = 1 ] && ok "default cap 5 USD lets 3 USD of spend through" || no "default cap" "rc=$rc"

# 8. a cap that is not a number is a usage error
lucy LUCY_DAILY_CAP_USD=lots >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$T/pp-ran" ] && ok "a non-numeric cap is exit 2" || no "bad cap" "rc=$rc"

# 9. accounting fails closed: an unreadable or unwritable log, or an unpriced model, refuses before pp
L="$H/ops/metrics/lucy-calls.jsonl"
chmod 000 "$L"; err="$(lucy LUCY_DAILY_CAP_USD=10 2>&1 >/dev/null)"; rc=$?; chmod 644 "$L"
[ "$rc" = 6 ] && [ ! -e "$T/pp-ran" ] && grep -q 'cannot read the call log' <<<"$err" \
  && ok "an unreadable log refuses (exit 6), no credential read" || no "unreadable log" "rc=$rc $err"
chmod 444 "$L"; err="$(lucy LUCY_DAILY_CAP_USD=10 2>&1 >/dev/null)"; rc=$?; chmod 644 "$L"
[ "$rc" = 6 ] && [ ! -e "$T/pp-ran" ] && grep -q 'not writable' <<<"$err" \
  && ok "an unwritable log refuses (exit 6), no credential read" || no "unwritable log" "rc=$rc $err"
err="$(lucy LUCY_DAILY_CAP_USD=10 -- --model o1 2>&1 >/dev/null)"; rc=$?
[ "$rc" = 6 ] && [ ! -e "$T/pp-ran" ] && grep -q 'no price for model o1' <<<"$err" \
  && ok "an unpriced model refuses (exit 6), no credential read" || no "unpriced model" "rc=$rc $err"
lucy LUCY_DAILY_CAP_USD=10 LUCY_MODEL_PRICE=15/60 -- --model o1 >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && [ -e "$T/pp-ran" ] && ok "LUCY_MODEL_PRICE prices an unlisted model and the call proceeds" || no "model price" "rc=$rc"
# 10. no VERDICT line: exit 7 even though the text came back, the log row has verdict null
printf '%s' '[{"choices":[{"finish_reason":"stop","message":{"content":"1. MINOR | other | nit."}}],"usage":{"prompt_tokens":10,"completion_tokens":10}}]' > "$T/nov.json"
LUCY_REPLAY_LOG="$T/log10.jsonl" "$R" --self-test-response "$T/nov.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 7 ] && jq -e '.verdict==null' "$T/log10.jsonl" >/dev/null && ok "an answer with no VERDICT exits 7" || no "no verdict" "rc=$rc"

# 11. CAP_CHECK, REPLAY and SELF_TEST in the caller's environment must not turn a live call into an offline exit 0
for v in CAP_CHECK REPLAY SELF_TEST; do
  rm -f "$T/pp-ran"
  out="$(lucy LUCY_DAILY_CAP_USD=10 $v=1 2>/dev/null)"; rc=$?
  [ "$rc" = 1 ] && [ -e "$T/pp-ran" ] || no "inherited $v" "rc=$rc"
done
grep -q 'env -u CAP_CHECK -u REPLAY -u SELF_TEST' "$R" && ok "the final call clears CAP_CHECK, REPLAY and SELF_TEST" || no "env -u missing"

# 12. a cost that is NaN, Infinity or negative does not reduce or poison the day's total
{ printf '{"ts":"%sT03:00:00+00:00","cost_usd":-100}\n' "$today"
  printf '{"ts":"%sT04:00:00+00:00","cost_usd":NaN}\n' "$today"
  printf '{"ts":"%sT05:00:00+00:00","cost_usd":Infinity}\n' "$today"
  printf '{"ts":"%sT06:00:00+00:00","cost_usd":-Infinity}\n' "$today"; } >> "$L"
p="$(lucy LUCY_DAILY_CAP_USD=2 -- --dry-run 2>/dev/null)"
grep -q 'spent_today_usd=3.0000 ' <<<"$p" && ok "negative and non-finite costs are ignored by the cap" || no "bad cost lines" "$p"
err="$(lucy LUCY_DAILY_CAP_USD=2 2>&1 >/dev/null)"; rc=$?
[ "$rc" = 6 ] && ok "the cap still refuses after bad cost lines" || no "cap after bad lines" "rc=$rc"

# 12b. finite lines that sum to inf must refuse, not read as 0 (review round 1 blocker)
cp "$L" "$T/log.keep"
{ printf '{"ts":"%sT07:00:00+00:00","cost_usd":1e308}\n' "$today"
  printf '{"ts":"%sT08:00:00+00:00","cost_usd":1e308}\n' "$today"; } >> "$L"
err="$(lucy LUCY_DAILY_CAP_USD=5 2>&1 >/dev/null)"; rc=$?
[ "$rc" = 6 ] && [ ! -e "$T/pp-ran" ] && grep -q 'not a finite number' <<<"$err" \
  && ok "an overflowing day total refuses (exit 6), no credential read" || no "overflow total" "rc=$rc $err"
cp "$T/log.keep" "$L"

# 13. the prompt lists permanent divergence under data-loss
grep -q 'diverges permanently between tabs' "$R" && ok "prompt names permanent divergence as data-loss" || no "prompt divergence"
exit $fail
