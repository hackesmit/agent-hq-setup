#!/usr/bin/env bash
# install.sh [--uninstall]  Install the console probe timer (user unit) from ~/hq main.
# The unit runs the script out of ~/hq, so install from main, not from a worktree.
# Also retires the interim transient timer started before this was merged.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UDIR="$HOME/.config/systemd/user"
systemctl --user stop hq-console-probe-interim.timer hq-console-probe-interim.service 2>/dev/null || true
rm -f "$HOME/hq/state/console-probe-interim.sh"
DROPIN=/etc/systemd/system/hq-console.service.d/40-kuma-page.conf
if [ "${1:-}" = "--uninstall" ]; then
  sudo rm -f "$DROPIN" && sudo systemctl daemon-reload
  systemctl --user disable --now hq-console-probe.timer || true
  rm -f "$UDIR/hq-console-probe.service" "$UDIR/hq-console-probe.timer"
  systemctl --user daemon-reload
  exit 0
fi
# The console reads the page at its next restart (the next deploy); no restart here.
sudo install -D -m 0644 "$HERE/40-kuma-page.conf" "$DROPIN"
sudo systemctl daemon-reload
mkdir -p "$UDIR"
install -m 0644 "$HERE/hq-console-probe.service" "$HERE/hq-console-probe.timer" "$UDIR/"
systemctl --user daemon-reload
systemctl --user enable --now hq-console-probe.timer
