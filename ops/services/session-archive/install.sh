#!/usr/bin/env bash
# install.sh: install hq-session-archive from the main checkout (never from a worktree).
# Creates /srv/session-archive (owner, 0700) once, then the timer. Then wire
# OnFailure with ops/services/failure-notify/install.sh, which lists the service.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UDIR="$HOME/.config/systemd/user"
if [ ! -d /srv/session-archive/claude ]; then
  sudo install -d -o "$USER" -g "$USER" -m 0700 /srv/session-archive /srv/session-archive/claude
fi
install -D -m 0755 "$HERE/../../scripts/session-archive.sh" "$HOME/.local/bin/hq-session-archive"
install -D -m 0644 "$HERE/hq-session-archive.service" "$UDIR/hq-session-archive.service"
install -D -m 0644 "$HERE/hq-session-archive.timer" "$UDIR/hq-session-archive.timer"
systemctl --user daemon-reload
systemctl --user enable --now hq-session-archive.timer
systemctl --user list-timers hq-session-archive.timer --no-pager | head -2
