#!/usr/bin/env bash
# HQ Console v2: hqbox provisioning (bead hq-qwj2, phase 0 item P0.6).
#
# Runbook: docs/superpowers/specs/2026-08-17-console-v2-design.md sections 3, 6, 8.
# Run this ON hqbox, as user owner, over ssh:
#
#     bash ~/hq/ops/console/v2/provision/hqbox-console-provision.sh --check
#     bash ~/hq/ops/console/v2/provision/hqbox-console-provision.sh
#
# --check prints every change it would make and touches nothing.
#
# It creates the ground the console runs on and nothing else:
#   1. build toolchain (build-essential, python3, rsync) for node-pty
#   2. system Node 24 from NodeSource, pinned, verified at /usr/bin/node
#   3. users hqconsole, hqbuild, hqsync and groups hqgit, hqmirror
#   4. /var/lib/{hqconsole,hqbuild,hqsync} with the modes the design requires
#   5. /etc/tmpfiles.d/hq-console.conf: the git lock and the runner socket dir
#   6. the sudoers drop-in that lets hqconsole run exactly one wrapper as owner
#   7. ~/hq/inbox/files as a symlink into the console inbox
#   8. build.sh and activate.sh into /usr/local/lib/hq-console (root-owned, so
#      no worker and no daemon user can rewrite what root executes)
#   9. the systemd units, enabled but with hq-console.service NOT started
#  10. the tailnet TLS certificate
#
# What it deliberately does NOT do:
#   - initialise the git mirrors or install any credential. hub-sync owns those
#     (ops/console/v2/sync/rollout-hqbox.sh, bead hq-4m5u). This script only
#     creates the hqsync user, /var/lib/hqsync and the hqmirror group that the
#     rollout expects to find.
#   - start hq-console.service or console-build.timer. The first release is
#     activated by hand so a failure is watched, not discovered.
#
# Idempotent: safe to re-run. Every state-changing command is checked, so it
# stops at the first real failure instead of reporting success over a broken
# step.
set -uo pipefail
# Every getent, stat, systemctl and apt invocation below is machine-parsed.
export LC_ALL=C

CHECK=0
CHANGES=0
WARNINGS=0

NODE_MAJOR=24
TAILNET_NAME=hqbox.example.ts.net
HQ=/home/owner/hq
LIBDIR=/usr/local/lib/hq-console
UNITDIR=/etc/systemd/system
HERE=$(cd "$(dirname "$0")" && pwd)
RELEASE_DIR=$(cd "$HERE/../release" && pwd 2>/dev/null)

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok %s\n' "$*"; }
warn() { printf '    WARN %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
plan() { printf '    would %s\n' "$*"; CHANGES=$((CHANGES + 1)); }
die()  { printf '\nFAILED %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,40p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift;;
    -h|--help) usage 0;;
    *) die "unknown argument: $1 (try --help)";;
  esac
done

# run <description> <command...>
# In --check mode it prints the description and changes nothing. Otherwise it
# runs the command and dies with the description on failure, so every message
# says what was being attempted rather than just which binary returned 1.
run() {
  local what=$1; shift
  if [ "$CHECK" = 1 ]; then plan "$what"; return 0; fi
  "$@" || die "$what (command: $*)"
  CHANGES=$((CHANGES + 1))
  ok "$what"
}

# ensure_dir <path> <mode> <user:group>
ensure_dir() {
  local path=$1 mode=$2 owner=$3 cur_mode cur_own
  if [ -d "$path" ]; then
    cur_mode=$(stat -c '%04a' "$path" 2>/dev/null)
    cur_own=$(stat -c '%U:%G' "$path" 2>/dev/null)
    if [ "$cur_mode" = "$mode" ] && [ "$cur_own" = "$owner" ]; then
      ok "$path ($mode $owner)"
      return 0
    fi
    run "chown $owner $path (was $cur_own)" sudo chown "$owner" "$path"
    run "chmod $mode $path (was $cur_mode)"  sudo chmod "$mode" "$path"
    return 0
  fi
  [ -e "$path" ] && die "$path exists and is not a directory. Move it aside by hand; refusing to guess."
  run "create $path ($mode $owner)" sudo install -d -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$path"
}

