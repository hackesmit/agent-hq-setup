#!/usr/bin/env bash
# Install the work inbox watcher (hq-w32vy.2). Idempotent; run on hqbox as owner:
#
#   bash ~/hq/ops/services/mail-watch/install.sh
#
# 1. provisions the n8n side (trigger, proxy, token, table) with mail_watch.setup
# 2. installs and starts the 5-minute user timer
#
# Kill switch: touch ~/hq/state/mail/work/DISABLED (or ~/hq/ops/mail/DISABLED,
# which panic.sh touches). Revert fully:
#   systemctl --user disable --now mail-watch.timer
#   cd ~/hq/ops/services/mail-watch && python3 -m mail_watch.setup --remove
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

for tool in pp claude; do
  command -v "$tool" >/dev/null || { echo "$tool not on PATH" >&2; exit 1; }
done
[ -s "$HOME/hq/state/voice/profile.md" ] || { echo "no voice profile (hq-w32vy.1); drafts would fail" >&2; exit 1; }

(cd "$HERE" && python3 -m mail_watch.setup)

for unit in mail-watch.service mail-watch.timer; do
  install -D -m 644 "$HERE/$unit" "$UNIT_DIR/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now mail-watch.timer
systemctl --user list-timers mail-watch.timer --no-pager | head -3
