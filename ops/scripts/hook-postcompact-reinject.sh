#!/usr/bin/env bash
# SessionStart hook: after a compaction, re-read the session's objectives file so the trimmed
# context keeps its goals. No-op unless source == compact. Stdout is added to the session
# context by Claude Code. Fail-open.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
PAYLOAD="$(cat)"

src="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("source",""))
except Exception: print("")' 2>/dev/null)"
[ "$src" = "compact" ] || exit 0

ID="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id",""))
except Exception: print("")' 2>/dev/null)"
[ -n "$ID" ] || ID="${CLAUDE_SESSION_ID:-}"
[ -n "$ID" ] || exit 0

entry="$("$DIR/session-registry.sh" get "$ID" 2>/dev/null)" || exit 0
objrel="$(printf '%s' "$entry" | python3 -c "import json,sys; print(json.load(sys.stdin).get('objectives_file',''))" 2>/dev/null)"
[ -n "$objrel" ] || exit 0
obj="$HQ/$objrel"
[ -f "$obj" ] || exit 0

echo "## Objectives (reinjected after compaction — $ID)"
cat "$obj"
exit 0
