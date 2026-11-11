#!/usr/bin/env bash
# otel-ledger.py: a real Claude Code 2.1.311 api_request export (fixture, account
# fields stripped) lands as one row with model, cost and tokens; an exporter retry
# is not counted twice; other events, junk bodies and hostile numbers change nothing.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$HERE/../services/otel-ledger/otel-ledger.py"
FIX="$HERE/otel-ledger.fixture.json"
T="$(mktemp -d)"; pid=""
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$T"' EXIT
fail=0; ok(){ echo "ok - $1"; }; bad(){ echo "not ok - $1"; fail=1; }
export HQ_OTEL_DB="$T/ledger.sqlite"
export HQ_OTEL_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
URL="http://127.0.0.1:$HQ_OTEL_PORT"
python3 -I "$PY" serve > "$T/out" 2> "$T/err" & pid=$!
for i in $(seq 50); do curl -s -o /dev/null "$URL/" -X POST -d x && break; sleep 0.1; done
post(){ curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' "$@"; }
q(){ python3 -c 'import sqlite3,sys;print("|".join(str(x) for r in sqlite3.connect(sys.argv[1]).execute(sys.argv[2]) for x in r))' "$HQ_OTEL_DB" "$1"; }

# 1. the real export: one api_request row with the usage fields, user_prompt dropped
c="$(post --data-binary @"$FIX" "$URL/v1/logs")"
[ "$c" = 200 ] && ok "fixture accepted" || bad "fixture accepted (got $c)"
[ "$(q 'select count(*) from api_request')" = 1 ] && ok "one row, user_prompt dropped" || bad "row count $(q 'select count(*) from api_request')"
got="$(q 'select model,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_creation_1h_tokens,hq_session,hq_bead,client_version from api_request')"
[ "$got" = "claude-haiku-5-5|0.00297662|2|4|11382|14303|s-test|hq-x|2.1.311" ] && ok "fields parsed" || bad "fields parsed: $got"
[ -n "$(q 'select session_id from api_request where session_id is not null')" ] && ok "session id kept" || bad "session id kept"

# 2. an exporter retry of the same batch is not counted twice
post --data-binary @"$FIX" "$URL/v1/logs" >/dev/null
[ "$(q 'select count(*) from api_request')" = 1 ] && ok "retry deduped on request_id" || bad "retry double-counted"

# 3. gzip body, intValue as a string, a fresh request id
python3 - "$FIX" "$T/gz.json.gz" <<'PYT'
import gzip, json, sys
d = json.load(open(sys.argv[1]))
for rl in d["resourceLogs"]:
    for sl in rl["scopeLogs"]:
        for r in sl["logRecords"]:
            for a in r["attributes"]:
                if a["key"] == "request_id": a["value"] = {"stringValue": "req_gz"}
                if a["key"] == "output_tokens": a["value"] = {"intValue": "77"}
open(sys.argv[2], "wb").write(gzip.compress(json.dumps(d).encode()))
PYT
c="$(post -H 'Content-Encoding: gzip' --data-binary @"$T/gz.json.gz" "$URL/v1/logs")"
[ "$c" = 200 ] && [ "$(q "select output_tokens from api_request where request_key='req_gz'")" = 77 ] \
  && ok "gzip and string intValue" || bad "gzip and string intValue (code $c)"

# 4. junk never lands, never kills the receiver
[ "$(post --data-binary 'not json' "$URL/v1/logs")" = 400 ] && ok "junk body is 400" || bad "junk body"
[ "$(post --data-binary '[1,2]' "$URL/v1/logs")" = 400 ] && ok "non-object is 400" || bad "non-object"
[ "$(post --data-binary '{"resourceMetrics":[]}' "$URL/v1/metrics")" = 200 ] && ok "metrics accepted and dropped" || bad "metrics path"
hostile='{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"claude_code.api_request"},"attributes":[
 {"key":"event.name","value":{"stringValue":"api_request"}},{"key":"request_id","value":{"stringValue":"req_bad"}},
 {"key":"cost_usd","value":{"doubleValue":"Infinity"}},{"key":"input_tokens","value":{"intValue":"-5"}},
 {"key":"output_tokens","value":{"boolValue":true}},{"key":"model","value":{"arrayValue":{}}},
 {"key":"user.email","value":{"stringValue":"a@b.c"}}]}, "junk", {"attributes":"x"}]}, 7]}, 3]}'