# install_text <path> <mode> <user:group> <content>
# Writes only when the content differs, so a re-run is quiet and a change is
# visible in the output.
install_text() {
  local path=$1 mode=$2 owner=$3 content=$4 tmp cur
  if [ -f "$path" ]; then
    cur=$(sudo cat "$path" 2>/dev/null)
    if [ "$cur" = "$content" ]; then
      ok "$path current"
      return 0
    fi
  fi
  if [ "$CHECK" = 1 ]; then plan "write $path (mode $mode owner $owner)"; return 0; fi
  tmp=$(mktemp) || die "mktemp failed"
  printf '%s\n' "$content" > "$tmp" || die "could not stage $path"
  sudo install -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$tmp" "$path" \
    || { rm -f "$tmp"; die "could not install $path"; }
  rm -f "$tmp"
  CHANGES=$((CHANGES + 1))
  ok "wrote $path"
}

# install_from <src> <dest> <mode> <user:group>
install_from() {
  local src=$1 dest=$2 mode=$3 owner=$4
  [ -f "$src" ] || die "$src does not exist"
  if [ -f "$dest" ] && sudo cmp -s "$src" "$dest"; then
    ok "$dest current"
    return 0
  fi
  run "install $dest from $(basename "$src")" \
    sudo install -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$src" "$dest"
}

# ---------------------------------------------------------------- preflight --
log "0/10 preflight"
[ "$(id -un)" = owner ] || die "run as owner, not $(id -un). Every path here is absolute and the inbox symlink belongs to owner."
grep -qi ubuntu /etc/os-release || die "this expects Ubuntu Server"
[ -d "$HQ" ] || die "$HQ does not exist; the repo has to be on the box first"
[ -n "$RELEASE_DIR" ] && [ -d "$RELEASE_DIR/units" ] \
  || die "cannot find the release directory next to this script (expected $HERE/../release/units)"
for f in build.sh activate.sh; do
  [ -f "$RELEASE_DIR/$f" ] || die "$RELEASE_DIR/$f is missing; run this from a full checkout"
done
if [ "$CHECK" = 0 ]; then
  sudo -n true 2>/dev/null || die "this needs passwordless sudo"
else
  ok "check mode: nothing will be changed"
fi
# shellcheck disable=SC1091  # /etc/os-release is a host file, not repo input
ok "on $(. /etc/os-release; printf '%s' "$PRETTY_NAME") as owner"

# ------------------------------------------------------------ 1. toolchain --
# node-pty is the one native module in the release and it is compiled once, in
# the builder. Without a compiler the build fails at npm rebuild, and without
# rsync activate.sh cannot copy a release into place.
log "1/10 build toolchain"
MISSING=""
for p in build-essential python3 rsync ca-certificates curl gnupg git acl; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  # Word splitting is intended here: MISSING is a space-separated package list.
  # shellcheck disable=SC2086
  run "apt install$MISSING" sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $MISSING
else
  ok "build-essential, python3, rsync, curl, gnupg, git, acl already installed"
fi

# ----------------------------------------------------------------- 2. node --
# System-wide Node, not nvm: systemd units run as hqconsole, hqbuild and root,
# none of which source owner's shell profile. The major version is pinned in
# this script AND in an apt preference, because a silent jump to the next major
# would rebuild node-pty against a different ABI on some unrelated apt upgrade.
log "2/10 Node $NODE_MAJOR (NodeSource nodistro)"
NODE_KEYRING=/etc/apt/keyrings/nodesource.gpg
NODE_LIST=/etc/apt/sources.list.d/nodesource.list
NODE_PREF=/etc/apt/preferences.d/97-nodesource
NODE_LIST_TEXT="deb [signed-by=$NODE_KEYRING] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main"
NODE_PREF_TEXT="Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 1001"

CUR_NODE=$(/usr/bin/node -v 2>/dev/null)
CUR_MAJOR=$(printf '%s' "$CUR_NODE" | sed -n 's/^v\([0-9]\{1,\}\)\..*/\1/p')

if [ "$CUR_MAJOR" = "$NODE_MAJOR" ]; then
  ok "/usr/bin/node is $CUR_NODE"
