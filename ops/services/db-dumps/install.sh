#!/usr/bin/env bash
# install.sh: install hq-db-dump from the main checkout (never from a worktree,
# the units and OnFailure drop-in must point at ~/hq). Then wire OnFailure with
# ops/services/failure-notify/install.sh, which lists hq-db-dump.service.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UDIR="$HOME/.config/systemd/user"
install -D -m 0755 "$HERE/hq-db-dump.sh" "$HOME/.local/bin/hq-db-dump"
install -D -m 0644 "$HERE/hq-db-dump.service" "$UDIR/hq-db-dump.service"
install -D -m 0644 "$HERE/hq-db-dump.timer" "$UDIR/hq-db-dump.timer"
systemctl --user daemon-reload
systemctl --user enable --now hq-db-dump.timer
systemctl --user list-timers hq-db-dump.timer --no-pager | head -2
