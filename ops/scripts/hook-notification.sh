#!/usr/bin/env bash
# Notification hook: a session is waiting on input/permission. Sent NON-urgent so notify.sh
# suppresses it while you're at the terminal (you'll see the prompt yourself) and only pushes
# when you're away. No more "blocked" buzz for questions you answer immediately.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MSG="$(python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("Agent needs input"); raise SystemExit
for k in ("message","notification","summary","title"):
    v = d.get(k)
    if isinstance(v, str) and v.strip():
        print(v.strip()[:160]); break
else:
    print("Agent needs input")
' 2>/dev/null || echo "Agent needs input")"
"$DIR/notify.sh" default "Waiting on you: input" "$MSG"
exit 0
