#!/usr/bin/env bash
# PreCompact hook: before the harness compacts (auto or manual), flush the session's
# objectives file to its bead + a state snapshot, so nothing load-bearing lives only in the
# window being trimmed. Fail-open, fast, no model calls.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
BD="${HQ_BD:-bd}"
PAYLOAD="$(cat)"

ID="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id",""))
except Exception: print("")' 2>/dev/null)"
[ -n "$ID" ] || ID="${CLAUDE_SESSION_ID:-}"
[ -n "$ID" ] || exit 0

entry="$("$DIR/session-registry.sh" get "$ID" 2>/dev/null)" || exit 0
getf(){ printf '%s' "$entry" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }
bead="$(getf bead)"; objrel="$(getf objectives_file)"

# ensure an objectives-file path is recorded (deferred item: update --objectives)
if [ -z "$objrel" ]; then
  objrel="state/objectives/$ID.md"
  "$DIR/session-registry.sh" update "$ID" --objectives "$objrel" >/dev/null 2>&1 || true
fi
obj="$HQ/$objrel"
[ -f "$obj" ] || exit 0

# flush: durable bead comment + a state snapshot copy
[ -n "$bead" ] && "$BD" comment "$bead" "objectives snapshot @ precompact:
$(cat "$obj")" >/dev/null 2>&1 || true
mkdir -p "$HQ/state/snapshots" 2>/dev/null || true
cp "$obj" "$HQ/state/snapshots/$ID.md" 2>/dev/null || true
exit 0