else
  ensure_dir /etc/apt/keyrings 0755 root:root
  if [ -f "$NODE_KEYRING" ]; then
    ok "$NODE_KEYRING present"
  elif [ "$CHECK" = 1 ]; then
    plan "fetch the NodeSource signing key into $NODE_KEYRING"
  else
    KEYTMP=$(mktemp) || die "mktemp failed"
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$KEYTMP" \
      || { rm -f "$KEYTMP"; die "could not fetch the NodeSource signing key"; }
    sudo gpg --batch --yes --dearmor -o "$NODE_KEYRING" "$KEYTMP" \
      || { rm -f "$KEYTMP"; die "could not dearmor the NodeSource key"; }
    rm -f "$KEYTMP"
    sudo chmod 0644 "$NODE_KEYRING" || die "could not chmod $NODE_KEYRING"
    CHANGES=$((CHANGES + 1))
    ok "installed $NODE_KEYRING"
  fi
  install_text "$NODE_LIST" 0644 root:root "$NODE_LIST_TEXT"
  install_text "$NODE_PREF" 0644 root:root "$NODE_PREF_TEXT"
  run "apt update (nodesource)" sudo apt-get update -qq
  run "apt install nodejs"      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  if [ "$CHECK" = 0 ]; then
    CUR_NODE=$(/usr/bin/node -v 2>/dev/null)
    CUR_MAJOR=$(printf '%s' "$CUR_NODE" | sed -n 's/^v\([0-9]\{1,\}\)\..*/\1/p')
    [ "$CUR_MAJOR" = "$NODE_MAJOR" ] \
      || die "/usr/bin/node reports '$CUR_NODE', not major $NODE_MAJOR. The units hard-code /usr/bin/node; refusing to continue with the wrong runtime."
    ok "/usr/bin/node is $CUR_NODE"
  fi
fi
if [ "$CHECK" = 0 ]; then
  [ -x /usr/bin/npm ] || die "/usr/bin/npm is missing; console-build.service needs it"
  ok "/usr/bin/npm $(/usr/bin/npm -v 2>/dev/null)"
fi

# ------------------------------------------------------ 3. users and groups --
# System users, no login shell, homes under /var/lib. None of these is a
# person: hqconsole runs the daemons, hqbuild builds, hqsync pushes (its
# credential is installed by the hub-sync rollout, never by this script).
log "3/10 users and groups"
ensure_group() {
  local g=$1
  if getent group "$g" >/dev/null; then ok "group $g"; return 0; fi
  run "create system group $g" sudo groupadd --system "$g"
}
ensure_user() {
  local u=$1 home=$2
  if getent passwd "$u" >/dev/null; then ok "user $u"; return 0; fi
  run "create system user $u (home $home, nologin)" \
    sudo useradd --system --user-group --shell /usr/sbin/nologin --home-dir "$home" --create-home "$u"
}
ensure_member() {
  local u=$1 g=$2
  if [ "$CHECK" = 1 ] && ! getent passwd "$u" >/dev/null; then plan "add $u to $g"; return 0; fi
  if id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qx "$g"; then ok "$u is in $g"; return 0; fi
  run "add $u to $g" sudo usermod -aG "$g" "$u"
}

# hqgit guards the single git lock shared by hub-sync and the console wrapper.
ensure_group hqgit
# hqmirror owns the bare mirrors. The hub-sync rollout expects it to exist; it
# is created here because that rollout runs after this script.
ensure_group hqmirror
ensure_user hqconsole /var/lib/hqconsole
ensure_user hqbuild   /var/lib/hqbuild
ensure_user hqsync    /var/lib/hqsync
ensure_member hqsync    hqgit
ensure_member hqconsole hqgit
ensure_member hqsync    hqmirror

# The console reads the registry, the truths files and DECISIONS.md straight
# out of ~/hq. /home/owner is 0750, so without a traverse grant hqconsole
# cannot even stat a world-readable file inside it and the projects collector
# fails with EACCES on every tick (bead hq-yttz). This grants execute to that
# one service user: traverse, never list, and nothing below /home/owner that
# is not already world readable. Reverse with:
#   sudo setfacl -x u:hqconsole /home/owner
ensure_traverse() {
  local u=$1 dir=$2
  if getfacl -p "$dir" 2>/dev/null | grep -qx "user:$u:--x"; then
    ok "$u may traverse $dir"
    return 0
  fi
  run "grant $u traverse on $dir" sudo setfacl -m "u:$u:x" "$dir"
}
ensure_traverse hqconsole /home/owner

