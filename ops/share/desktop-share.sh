#!/usr/bin/env bash
# desktop-share.sh - manage the SMB mount that gives hqbox terminals a live view
# of the Windows desktop's user profile.
#
# Transport: CIFS/SMB3 over Tailscale. The desktop's port 445 is reachable at its
# tailnet address, so this exposes nothing to the LAN or the internet.
#
# The mount is deliberately `soft`: when the desktop sleeps or drops off the
# tailnet, reads fail fast with an I/O error instead of hanging the terminal
# forever on an unresponsive server. A hung agent is worse than a failed read.
#
# Config lives in ops/.desktop-share (gitignored, non-secret: host, share,
# mountpoint). The password lives ONLY in a root-owned credentials file that
# the owner creates himself; no agent reads or writes that path by design.
#
# Usage:
#   desktop-share.sh status      is it mounted, is the desktop reachable
#   desktop-share.sh up          mount it (idempotent)
#   desktop-share.sh down        unmount it
#   desktop-share.sh remount     down then up
#   desktop-share.sh doctor      diagnose why it is not working
#   desktop-share.sh setup       print the one-time commands for both machines
set -uo pipefail

HQ="${HQ_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
CONF="$HQ/ops/.desktop-share"

# Defaults, overridden by ops/.desktop-share if present.
HOST="100.64.0.2"
TSNAME="your-pc"
SHARE="HQ"
MOUNT="/mnt/desktop"
CRED="/etc/hq/desktop.cred"

# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

mount_opts() {
  printf '%s' "credentials=$CRED,uid=$(id -u),gid=$(id -g),file_mode=0664,dir_mode=0775,iocharset=utf8,vers=3.1.1,nofail,noserverino,mfsymlinks,cache=loose,actimeo=2,soft,echo_interval=10"
}

die() { echo "desktop-share: $*" >&2; exit 1; }
is_mounted() { mountpoint -q "$MOUNT"; }
reachable() { timeout 4 nc -z -w3 "$HOST" 445 >/dev/null 2>&1; }
have_cred() { sudo -n test -r "$CRED" 2>/dev/null; }

cmd_status() {
  if is_mounted; then
    echo "mounted: $MOUNT  (//$HOST/$SHARE)"
    local n
    n="$(timeout 8 ls -1 "$MOUNT" 2>&1 | wc -l)"
    echo "readable: $n entries at the share root"
  else
    echo "not mounted: $MOUNT"
  fi
  if reachable; then
    echo "desktop: reachable at $HOST:445 ($TSNAME)"
  else
    echo "desktop: UNREACHABLE at $HOST:445 (asleep, powered off, or off the tailnet)"
  fi
}

cmd_up() {
  is_mounted && { echo "already mounted at $MOUNT"; return 0; }
  reachable || die "desktop unreachable at $HOST:445. Is it awake and on the tailnet? Check: tailscale status"
  have_cred || die "credentials file $CRED is missing. Run: $0 setup"
  sudo mkdir -p "$MOUNT" || die "cannot create $MOUNT"
  if sudo mount -t cifs "//$HOST/$SHARE" "$MOUNT" -o "$(mount_opts)"; then
    echo "mounted //$HOST/$SHARE at $MOUNT"
  else
    die "mount failed. Run: $0 doctor"
  fi
}

cmd_down() {
  is_mounted || { echo "not mounted"; return 0; }
  if sudo umount "$MOUNT"; then
    echo "unmounted $MOUNT"
  else
    sudo umount -l "$MOUNT" && echo "lazy-unmounted $MOUNT (a process still had it open)"
  fi
}

cmd_doctor() {
  echo "== config =="
  echo "host=$HOST  share=$SHARE  mount=$MOUNT  cred=$CRED"
  echo "conf=$CONF $( [ -f "$CONF" ] && echo '(present)' || echo '(absent, using defaults)')"
  echo
  echo "== tools =="
  # mount.cifs installs into /usr/sbin, which is not on a normal user PATH, so
  # look there explicitly rather than reporting a false MISSING.
  for t in mount.cifs smbclient nc mountpoint; do
    p="$(command -v "$t" 2>/dev/null)"
    [ -z "$p" ] && [ -x "/usr/sbin/$t" ] && p="/usr/sbin/$t"
    [ -z "$p" ] && [ -x "/sbin/$t" ] && p="/sbin/$t"
    printf '%-12s %s\n' "$t" "${p:-MISSING}"
  done
  echo
  echo "== reachability =="
  if reachable; then echo "port 445 OPEN at $HOST"; else echo "port 445 CLOSED at $HOST"; fi
  if timeout 6 ping -c1 -W2 "$HOST" >"$HQ/ops/.desktop-ping.tmp" 2>&1; then
    echo "ping ok"
  else
    echo "ping failed"
  fi
  rm -f "$HQ/ops/.desktop-ping.tmp"
  echo
  echo "== shares visible on the desktop =="
  if have_cred; then
    sudo smbclient -L "//$HOST" -A "$CRED" 2>&1 | sed -n '1,15p'
  else
    echo "(no credentials at $CRED yet; anonymous listing, expected to be denied)"
    timeout 15 smbclient -L "//$HOST" -N 2>&1 | sed -n '1,8p'
  fi
  echo
  echo "== mount state =="
  cmd_status
}

cmd_setup() {
  cat <<EOF
Desktop file sharing, one-time setup. One command per machine.

STEP 1, on the Windows desktop, PowerShell AS ADMINISTRATOR.
Shares your user profile to your own account only:

    New-SmbShare -Name "$SHARE" -Path "\$env:USERPROFILE" -FullAccess "\$env:USERNAME"

Confirm it exists, and note your exact username for step 2:

    Get-SmbShare -Name "$SHARE"; whoami

STEP 2, on hqbox, in YOUR OWN shell (prefix with ! in a Claude terminal).
This writes the Windows password into a root-only file. Agents are blocked from
reading that path by the credential-read guard, which is exactly why you run
this and I do not:

    sudo install -d -m 0700 /etc/hq
    sudo tee $CRED >/dev/null <<'CREDEOF'
    username=YOUR_WINDOWS_USERNAME
    password=YOUR_WINDOWS_PASSWORD
    CREDEOF
    sudo chmod 600 $CRED

If you sign in to Windows with a Microsoft account, the username is normally the
full email address and the password is the Microsoft account password. If you
prefer not to put that password here, create a dedicated local Windows user,
give it access to your profile, and use those credentials instead.

THEN, from any hq terminal:

    ops/share/desktop-share.sh up
    ops/share/desktop-share.sh status
    f recent

To survive reboots and remount on demand:

    sudo ops/services/desktop-share/install.sh
EOF
}

case "${1:-status}" in
  status)  cmd_status ;;
  up)      cmd_up ;;
  down)    cmd_down ;;
  remount) cmd_down; cmd_up ;;
  doctor)  cmd_doctor ;;
  setup)   cmd_setup ;;
  -h|--help|help) sed -n '1,25p' "$0" ;;
  *) die "unknown command: $1 (status|up|down|remount|doctor|setup)" ;;
esac
