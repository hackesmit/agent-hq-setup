#!/usr/bin/env bash
# install.sh [--dry-run] [--uninstall]
#
# Wires OnFailure= alerts onto every HQ unit without touching the unit files
# themselves: it installs the two failure templates and drops a small
# 10-onfailure*.conf into <unit>.d/ for each unit listed below. Drop-ins mean
# the installed unit bodies (which carry local drift such as
# hq-console.service.d/31-no-passkey.conf) are never overwritten.
#
# The hq-mail units are left out on purpose: they already carry
# OnFailure=hq-mail-failure@%n.service, and a second alert would double-page.
#
# These lists are the registry of what gets a failure alert. A new HQ unit
# must be added here (drift-check, hq-fgg3.1, compares against them).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

USER_UNITS=(
  tmux-hq.service
  ob-sync.service
  ob-sync-heartbeat.service
  hq-weekly-review.service
  hq-retro.service
  hq-reaper.service
  hq-drift-boot.service
  hq-wake-resume.service
  hq-orchestrator.service
  hq-orchestrator-audit.service
  hq-beads-backup.service
  hq-db-dump.service
  hq-session-archive.service
  mail-watch.service
  avance-guardia.service
  avance-promover.service
  plan-usage.service
  hq-deadman.service
  otel-ledger.service
)
SYSTEM_UNITS=(
  hq-restic-backup.service
  hq-disk-health.service
  hq-deadman-system.service
  hq-hub-sync.service
  hq-console.service
  hq-console-activate.service
  hq-runner.service
  hq-runner.socket
  console-build.service
  hq-cert-renew.service
  minecraft-compose.service
)

DRY=0; UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }

UDIR="$HOME/.config/systemd/user"
SDIR=/etc/systemd/system

if [ "$UNINSTALL" = 1 ]; then
  for u in "${USER_UNITS[@]}"; do run rm -f "$UDIR/$u.d/10-onfailure.conf"; done
  for u in "${SYSTEM_UNITS[@]}"; do run sudo rm -f "$SDIR/$u.d/10-onfailure-system.conf"; done
  run rm -f "$UDIR/hq-failure-notify@.service"
  run sudo rm -f "$SDIR/hq-failure-notify-system@.service"
else
  run mkdir -p "$UDIR"
  run ln -sfn "$HERE/hq-failure-notify@.service" "$UDIR/hq-failure-notify@.service"
  for u in "${USER_UNITS[@]}"; do
    run mkdir -p "$UDIR/$u.d"
    run ln -sfn "$HERE/10-onfailure.conf" "$UDIR/$u.d/10-onfailure.conf"
  done
  run sudo install -m 0644 "$HERE/hq-failure-notify-system@.service" "$SDIR/hq-failure-notify-system@.service"
  for u in "${SYSTEM_UNITS[@]}"; do
    run sudo install -d -m 0755 "$SDIR/$u.d"
    run sudo install -m 0644 "$HERE/10-onfailure-system.conf" "$SDIR/$u.d/10-onfailure-system.conf"
  done
fi
run systemctl --user daemon-reload
run sudo systemctl daemon-reload

if [ "$DRY" = 0 ] && [ "$UNINSTALL" = 0 ]; then
  missing=0
  for u in "${USER_UNITS[@]}"; do
    v="$(systemctl --user show "$u" -p OnFailure --value 2>/dev/null)"
    case "$v" in *hq-failure-notify@*) ;; *) echo "NOT WIRED (user): $u"; missing=1 ;; esac
  done
  for u in "${SYSTEM_UNITS[@]}"; do
    v="$(systemctl show "$u" -p OnFailure --value 2>/dev/null)"
    case "$v" in *hq-failure-notify-system@*) ;; *) echo "NOT WIRED (system): $u"; missing=1 ;; esac
  done
  [ "$missing" = 0 ] && echo "OnFailure wired on ${#USER_UNITS[@]} user and ${#SYSTEM_UNITS[@]} system units"
fi