# ---------------------------------------------------------- 4. directories --
log "4/10 directories"
# hqconsole's tree. 0755 on the top and on releases because owner and the
# workers must be able to READ what is served and executed; nothing outside
# hqconsole may write any of it, which is the whole reason the console does not
# serve from ~/hq.
ensure_dir /var/lib/hqconsole             0755 hqconsole:hqconsole
ensure_dir /var/lib/hqconsole/releases    0755 hqconsole:hqconsole
# The inbox is the one place owner's workers read from, so files land 0644 in
# 0755 dirs (design section 6).
ensure_dir /var/lib/hqconsole/inbox       0755 hqconsole:hqconsole
ensure_dir /var/lib/hqconsole/inbox/files 0755 hqconsole:hqconsole
# Streaming temp files and their durability sidecars. 0700: a half-written
# upload is nobody else's business.
ensure_dir /var/lib/hqconsole/inbox/.tmp  0700 hqconsole:hqconsole
# 0750 from here down: nothing outside the console reads terminal logs, the
# money ledger, the meta terminal's settings, or the TLS private key.
ensure_dir /var/lib/hqconsole/money       0750 hqconsole:hqconsole
ensure_dir /var/lib/hqconsole/term        0750 hqconsole:hqconsole
# Capri, the meta terminal (proposal 19). The meta dir and the files activate.sh
# installs into it (meta-settings.json, the two hooks, meta-verbs.py via the wrapper
# dir) are ROOT-owned: meta-verbs.py's trusted-ownership check requires it, so neither
# owner nor hqconsole can swap the hook that runs as owner. 0755 so owner can read
# the settings and hooks. The mutable state lives in owned subdirs:
#   sessions/  owner writes per-session snapshots and the integrity marker
#   keys/      hqconsole writes the passkey store (atomic rename needs dir write)
#   audit.jsonl  owner appends the tool-call trail (pre-created so no dir write needed)
ensure_dir /var/lib/hqconsole/meta          0755 root:root
ensure_dir /var/lib/hqconsole/meta/sessions 0755 owner:owner
ensure_dir /var/lib/hqconsole/meta/keys     0750 hqconsole:hqconsole
if [ ! -e /var/lib/hqconsole/meta/audit.jsonl ]; then
  run "create the Capri audit trail" sudo install -o owner -g owner -m 0640 /dev/null /var/lib/hqconsole/meta/audit.jsonl
else
  ok "/var/lib/hqconsole/meta/audit.jsonl exists"
fi
ensure_dir /var/lib/hqconsole/tls         0750 hqconsole:hqconsole
# The health stamp activate.sh waits for: the server writes
# state/health.json {sha, at, port} once it is listening.
ensure_dir /var/lib/hqconsole/state       0750 hqconsole:hqconsole

ensure_dir /var/lib/hqbuild               0755 hqbuild:hqbuild
ensure_dir /var/lib/hqbuild/src           0755 hqbuild:hqbuild
# root (hq-console-activate.service) reads out/<sha>, so it stays traversable.
ensure_dir /var/lib/hqbuild/out           0755 hqbuild:hqbuild

# hqsync's home only. The mirrors under /var/lib/hqsync/mirrors and the
# credential directory belong to hub-sync's rollout; this script never
# initialises a mirror and never touches a credential.
ensure_dir /var/lib/hqsync                0755 hqsync:hqsync

# -------------------------------------------------------------- 5. tmpfiles --
# The git lock lives in /run, which is a tmpfs, so it has to be recreated on
# every boot: that is exactly what tmpfiles.d is for. The directory is sticky
# and group-only (1770) so a process in hqgit can take the lock but cannot
# delete another user's file in there; the lock file itself is root-owned and
# group-writable, so neither hqsync nor hqconsole can replace it with one they
# control and then hold a lock nobody else sees.
log "5/10 tmpfiles (git lock, runner socket dir)"
TMPFILES=/etc/tmpfiles.d/hq-console.conf
TMPFILES_TEXT="# HQ Console v2. Managed by ops/console/v2/provision/hqbox-console-provision.sh
# type path                        mode uid       gid       age
d /run/lock/hqgit                  1770 root      hqgit     -
f /run/lock/hqgit/hq-git.lock      0660 root      hqgit     -
# The runner socket unit runs as root, so its own RuntimeDirectory would be
# root-owned. Create the directory here instead; hq-runner.service preserves it.
d /run/hqconsole                   0750 hqconsole hqconsole -
# Pane FIFOs: setgid owner so each 0620 FIFO is owner-writable; other gets nothing.
d /run/hqconsole-panes             2710 hqconsole owner    -"
install_text "$TMPFILES" 0644 root:root "$TMPFILES_TEXT"
run "apply $TMPFILES" sudo systemd-tmpfiles --create "$TMPFILES"

