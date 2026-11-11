#!/usr/bin/env bash
# orch_usage.py (hq-4npjr.7): per-model windows from the call log, share of HQ usage from the
# usage table, one alert per ISO week past the threshold, and the call log fields the runner writes.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$REPO/ops/scripts/orch_usage.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "ok   $1"; }; bad(){ fail=$((fail+1)); echo "FAIL $1"; }
is(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }
mkdir -p "$T/orch" "$T/bin"
printf '#!/bin/sh\necho "$*" >>%s/notify.log\n' "$T" >"$T/bin/notify.sh"; chmod +x "$T/bin/notify.sh"
export HQ_ROOT="$T" HQ_ORCH_DIR="$T/orch" HQ_USAGE_DB="$T/u.sqlite" HQ_USAGE_CACHE="$T/plan.json" HQ_NOTIFY="$T/bin/notify.sh" HQ_ORCH_CONFIG="$T/none.json"
unset HQ_ORCH_ALERT_SHARE
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; old="$(date -u -d '10 days ago' +%Y-%m-%dT%H:%M:%SZ)"
cat >"$T/orch/spend.jsonl" <<EOF
{"ts":"$now","id":"a","model":"claude-fable-5-1","role":"decide","kind":"merge_ready","input_tokens":100,"output_tokens":40,"cost_usd":0.5}
{"ts":"$now","id":"b","model":"claude-sonnet-5-5","role":"triage","kind":"worker_ask","input_tokens":10,"output_tokens":5,"cost_usd":0.1}
not json
{"ts":"$now","id":"c","model":"claude-fable-5-1","cost_usd":0.25}
{"ts":"$old","id":"d","model":"claude-fable-5-1","input_tokens":999,"output_tokens":999,"cost_usd":9}
EOF
python3 - "$T/u.sqlite" "$now" <<'P'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE api_request (request_key TEXT PRIMARY KEY, ts TEXT, cost_usd REAL, hq_session TEXT)")
c.executemany("INSERT INTO api_request VALUES (?,?,?,?)", [("1", sys.argv[2], 2.0, "orchestrator-run"), ("2", sys.argv[2], 6.0, "s-abcd"), ("3", sys.argv[2], 2.0, None)])
c.commit()
P
printf '{"weekly_pct": 41}' >"$T/plan.json"
S="$(python3 "$PY" summary)"
is "week calls ignore the old row and the junk line" "$(jq .week.calls <<<"$S")" "3"
is "week tokens summed" "$(jq '.week.inputTokens + .week.outputTokens' <<<"$S")" "155"
is "models sorted by cost, fable first" "$(jq -r '.week.models[0].model' <<<"$S")" "claude-fable-5-1"
is "a row without tokens counts as zero" "$(jq '.week.models[0].outputTokens' <<<"$S")" "40"
is "share is orchestrator cost over all HQ cost" "$(jq .shareOfHq <<<"$S")" "0.2"
is "default threshold" "$(jq .threshold <<<"$S")" "0.25"
is "plan weekly percent read" "$(jq .planWeeklyPct <<<"$S")" "41.0"
is "retro line names the share" "$(python3 "$PY" retro | grep -c 'share of HQ usage 20.0%')" "1"

python3 "$PY" check >/dev/null
is "no alert below the threshold" "$([ -f "$T/notify.log" ] && echo yes || echo no)" "no"
[ -f "$T/orch/usage.json" ] && ok "check writes usage.json for the console" || bad "usage.json missing"

export HQ_ORCH_ALERT_SHARE=0.15
python3 "$PY" check >/dev/null; python3 "$PY" check >/dev/null
is "one alert past the threshold, not two" "$(wc -l <"$T/notify.log" | tr -d ' ')" "1"
grep -q '^default Orchestrator usage high' "$T/notify.log" && ok "alert is notify default" || bad "alert level/title"
export HQ_ORCH_ALERT_SHARE=bogus
is "a junk threshold falls back to 0.25" "$(python3 "$PY" summary | jq .threshold)" "0.25"
export HQ_ORCH_ALERT_SHARE=0.15
python3 - "$T/u.sqlite" <<'P'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("UPDATE api_request SET cost_usd = cost_usd / 100"); c.commit()
P
rm -f "$T/notify.log" "$T"/orch/paged-usage-*
python3 "$PY" check >/dev/null
is "no alert while HQ weekly usage is tiny" "$([ -f "$T/notify.log" ] && echo yes || echo no)" "no"
rm -f "$T/u.sqlite"
is "an unreadable table gives a null share, not a crash" "$(python3 "$PY" summary | jq .shareOfHq)" "null"

# the runner writes the call log fields
mkdir -p "$T/root/ops/scripts" "$T/root/state"
cat >"$T/bin/claude" <<'EOF'
#!/bin/sh
printf '%s' '{"is_error":false,"total_cost_usd":0.07,"usage":{"input_tokens":123,"output_tokens":45},"result":"OUTCOME: ok"}'
EOF
chmod +x "$T/bin/claude"
rm -rf "$T/orch"; mkdir -p "$T/orch"
printf '{"id":"e1","type":"merge_done","bead":"hq-x"}\n' >"$T/orch/events.jsonl"
HQ_ORCH_CLAUDE="$T/bin/claude" HQ_ORCH_CTL=true python3 -I "$REPO/ops/scripts/orchestrator_run.py" run >/dev/null 2>&1
L="$(tail -1 "$T/orch/spend.jsonl")"
is "runner logs role" "$(jq -r .role <<<"$L")" "triage"
is "runner logs event kind" "$(jq -r .kind <<<"$L")" "merge_done"
is "runner logs tokens" "$(jq -c '[.input_tokens,.output_tokens]' <<<"$L")" "[123,45]"
[ -f "$T/orch/usage.json" ] && ok "runner refreshes usage.json after a run" || bad "runner left no usage.json"

echo "pass $pass fail $fail"
[ "$fail" -eq 0 ]