[ "$(post --data-binary "$hostile" "$URL/v1/logs")" = 200 ] && ok "hostile batch accepted" || bad "hostile batch"
[ "$(q "select coalesce(cost_usd,'N'),coalesce(input_tokens,'N'),coalesce(output_tokens,'N'),coalesce(model,'N') from api_request where request_key='req_bad'")" = "N|N|N|N" ] \
  && ok "hostile numbers stored as null" || bad "hostile numbers: $(q "select cost_usd,input_tokens,output_tokens,model from api_request where request_key='req_bad'")"
cols="$(q "select group_concat(name) from pragma_table_info('api_request')")"
echo "$cols" | grep -qiE 'email|account|prompt_text|organization' && bad "ledger has identity columns: $cols" || ok "no email, account or prompt columns"
grep -q 'a@b.c' "$HQ_OTEL_DB" && bad "email reached the db file" || ok "email never stored"
for body in '{"resourceLogs":5}' '{"resourceLogs":[{"resource":"x"}]}' '{"resourceLogs":[{"scopeLogs":7}]}' '{"resourceLogs":[{"scopeLogs":[{"logRecords":3}]}]}'; do
  c="$(post --data-binary "$body" "$URL/v1/logs")"
  [ "$c" = 400 ] && ok "malformed shape is 400: $body" || bad "malformed shape $body got $c"
done
kill -0 "$pid" 2>/dev/null && ok "receiver still up" || bad "receiver died"

# 5. the report the weekly review reads
rep="$(python3 -I "$PY" report --days 3650)"
echo "$rep" | grep -q 'claude-haiku-5-5' && echo "$rep" | grep -q 'hq-x' && ok "report by model and bead" || bad "report: $rep"
python3 -I "$PY" report --days 3650 --json | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["total"]["calls"]==3,d["total"]' \
  && ok "report --json totals" || bad "report --json totals"

# 6. install.sh env merge: adds the export keys, keeps the rest, refuses non-JSON
INST="$HERE/../services/otel-ledger/install.sh"
echo '{"model":"opus","env":{"KEEP":"1"},"hooks":{"Stop":[]}}' > "$T/settings.json"
HQ_CLAUDE_SETTINGS="$T/settings.json" HQ_OTEL_ENV_ONLY=1 bash "$INST" \
  && [ "$(jq -c '[.model,.env.KEEP,.env.CLAUDE_CODE_ENABLE_TELEMETRY,.env.OTEL_EXPORTER_OTLP_ENDPOINT,(.hooks|has("Stop"))]' "$T/settings.json")" \
       = '["opus","1","1","http://127.0.0.1:4318",true]' ] && ok "env merged, rest kept" || bad "env merge: $(cat "$T/settings.json")"
echo 'not json' > "$T/bad.json"
HQ_CLAUDE_SETTINGS="$T/bad.json" HQ_OTEL_ENV_ONLY=1 bash "$INST" 2>/dev/null && bad "non-JSON settings accepted" \
  || { [ "$(cat "$T/bad.json")" = "not json" ] && [ -z "$(ls "$T" | grep '^bad.json.')" ] && ok "non-JSON settings left alone" || bad "non-JSON settings changed"; }

[ "$fail" = 0 ] && echo "OTEL-LEDGER TESTS: PASS" || { echo "OTEL-LEDGER TESTS: FAIL"; exit 1; }