# --------------------------------------------------------------- 6. sudoers --
# The entire privilege the console holds over owner's account: one script, no
# password prompt, and no other target user. Argument filtering is the
# wrapper's job (it has its own verb allowlist), not sudo's.
#
# The path runs through releases/current, a symlink hqconsole owns. That is
# deliberate and not a hole: hqconsole already decides what the console
# executes. The rule exists to keep every OTHER account and every other command
# out of owner's context.
log "6/10 sudoers drop-in"
SUDOERS=/etc/sudoers.d/hqconsole
SUDOERS_TEXT="# HQ Console v2. Managed by ops/console/v2/provision/hqbox-console-provision.sh
# hqconsole may run exactly one wrapper as owner, unprompted. Nothing else.
Cmnd_Alias HQSPAWN = /usr/local/lib/hq-console/spawn-as-owner.sh
hqconsole ALL = (owner) NOPASSWD: HQSPAWN"
if [ "$CHECK" = 1 ]; then
  if [ -f "$SUDOERS" ] && [ "$(sudo -n cat "$SUDOERS" 2>/dev/null)" = "$SUDOERS_TEXT" ]; then
    ok "$SUDOERS current"
  else
    plan "write and visudo-validate $SUDOERS"
  fi
else
  SUDO_TMP=$(mktemp) || die "mktemp failed"
  printf '%s\n' "$SUDOERS_TEXT" > "$SUDO_TMP" || die "could not stage the sudoers drop-in"
  # Validated BEFORE it is installed. A syntax error under /etc/sudoers.d
  # breaks sudo for everyone, including the session running this script.
  sudo visudo -c -q -f "$SUDO_TMP" \
    || { rm -f "$SUDO_TMP"; die "the sudoers drop-in does not validate; nothing was installed"; }
  if [ -f "$SUDOERS" ] && sudo cmp -s "$SUDO_TMP" "$SUDOERS"; then
    ok "$SUDOERS current"
  else
    sudo install -o root -g root -m 0440 "$SUDO_TMP" "$SUDOERS" \
      || { rm -f "$SUDO_TMP"; die "could not install $SUDOERS"; }
    CHANGES=$((CHANGES + 1))
    ok "installed $SUDOERS"
  fi
  rm -f "$SUDO_TMP"
  # Validated again as a whole, because a drop-in can only be judged in the
  # context of the rest of the configuration.
  sudo visudo -c -q || die "/etc/sudoers is now invalid. Fix it from a root shell you still have open before logging out."
  ok "visudo -c passes"
fi

# ----------------------------------------------------------- 7. inbox link --
# The path agents already know. A symlink rather than a bind mount, because the
# write-containment guard reasons about paths, and because a worker reading
# through it gets exactly the 0644 files the console wrote.
log "7/10 ~/hq/inbox/files symlink"
if [ ! -d "$HQ/inbox" ]; then
  run "create $HQ/inbox" mkdir -p "$HQ/inbox"
else
  ok "$HQ/inbox exists"
fi
LINK="$HQ/inbox/files"
TARGET=/var/lib/hqconsole/inbox/files
if [ -L "$LINK" ]; then
  CUR_TARGET=$(readlink -f "$LINK")
  if [ "$CUR_TARGET" = "$TARGET" ]; then
    ok "$LINK points at $TARGET"
  else
    run "repoint $LINK to $TARGET (was $CUR_TARGET)" ln -sfn "$TARGET" "$LINK"
  fi
elif [ -e "$LINK" ]; then
  die "$LINK exists and is not a symlink. It may hold real files; move it aside by hand rather than letting this script delete it."
else
  run "create $LINK pointing at $TARGET" ln -sfn "$TARGET" "$LINK"
fi

# ------------------------------------------------- 8. release scripts, root --
# build.sh and activate.sh run as hqbuild and as root. They are copied into a
# root-owned directory rather than executed out of ~/hq, because ~/hq is
# worker-writable: a caged worker that could edit build.sh would own the build
# user, and one that could edit activate.sh would own root.
# Phase 1 turns this into a self-update step (see release/README.md); until
# then, re-run this script after changing either file.
log "8/10 release scripts into $LIBDIR"
ensure_dir "$LIBDIR" 0755 root:root
install_from "$RELEASE_DIR/build.sh"    "$LIBDIR/build.sh"    0755 root:root
install_from "$RELEASE_DIR/activate.sh" "$LIBDIR/activate.sh" 0755 root:root
# hqbuild clones from the hqsync-owned mirror; git refuses cross-owner repos unless the
# path is in the user's own safe.directory list (GIT_CONFIG env is not enough for the
# upload-pack child, observed on the first hqbox build)
MIRROR_HQ=/var/lib/hqsync/mirrors/agent-hq.git
if sudo -u hqbuild -H git -C / config --global --get-all safe.directory 2>/dev/null | grep -qx "$MIRROR_HQ"; then
  ok "hqbuild already trusts $MIRROR_HQ"
