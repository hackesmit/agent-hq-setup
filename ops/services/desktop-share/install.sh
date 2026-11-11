#!/usr/bin/env bash
# install.sh - make the desktop SMB share survive reboots and mount on demand.
#
# RUN THIS YOURSELF, as the owner, with sudo. It writes into /etc/systemd/system,
# which is outside the agent write containment on purpose.
#
# It installs an automount rather than a plain mount: nothing is mounted until
# something actually touches /mnt/desktop, and boot never blocks waiting for a
# desktop that is asleep. First access mounts it, then it idles out after an
# hour of no use, so a sleeping desktop costs nothing.
#
#   sudo ops/services/desktop-share/install.sh            install and enable
#   sudo ops/services/desktop-share/install.sh --remove   undo cleanly
set -euo pipefail

HQ="$(cd "$(dirname "$0")/../../.." && pwd)"
CONF="$HQ/ops/.desktop-share"

HOST="100.64.0.2"
SHARE="HQ"
MOUNT="/mnt/desktop"
CRED="/etc/hq/desktop.cred"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

# systemd derives a mount unit's name from its path: /mnt/desktop is mnt-desktop
UNIT="$(systemd-escape -p --suffix=mount "$MOUNT")"
AUTO="$(systemd-escape -p --suffix=automount "$MOUNT")"
OWNER_UID="$(stat -c %u "$HQ")"
OWNER_GID="$(stat -c %g "$HQ")"

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now "$AUTO" 2>/dev/null || true
  systemctl stop "$UNIT" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT" "/etc/systemd/system/$AUTO"
  systemctl daemon-reload
  echo "removed $UNIT and $AUTO"
  exit 0
fi

[ -r "$CRED" ] || { echo "credentials file $CRED is missing. Run: $HQ/ops/share/desktop-share.sh setup" >&2; exit 1; }

mkdir -p "$MOUNT"

cat >"/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Windows desktop user profile over SMB (Tailscale)
Documentation=file://$HQ/docs/filesharing.md
After=network-online.target tailscaled.service
Wants=network-online.target

[Mount]
What=//$HOST/$SHARE
Where=$MOUNT
Type=cifs
Options=credentials=$CRED,uid=$OWNER_UID,gid=$OWNER_GID,file_mode=0664,dir_mode=0775,iocharset=utf8,vers=3.1.1,nofail,noserverino,mfsymlinks,cache=loose,actimeo=2,soft,echo_interval=10,_netdev
TimeoutSec=20

[Install]
WantedBy=multi-user.target
EOF

cat >"/etc/systemd/system/$AUTO" <<EOF
[Unit]
Description=Automount the Windows desktop profile on first access
After=tailscaled.service

[Automount]
Where=$MOUNT
TimeoutIdleSec=3600

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$AUTO"

echo "installed $UNIT and $AUTO"
echo "test it:  ls $MOUNT | head"
