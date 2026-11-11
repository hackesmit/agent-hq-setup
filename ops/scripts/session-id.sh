#!/usr/bin/env bash
# session-id.sh — collision-proof session identity via a marker nonce.
# Resolving "which session am I / which session is that pane" by walking the process
# tree is fragile (PID reuse, respawns). Instead: emit a unique nonce, then grep which
# transcript JSONL contains it. The filename IS the session id.
#
#   session-id.sh gen                 -> print a fresh nonce for an agent to echo
#   session-id.sh resolve <nonce>     -> print "<session_id>\t<transcript_path>" of the
#                                        newest transcript containing that nonce
#
# Nonce generation avoids $RANDOM/date-only collisions by combining time, pid, and
# /proc entropy. Fail-open: resolve prints nothing and exits 1 if not found.
set -uo pipefail
PROJECTS="${CLAUDE_TRANSCRIPT_DIR:-$HOME/.claude/projects}"

cmd="${1:-}"
case "$cmd" in
  gen)
    n="HQMARK-$(date +%s)-$$-$(head -c8 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' || echo rnd)"
    printf '%s\n' "$n"
    ;;
  resolve)
    nonce="${2:-}"
    [ -n "$nonce" ] || { echo "usage: session-id.sh resolve <nonce>" >&2; exit 2; }
    # newest transcript containing the nonce
    match="$(grep -rl -- "$nonce" "$PROJECTS" 2>/dev/null \
             | while read -r f; do printf '%s\t%s\n' "$(stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"; done \
             | sort -rn | head -1 | cut -f2-)"
    if [ -z "$match" ]; then exit 1; fi
    sid="$(basename "$match")"; sid="${sid%.jsonl}"
    printf '%s\t%s\n' "$sid" "$match"
    ;;
  *)
    echo "usage: session-id.sh {gen | resolve <nonce>}" >&2
    exit 2
    ;;
esac
exit 0
