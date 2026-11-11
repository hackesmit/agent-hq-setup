#!/usr/bin/env bash
# hq-beads-backup.sh: daily Dolt-native backup of the beads ledger on hqbox.
# Installed 2026-08-20 (stack review bead hq-cgwi). Destination configured via
# `bd backup init ~/hq-beads-backup` (file://, same NVMe: point-in-time DB backup
# that survives DB corruption, NOT disk loss; restic bead hq-k3zj owns offsite).
# Canonical copy: ops/services/beads-backup/ in the hq repo; installed copy:
# ~/.local/bin/hq-beads-backup on hqbox.
# Revert: systemctl --user disable --now hq-beads-backup.timer && rm installed files.
set -uo pipefail
HQ="$HOME/hq"
BD="$HOME/.local/bin/bd"
LOG_DIR="$HOME/.local/state/hq-beads-backup"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m).log"

{
  echo "=== beads backup $(date -Is) ==="
  cd "$HQ" || exit 1
  "$BD" backup sync
  rc=$?
  echo "exit=$rc"
  exit "$rc"
} >>"$LOG" 2>&1
