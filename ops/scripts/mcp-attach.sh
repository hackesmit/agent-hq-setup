#!/usr/bin/env bash
# mcp-attach.sh <profile> [--no-auto-remove]
# On-demand mid-session MCP attach. A worker that discovers mid-bead it needs a server
# it wasn't spawned with runs this: it respawns its OWN tmux pane in place, adding the
# server's --mcp-config and continuing where it left off (claude -c). Respawn-in-place
# happens under the tmux server, so it survives the bash-sandbox process-tree kill.
# After 5 minutes the pane is respawned back to plain (auto-remove) so a server one
# bead needed once does not linger. The detached timer is setsid'd BEFORE the respawn
# so it outlives the pane kill.
# Compose with the spawn-time default (bead `MCP:` field): declared servers attach at
# spawn; this handles the surprise. Keep the near-zero standing-server posture.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"

PROFILE="${1:-}"
AUTO_REMOVE=1
[ "${2:-}" = "--no-auto-remove" ] && AUTO_REMOVE=0

if [ -z "$PROFILE" ]; then echo "usage: mcp-attach.sh <profile> [--no-auto-remove]" >&2; exit 2; fi
CFG="$HQ/ops/mcp/$PROFILE.json"
if [ ! -f "$CFG" ]; then
  echo "No MCP profile '$PROFILE' in ops/mcp/. A server not yet in ops/mcp/ is an" >&2
  echo "acquisition: verify provenance, add the profile, file the acquisition bead, then attach." >&2
  exit 2
fi
PANE="${TMUX_PANE:-}"
if [ -z "$PANE" ]; then echo "mcp-attach must run inside a tmux pane." >&2; exit 2; fi

CWD="$(tmux display -p -t "$PANE" '#{pane_current_path}' 2>/dev/null || echo "$HQ")"

# Schedule auto-remove FIRST, fully detached, so the pane kill below can't take it out.
if [ "$AUTO_REMOVE" -eq 1 ]; then
  setsid bash -c "sleep 300; tmux respawn-pane -k -t '$PANE' \
    'cd \"$CWD\"; exec claude --dangerously-skip-permissions --strict-mcp-config -c'" \
    >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
fi

# Respawn this pane in place WITH the server, continuing the session.
exec tmux respawn-pane -k -t "$PANE" \
  "cd \"$CWD\"; exec claude --dangerously-skip-permissions --mcp-config \"$CFG\" --strict-mcp-config -c"
