#!/usr/bin/env bash
# notify.sh delivery status (hq-fgg3.14): exits nonzero when the ntfy push
# fails, 0 when it is delivered or when nothing needed pushing. Hermetic: the
# script runs from a throwaway tree with no ops/.env and a stub bell.sh, and the
# only real network call targets 127.0.0.1:9 (nothing listens, nothing is sent).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/ops/scripts/lib" "$T/ops/console" "$T/bin" "$T/state"
cp "$REPO/ops/scripts/notify.sh" "$REPO/ops/scripts/monitor.sh" "$T/ops/scripts/"
cp "$REPO/ops/scripts/lib/orchestrator-event.sh" "$T/ops/scripts/lib/"
printf '#!/bin/sh\nexit 0\n' >"$T/ops/console/bell.sh"; chmod +x "$T/ops/console/bell.sh"
unset HQ_NO_NOTIFY NTFY_SERVER
N="$T/ops/scripts/notify.sh"
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
check() { # check <want-rc> <got-rc> <name>
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (want rc $1, got $2)"; fi
}

# A curl shim: logs its args, exits with $CURL_RC.
cat >"$T/bin/curl" <<EOF
#!/bin/sh
echo "\$*" >>"$T/curl.log"
printf '%s' "\${CURL_CODE:-200}"
exit "\${CURL_RC:-0}"
EOF
chmod +x "$T/bin/curl"

# 1. real curl, unreachable server: nonzero, and says so on stderr
NTFY_TOPIC=t NTFY_SERVER=http://127.0.0.1:9 "$N" urgent "T" "m" 2>"$T/err"; rc=$?
[ "$rc" -ne 0 ] && ok "unreachable ntfy exits nonzero (rc $rc)" || bad "unreachable ntfy exits nonzero"
grep -q 'delivery failed' "$T/err" && ok "failure reported on stderr" || bad "failure reported on stderr"

# 2. shimmed success: 0, one call to the configured server with --fail
: >"$T/curl.log"
PATH="$T/bin:$PATH" CURL_RC=0 NTFY_TOPIC=t NTFY_SERVER=http://shim "$N" urgent "T" "m"; rc=$?
check 0 "$rc" "delivered push exits 0"
grep -q -- '--fail' "$T/curl.log" && grep -q 'http://shim/t' "$T/curl.log" \
  && ok "curl called with --fail at the configured server" || bad "curl args: $(cat "$T/curl.log")"

# 3. shimmed HTTP error (curl --fail exits 22): nonzero
PATH="$T/bin:$PATH" CURL_RC=22 NTFY_TOPIC=t NTFY_SERVER=http://shim "$N" urgent "T" "m" 2>/dev/null; rc=$?
check 1 "$rc" "HTTP error exits 1"

# 3b. real curl against a local HTTP server: 302 fails, 200 succeeds
cat >"$T/srv.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        code = 302 if self.path.endswith("/redir") else 200
        self.send_response(code)
        if code == 302: self.send_header("Location", "http://127.0.0.1:9/")
        self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, *a): pass
s = HTTPServer(("127.0.0.1", 0), H)
print(s.server_port, flush=True)
s.serve_forever()
PY
python3 "$T/srv.py" >"$T/port" & SRV=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT="$(cat "$T/port")"
NTFY_TOPIC=redir NTFY_SERVER="http://127.0.0.1:$PORT" "$N" urgent "T" "m" 2>"$T/err"; rc=$?
check 1 "$rc" "302 from ntfy server exits 1"
grep -q 'http 302' "$T/err" && ok "302 named on stderr" || bad "302 named on stderr: $(cat "$T/err")"
NTFY_TOPIC=ok NTFY_SERVER="http://127.0.0.1:$PORT" "$N" urgent "T" "m"; check 0 $? "200 from ntfy server exits 0"
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null

# 3c. shimmed curl rc 0 but a non-2xx code: nonzero
PATH="$T/bin:$PATH" CURL_RC=0 CURL_CODE=304 NTFY_TOPIC=t NTFY_SERVER=http://shim "$N" urgent "T" "m" 2>/dev/null; rc=$?
check 1 "$rc" "curl rc 0 with http 304 exits 1"

