#!/usr/bin/env bash
# panic — kill every agent session immediately. Works from any terminal.
DIR="$(cd "$(dirname "$0")" && pwd)"
# The hq session lives on the default or the hqterm tmux server; kill the session named
# exactly hq on each (`=hq`: a bare `-t hq` prefix-matched and killed hq-errors instead).
# Fall back to the default server if the lib is missing, so the emergency stop still stops hq.
if . "$DIR/lib/tmux-server.sh" 2>/dev/null; then
  hq_kill_hq_sessions
else
  tmux kill-session -t '=hq' 2>/dev/null
fi
pkill -f "claude" 2>/dev/null
"$DIR/notify.sh" urgent "PANIC" "All agent sessions killed"
echo "All agent sessions killed."