else
  run "hqbuild trusts $MIRROR_HQ (safe.directory)" sudo -u hqbuild -H git -C / config --global --add safe.directory "$MIRROR_HQ"
fi

# ----------------------------------------------------------------- 9. units --
log "9/10 systemd units"
UNITS="hq-console.service hq-runner.service hq-runner.socket console-build.service console-build.timer hq-console-activate.service hq-cert-renew.service hq-cert-renew.timer"
UNITS_CHANGED=0
for u in $UNITS; do
  [ -f "$RELEASE_DIR/units/$u" ] || die "$RELEASE_DIR/units/$u is missing"
  if [ -f "$UNITDIR/$u" ] && sudo cmp -s "$RELEASE_DIR/units/$u" "$UNITDIR/$u"; then
    ok "$u current"
  else
    UNITS_CHANGED=1
    run "install $UNITDIR/$u" sudo install -o root -g root -m 0644 "$RELEASE_DIR/units/$u" "$UNITDIR/$u"
  fi
done
if [ "$UNITS_CHANGED" = 1 ]; then
  run "systemctl daemon-reload" sudo systemctl daemon-reload
else
  ok "units unchanged, no daemon-reload needed"
fi

# Enabled: the socket (so the runner starts on first use) and both timers. The
# console service is enabled by activate.sh on the first successful release, so a
# reboot between provisioning and that release does not crash-loop it.
for u in hq-runner.socket hq-cert-renew.timer console-build.timer; do
  ST=$(systemctl is-enabled "$u" 2>/dev/null)
  if [ "$ST" = enabled ]; then
    ok "$u enabled"
  else
    run "enable $u" sudo systemctl enable "$u"
  fi
done

# Started now: only the socket and the certificate timer.
# hq-console.service stays stopped until a release exists (starting it against
# a missing releases/current would just crash-loop), and console-build.timer
# stays stopped so the first build is run by hand and watched.
for u in hq-runner.socket hq-cert-renew.timer; do
  ST=$(systemctl is-active "$u" 2>/dev/null)
  if [ "$ST" = active ]; then
    ok "$u active"
  else
    run "start $u" sudo systemctl start "$u"
  fi
done