# 4. paths that never push: exit 0 and never call curl
: >"$T/curl.log"
PATH="$T/bin:$PATH" CURL_RC=7 NTFY_TOPIC=t "$N" low "T" "m"; check 0 $? "low exits 0"
PATH="$T/bin:$PATH" CURL_RC=7 NTFY_TOPIC=t "$N" default "T" "m"; check 0 $? "default exits 0"
PATH="$T/bin:$PATH" CURL_RC=7 NTFY_TOPIC=t HQ_NO_NOTIFY=1 "$N" urgent "T" "m"; check 0 $? "HQ_NO_NOTIFY exits 0"
PATH="$T/bin:$PATH" CURL_RC=7 NTFY_TOPIC= "$N" urgent "T" "m"; check 0 $? "no topic exits 0"
[ -s "$T/curl.log" ] && bad "non-push paths called curl" || ok "non-push paths never call curl"

# 4b. orchestrator events (hq-4npjr.3): three titles emit, others do not, status unchanged
EVF="$T/events.jsonl"; : >"$EVF"
for t in "Task done" "Review verdict" "Merge ready" "Other"; do
  HQ_EVENTS_FILE="$EVF" HQ_NO_NOTIFY=1 "$N" low "$t" "hq-x $t"; check 0 $? "event title '$t' exits 0"
done
python3 - "$EVF" <<'PY' && ok "events: exactly worker_done, review_verdict, merge_ready, valid json" || bad "events content: $(cat "$EVF")"
import json,sys
ev=[json.loads(l) for l in open(sys.argv[1])]
assert [e["type"] for e in ev]==["worker_done","review_verdict","merge_ready"], ev
assert ev[0]["detail"]=="hq-x Task done" and ev[0]["ts"]
PY
HQ_STATE_DIR="$T/st" HQ_NO_NOTIFY=1 "$N" low "Task done" "x"
[ -e "$T/st/orchestrator/events.jsonl" ] && bad "HQ_NO_NOTIFY alone wrote an event" || ok "HQ_NO_NOTIFY alone writes no event"
HQ_EVENTS_FILE=/proc/nope/e.jsonl HQ_NO_NOTIFY=1 "$N" low "Task done" "x"; check 0 $? "unwritable events file never fails notify"
PATH="$T/bin:$PATH" CURL_RC=22 HQ_EVENTS_FILE="$EVF" NTFY_TOPIC=t NTFY_SERVER=http://shim "$N" urgent "Task done" "m" 2>/dev/null; check 1 $? "event emit keeps a failed push exit 1"

# 4c. fields (hq-4npjr.8): bead and session from env, verdict parsed, unknown stays empty
EV2="$T/ev2.jsonl"; : >"$EV2"
E() { HQ_EVENTS_FILE="$EV2" HQ_NO_NOTIFY=1 "$@"; }
E env HQ_BEAD=hq-9 HQ_SESSION_ID=s-ab12 "$N" low "Task done" "title"
E "$N" low "Review verdict" "VERDICT: block, 2 findings"
E "$N" low "Review verdict" "reviewer approved the branch"
E "$N" low "Review verdict" "approve but also block"
python3 - "$EV2" <<'PY' && ok "events carry bead, session, verdict" || bad "event fields: $(cat "$EV2")"
import json,sys
e=[json.loads(l) for l in open(sys.argv[1])]
assert (e[0]["bead"],e[0]["session"])==("hq-9","s-ab12") and "verdict" not in e[0], e[0]
assert (e[1]["bead"],e[1]["session"],e[1]["verdict"])==("","","block"), e[1]
assert e[2]["verdict"]=="approve", e[2]
assert e[3]["verdict"]=="", e[3]
PY

# 5. monitor.sh survives a failed disk alert (loop caller must keep going)
cat >"$T/ops/scripts/notify.sh" <<EOF
#!/bin/sh
echo "\$*" >>"$T/notified"; exit 1
EOF
chmod +x "$T/ops/scripts/notify.sh"
printf '#!/bin/sh\necho Avail; echo 1G\n' >"$T/bin/df"; chmod +x "$T/bin/df"
PATH="$T/bin:$PATH" HQ_ROOT="$T" "$T/ops/scripts/monitor.sh" --once >/dev/null 2>&1; rc=$?
check 0 "$rc" "monitor.sh tick completes after a failed alert"
grep -q 'urgent Disk low' "$T/notified" 2>/dev/null && ok "monitor.sh attempted the alert" || bad "monitor.sh attempted the alert"

echo "notify.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
