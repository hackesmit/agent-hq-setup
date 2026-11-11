#!/usr/bin/env bash
# Fixture tests for console.sh — isolated via HQ_ROOT/HQ_STATE_DIR.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
WR_SH="$DIR/../scripts/console.sh"
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }
jq_(){ python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

export HQ_ROOT="$(mktemp -d)"; export HQ_STATE_DIR="$HQ_ROOT/state"
mkdir -p "$HQ_ROOT/ops/scripts"
trap 'rm -rf "$HQ_ROOT"' EXIT

# phase set / check / list
"$WR_SH" phase set ck-a3f2 "scaffold, tests, wire API, review" --session s-a3f2 --title "wire weather API" >/dev/null
n="$(cat "$HQ_STATE_DIR/console/phases/ck-a3f2.json" | jq_ 'len(d["phases"])')"
eq "phase set creates 4 phases" "$n" "4"
"$WR_SH" phase check ck-a3f2 "tests" >/dev/null
done2="$(cat "$HQ_STATE_DIR/console/phases/ck-a3f2.json" | jq_ '[p for p in d["phases"] if p["name"]=="tests"][0]["done"]')"
eq "phase check marks done (fuzzy)" "$done2" "True"
"$WR_SH" phase list ck-a3f2 | grep -q '\[x\] tests' && ok "phase list shows checked" || no "phase list shows checked"

# ask -> request filed + returned id; requests lists it; resolve clears it
rid="$("$WR_SH" ask "which API key?" --bead ck-a3f2 --session s-a3f2 2>/dev/null)"
case "$rid" in r-*) ok "ask returns r- id";; *) no "ask returns r- id" "$rid";; esac
"$WR_SH" requests | grep -q "which API key" && ok "requests lists open ask" || no "requests lists open ask"
"$WR_SH" resolve "$rid" >/dev/null
[ -z "$("$WR_SH" requests)" ] && ok "resolve clears request" || no "resolve clears request"

# log-change appends
"$WR_SH" log-change "installed rtk 0.43" --session s-a3f2 >/dev/null
grep -q "installed rtk" "$HQ_STATE_DIR/console/changes.jsonl" && ok "log-change appends" || no "log-change appends"

# state aggregates (register a session so terminals show)
mkdir -p "$HQ_STATE_DIR/console"
printf '%s' '{"pct":42.5,"used":6000000,"max":14000000,"reset":"2026-07-15T04:00:00.000Z","remaining_min":120,"updated":"2026-07-14T23:00:00Z"}' > "$HQ_STATE_DIR/console/usage-cache.json"
"$REGSH" register --id s-a3f2 --kind worker --rig chesski --bead ck-a3f2 --window '%7' >/dev/null
st="$("$WR_SH" state)"
eq "state active_count" "$(printf '%s' "$st" | jq_ 'd["active_count"]')" "1"
eq "state has phases for bead" "$(printf '%s' "$st" | jq_ '"ck-a3f2" in d["phases"]')" "True"
eq "state changes present" "$(printf '%s' "$st" | jq_ 'len(d["changes"])>=1')" "True"
eq "state usage is pct" "$(printf '%s' "$st" | jq_ 'd["usage"]["pct"]')" "42.5"

[ "$fail" = 0 ] && echo "CONSOLE TESTS: PASS" || { echo "CONSOLE TESTS: FAIL"; exit 1; }
