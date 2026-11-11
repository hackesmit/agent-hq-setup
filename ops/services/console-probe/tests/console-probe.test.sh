#!/usr/bin/env bash
# console-probe.test.sh: the probe pushes up for a listening port, down for a closed
# one, carries the release sha from the health file, and refuses to run without a token.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# a fake Kuma push endpoint that logs each request line
python3 -I - "$T/push.log" >"$T/push.port" <<'PY' &
import http.server, sys
log = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        open(log, "a").write(self.path + "\n"); self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H); print(s.server_port, flush=True); s.serve_forever()
PY
# a listener standing in for the console
python3 -I -c 'import socket,time;s=socket.socket();s.bind(("127.0.0.1",0));s.listen(8);print(s.getsockname()[1],flush=True);time.sleep(60)' >"$T/up.port" &
for _ in $(seq 50); do [ -s "$T/push.port" ] && [ -s "$T/up.port" ] && break; sleep 0.1; done
PUSH_PORT=$(cat "$T/push.port"); UP_PORT=$(cat "$T/up.port")
DOWN_PORT=$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')

printf 'KUMA_CONSOLE_PUSH_TOKEN=tok123\n' >"$T/kuma.env"
printf '{"sha":"1a2de2ba8b300e0d","at":"2026-11-05T08:15:02.719Z","port":8790}\n' >"$T/health.json"
run() { KUMA_ENV="$T/kuma.env" KUMA_PUSH_BASE="http://127.0.0.1:$PUSH_PORT/api/push" CONSOLE_PROBE_HOST=127.0.0.1 \
  CONSOLE_HEALTH_FILE="$T/health.json" CONSOLE_PROBE_PORT="$1" "$HERE/console-probe.sh"; }

run "$UP_PORT"
grep -qi '^/api/push/tok123?status=up&msg=release+1a2de2b+since+2026-11-05T08%3A15%3A02.719Z&ping=[0-9]' "$T/push.log" || fail "up push: $(cat "$T/push.log")"
run "$DOWN_PORT"
tail -1 "$T/push.log" | grep -q 'status=down' || fail "down push: $(tail -1 "$T/push.log")"

printf '' >"$T/kuma.env"
if KUMA_ENV="$T/kuma.env" "$HERE/console-probe.sh" 2>/dev/null; then fail "ran without a token"; fi
[ "$(wc -l <"$T/push.log")" -eq 2 ] || fail "a tokenless run pushed"
echo "PASS console-probe (3 cases)"
