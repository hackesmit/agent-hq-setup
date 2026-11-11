#!/usr/bin/env bash
# Fixture cases for ops/scripts/hook-turn-state.sh.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)/scripts/hook-turn-state.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
run() { printf '{"hook_event_name":"%s"}' "$1" | env -u n -u HQ_CONSOLE_SID -u CDP_TERMINAL_ID HQ_TURN_DIR="$T" "${@:2}" "$H"; }
expect() { local f="$T/$1.json" want="$2"; if grep -q "\"turn\":\"$want\"" "$f" 2>/dev/null; then echo "ok   $3"; else echo "FAIL $3"; fail=1; fi; }

run UserPromptSubmit HQ_CONSOLE_SID=s-a; expect s-a working "prompt marks working"
run Stop CDP_TERMINAL_ID=s-a;           expect s-a idle "stop marks idle (spawn.sh id)"
run PreToolUse n=s-a;                   expect s-a working "a tool call after a blocked stop marks working again"
run Notification n=s-a;                 expect s-a working "other events change nothing"
run Stop n='../evil'
run Stop
if [ "$(ls "$T" | wc -l)" -eq 1 ]; then echo "ok   bad or missing ids write nothing"; else echo "FAIL bad or missing ids write nothing"; fail=1; fi
run Stop HQ_CONSOLE_SID=s-con CDP_TERMINAL_ID=s-wk; expect s-wk idle "a worker spawned from a console terminal writes its own id"
[ -e "$T/s-con.json" ] && { echo "FAIL console pane got the worker's turn"; fail=1; } || echo "ok   console pane untouched by its child"
run Stop HQ_CONSOLE_SID=s-ev HQ_SESSION_EVAL=1
[ -e "$T/s-ev.json" ] && { echo "FAIL session-eval child wrote a turn"; fail=1; } || echo "ok   session-eval child writes nothing"
before="$(cat "$T/s-a.json")"; sleep 1; run PreToolUse n=s-a
if [ "$before" = "$(cat "$T/s-a.json")" ]; then echo "ok   no rewrite when the turn is unchanged"; else echo "FAIL no rewrite when the turn is unchanged"; fail=1; fi
touch -d "10 minutes ago" "$T/s-a.json"; run PreToolUse n=s-a
if [ -n "$(find "$T/s-a.json" -mmin -1)" ]; then echo "ok   a working mark older than 5 minutes is refreshed"; else echo "FAIL a working mark older than 5 minutes is refreshed"; fail=1; fi
# hq-6ih29.1: the hook keeps no background count. Review repros A (a prompt mid-build)
# and C (a background Agent) end idle here by design; ops/console/liveness.py turns an
# idle record with live work into background (test_liveness.py covers both repros).
run UserPromptSubmit CDP_TERMINAL_ID=s-ra; run PreToolUse CDP_TERMINAL_ID=s-ra; run Stop CDP_TERMINAL_ID=s-ra
run UserPromptSubmit CDP_TERMINAL_ID=s-ra; run Stop CDP_TERMINAL_ID=s-ra
expect s-ra idle "repro A ends idle in the file (only turn end is recorded)"
if grep -q '"bg"' "$T/s-ra.json"; then echo "FAIL the record carries no background count"; fail=1; else echo "ok   the record carries no background count"; fi
exit $fail
