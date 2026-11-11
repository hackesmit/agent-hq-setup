#!/usr/bin/env bash
# install.sh [--uninstall]  Install the dead-man timers (user + system) from ~/hq main.
# The units run scripts out of ~/hq, so install from main, not from a worktree.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UDIR="$HOME/.config/systemd/user"
if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now hq-deadman.timer || true
  sudo systemctl disable --now hq-deadman-system.timer || true
  rm -f "$UDIR/hq-deadman.service" "$UDIR/hq-deadman.timer"
  sudo rm -f /etc/systemd/system/hq-deadman-system.{service,timer}
else
  mkdir -p "$UDIR"
  install -m 0644 "$HERE/hq-deadman.service" "$HERE/hq-deadman.timer" "$UDIR/"
  sudo install -m 0644 "$HERE/hq-deadman-system.service" "$HERE/hq-deadman-system.timer" /etc/systemd/system/
fi
systemctl --user daemon-reload; sudo systemctl daemon-reload
if [ "${1:-}" != "--uninstall" ]; then
  systemctl --user enable --now hq-deadman.timer
  sudo systemctl enable --now hq-deadman-system.timer
fi
