#!/usr/bin/env bash
# PreToolUse hook (all tools): suggest /compact after many tool calls so a long
# worker/overseer session does not silently drift past its useful context window.
# Adapted from the CC-toolkit compact-suggest; never blocks (always exit 0), only
# prints a stdout nudge at threshold crossings. Counter is per-session in /tmp.
# Tunable: HQ_COMPACT_THRESHOLD (default 80), HQ_COMPACT_REPEAT (40), HQ_COMPACT_SCOPE (150).
set -uo pipefail
THRESHOLD=${HQ_COMPACT_THRESHOLD:-80}
REPEAT=${HQ_COMPACT_REPEAT:-40}
SCOPE=${HQ_COMPACT_SCOPE:-150}

HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD
SID="$(printf '%s' "$HOOK_PAYLOAD" | python3 -c 'import sys,json;
try: print(json.load(sys.stdin).get("session_id",""))
except Exception: print("")' 2>/dev/null)"
[ -z "$SID" ] && exit 0

CF="/tmp/hq-compact-${SID}"
COUNT=$(cat "$CF" 2>/dev/null || echo 0)
COUNT=$((COUNT + 1))
echo "$COUNT" > "$CF" 2>/dev/null || true

if [ "$COUNT" -eq "$THRESHOLD" ] || \
   { [ "$COUNT" -gt "$THRESHOLD" ] && [ "$COUNT" -lt "$SCOPE" ] && [ $(( (COUNT - THRESHOLD) % REPEAT )) -eq 0 ]; }; then
  echo "[$COUNT tool calls] Context is filling up. Consider /compact (HQ snapshots + re-injects your critical rules automatically)."
fi
if [ "$COUNT" -eq "$SCOPE" ] || \
   { [ "$COUNT" -gt "$SCOPE" ] && [ $(( (COUNT - SCOPE) % REPEAT )) -eq 0 ]; }; then
  echo "[$COUNT tool calls] Long-running session. Is this bead's task actually done? If so finish/close it and spawn a fresh worker rather than continuing here."
fi
exit 0