# ------------------------------------------------------------------ 10. TLS --
# The browser reaches the console at https://hqbox.example.ts.net:8790, so
# the certificate has to be for that name. tailscale caches and reuses a
# still-valid certificate, which is what makes this idempotent.
log "10/10 tailnet TLS certificate for $TAILNET_NAME"
CERT=/var/lib/hqconsole/tls/cert.pem
KEY=/var/lib/hqconsole/tls/key.pem
TS_STATE=""
if have tailscale; then
  TS_JSON=$(tailscale status --json 2>/dev/null)
  TS_STATE=$(printf '%s' "$TS_JSON" | sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
if [ "$TS_STATE" != Running ]; then
  warn "tailscale backend is '${TS_STATE:-absent}', skipping the certificate. hq-cert-renew.timer retries at boot and weekly; run 'sudo systemctl start hq-cert-renew.service' once the tailnet is up."
elif [ "$CHECK" = 1 ]; then
  if [ -f "$CERT" ]; then ok "$CERT present"; else plan "mint $CERT and $KEY for $TAILNET_NAME"; fi
else
  run "mint or renew the certificate for $TAILNET_NAME" \
    sudo tailscale cert --cert-file "$CERT" --key-file "$KEY" "$TAILNET_NAME"
  # tailscale writes them as root; the server only ever reads them.
  run "chown the certificate to hqconsole" sudo chown hqconsole:hqconsole "$CERT" "$KEY"
  run "restrict the certificate to 0640"   sudo chmod 0640 "$CERT" "$KEY"
fi

# --------------------------------------------------------------- readback ----
if [ "$CHECK" = 1 ]; then
  printf '\n========================================\n'
  printf 'check mode: %d change(s) would be made, %d warning(s)\n' "$CHANGES" "$WARNINGS"
  printf 'nothing was modified\n'
  printf '========================================\n'
  exit 0
fi

log "readback"

printf '\n-- users and groups\n'
for u in hqconsole hqbuild hqsync; do
  printf '   %-10s %s | groups: %s\n' "$u" "$(getent passwd "$u" | cut -d: -f6,7)" "$(id -nG "$u" 2>/dev/null)"
done
printf '   %-10s members: %s\n' hqgit    "$(getent group hqgit | cut -d: -f4)"
printf '   %-10s members: %s\n' hqmirror "$(getent group hqmirror | cut -d: -f4)"

printf '\n-- directories\n'
for d in /var/lib/hqconsole /var/lib/hqconsole/releases /var/lib/hqconsole/inbox/files \
         /var/lib/hqconsole/inbox/.tmp /var/lib/hqconsole/money /var/lib/hqconsole/term \
         /var/lib/hqconsole/meta /var/lib/hqconsole/tls /var/lib/hqconsole/state \
         /var/lib/hqbuild/src /var/lib/hqbuild/out /var/lib/hqsync; do
  printf '   %s %-22s %s\n' "$(stat -c '%04a' "$d" 2>/dev/null)" "$(stat -c '%U:%G' "$d" 2>/dev/null)" "$d"
done

printf '\n-- runtime paths\n'
for p in /run/lock/hqgit /run/lock/hqgit/hq-git.lock /run/hqconsole; do
  printf '   %s %-22s %s\n' "$(stat -c '%04a' "$p" 2>/dev/null)" "$(stat -c '%U:%G' "$p" 2>/dev/null)" "$p"
done
printf '   inbox symlink %s points at %s\n' "$LINK" "$(readlink -f "$LINK" 2>/dev/null)"

printf '\n-- node\n'
printf '   /usr/bin/node %s | /usr/bin/npm %s\n' "$(/usr/bin/node -v 2>/dev/null)" "$(/usr/bin/npm -v 2>/dev/null)"

printf '\n-- sudo rule for hqconsole\n'
SUDO_L=$(sudo -l -U hqconsole 2>/dev/null)
printf '%s\n' "$SUDO_L" | sed -n '/may run/,$p' | sed 's/^/   /'

printf '\n-- units\n'
for u in $UNITS; do
  printf '   %-28s enabled=%-10s active=%s\n' "$u" \
    "$(systemctl is-enabled "$u" 2>/dev/null)" "$(systemctl is-active "$u" 2>/dev/null)"
done

printf '\n-- tls (existence and mode only, contents are never read)\n'
for f in "$CERT" "$KEY"; do
  if [ -f "$f" ]; then
    printf '   %s %-22s %s\n' "$(stat -c '%04a' "$f")" "$(stat -c '%U:%G' "$f")" "$f"
  else
    printf '   MISSING %s\n' "$f"
  fi
done

printf '\n-- mirror readability by hqbuild (hub-sync owns the mirrors)\n'
MIRROR=/var/lib/hqsync/mirrors/agent-hq.git
if [ -d "$MIRROR" ]; then
  if sudo -u hqbuild test -r "$MIRROR/HEAD"; then
    printf '   ok hqbuild can read %s\n' "$MIRROR"
  else
    printf '   WARN hqbuild cannot read %s\n' "$MIRROR"
    printf '        Fix in hub-sync (keep the mirrors world-readable) or add hqbuild to hqmirror.\n'
    WARNINGS=$((WARNINGS + 1))
  fi
else
  printf '   not present yet; the hub-sync rollout (ops/console/v2/sync/rollout-hqbox.sh) creates it\n'
fi

printf '\n========================================\n'
printf 'provisioning done: %d change(s), %d warning(s)\n' "$CHANGES" "$WARNINGS"
printf '\nNext, in order:\n'
printf '  1. run the hub-sync rollout, so %s exists\n' "$MIRROR"
printf '  2. sudo systemctl start console-build.service    # first build, watched\n'
printf '     journalctl -u console-build.service -f\n'
printf '  3. it triggers hq-console-activate.service, which starts hq-console.service\n'
printf '  4. sudo systemctl start console-build.timer      # hand over to the 5 min poll\n'
printf '  5. open https://%s:8790 from another tailnet device\n' "$TAILNET_NAME"
printf '========================================\n'
exit 0
