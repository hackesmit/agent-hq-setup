#!/usr/bin/env bash
# P0.7 rollout on hqbox (run ON hqbox as owner, sudo available). Idempotent, staged:
#   stage 1: hqsync credential store, mirrors for every repo, hq-hub-sync unit live
#   stage 2: owner checkouts repointed at the mirrors (origin = local path); owner git-sync keeps
#            running unchanged (it now talks to the mirror; hub-sync forwards to GitHub)
#   stage 3 (--retire-pat): after a verified round trip, remove the owner-readable PAT file
# Usage: rollout-hqbox.sh [--stage1|--stage2|--retire-pat|--status]  (default: stage1 then stage2)
set -uo pipefail
HQ=/home/owner/hq
SYNC=$HQ/ops/console/v2/sync
LIB=/usr/local/lib/hq-console   # root-owned copy hqsync can read (hqsync has no access to /home/owner)
MIRRORS=/var/lib/hqsync/mirrors
CRED_DIR=/var/lib/hqsync/cred
CRED_STORE=$CRED_DIR/store
OWNER_STORE=$HQ/.git-credentials
die(){ echo "rollout: FATAL $*" >&2; exit 1; }
say(){ echo "rollout: $*"; }

need_users(){ id hqsync >/dev/null 2>&1 || die "user hqsync missing (run the console provisioning first)"; getent group hqgit >/dev/null || die "group hqgit missing"; }

stage1(){
  need_users
  getent group hqmirror >/dev/null || sudo groupadd --system hqmirror || die groupadd
  for u in hqsync owner hqbuild; do id -nG "$u" | tr ' ' '\n' | grep -qx hqmirror || sudo usermod -aG hqmirror "$u" || die "usermod $u"; done
  sudo install -d -o hqsync -g hqmirror -m 2775 "$MIRRORS" || die "mkdir mirrors"
  sudo install -d -o hqsync -g hqsync -m 0700 "$CRED_DIR" || die "mkdir cred"
  if [ ! -s "$CRED_STORE" ]; then
    [ -s "$OWNER_STORE" ] || die "no owner credential store to copy from"
    sudo install -o hqsync -g hqsync -m 0600 "$OWNER_STORE" "$CRED_STORE" || die "copy credential store"
    say "credential store installed for hqsync"
  fi
  sudo install -d -m 0755 "$LIB" && sudo install -m 0755 "$SYNC/hub-sync.sh" "$LIB/hub-sync.sh" || die "install hub-sync.sh"
  sudo touch /var/lib/hqsync/repos.conf && sudo chown hqsync:hqsync /var/lib/hqsync/repos.conf
  # repos: hq itself plus every rig checkout under ~/hq/rigs
  local name url branch dir
  for dir in "$HQ" "$HQ"/rigs/*/; do
    dir="${dir%/}"; [ -d "$dir/.git" ] || continue
    name="$(basename "$dir")"; [ "$dir" = "$HQ" ] && name=agent-hq
    [[ "$name" =~ -[0-9a-f]{4}$ ]] && continue   # worker worktrees (rig-XXXX) are not repos of their own
    url="$(git -C "$dir" remote get-url origin)"; case "$url" in https://github.com/*) ;; /var/lib/hqsync/*) url="$(sudo -u hqsync git -C "$MIRRORS/$name.git" remote get-url origin)";; *) say "skip $name (origin $url)"; continue;; esac
    branch="$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || echo main)"
    sudo -u hqsync env HUB_MIRRORS="$MIRRORS" HUB_REPOS_CONF=/var/lib/hqsync/repos.conf HUB_CRED_FILE="$CRED_STORE" HUB_LOCK=/run/lock/hqgit/hq-git.lock HUB_HEARTBEAT=/var/lib/hqsync/heartbeat HUB_STATUS=/var/lib/hqsync/status.json HOME=/var/lib/hqsync \
      bash "$LIB/hub-sync.sh" --init "$name" "$url" "$branch" || die "init mirror $name"
    sudo chgrp -R hqmirror "$MIRRORS/$name.git" && sudo chmod -R g+rwX "$MIRRORS/$name.git" && sudo find "$MIRRORS/$name.git" -type d -exec chmod g+s {} +
  done
  sudo install -m 0644 "$SYNC/hq-hub-sync.service" /etc/systemd/system/hq-hub-sync.service || die "install unit"
  sudo systemctl daemon-reload && sudo systemctl enable --now hq-hub-sync.service || die "enable unit"
  sleep 3; systemctl is-active hq-hub-sync.service || die "unit not active"
  say "stage1 done"; status
}

stage2(){
  local name dir url
  # the mirrors are owned by hqsync; git refuses cross-owner repos unless they are marked safe
  local m
  for m in "$MIRRORS"/*.git; do
    git config --global --get-all safe.directory 2>/dev/null | grep -qx "$m" || git config --global --add safe.directory "$m"
  done
  for dir in "$HQ" "$HQ"/rigs/*/; do
    dir="${dir%/}"; [ -d "$dir/.git" ] || continue
    name="$(basename "$dir")"; [ "$dir" = "$HQ" ] && name=agent-hq
    [[ "$name" =~ -[0-9a-f]{4}$ ]] && continue
    [ -d "$MIRRORS/$name.git" ] || { say "no mirror for $name, skipping"; continue; }
    url="$(git -C "$dir" remote get-url origin)"
    if [ "$url" != "$MIRRORS/$name.git" ]; then
      git -C "$dir" config remote.origin.github-url "$url"   # keep the original for the record
      git -C "$dir" remote set-url origin "$MIRRORS/$name.git" || die "set-url $name"
      git -C "$dir" fetch -q origin || die "fetch from mirror $name"
      say "$name origin now the mirror"
    fi
  done
  say "stage2 done"; status
}

retire_pat(){
  [ -s "$CRED_STORE" ] || die "hqsync store missing; refusing"
  systemctl is-active hq-hub-sync.service >/dev/null || die "hub-sync not active; refusing"
  grep -q '"agent-hq":"ok"' /var/lib/hqsync/status.json 2>/dev/null || die "hub-sync status not ok for agent-hq; refusing"
  if [ -e "$OWNER_STORE" ]; then shred -u "$OWNER_STORE" && say "owner-readable PAT file removed"; fi
  status
}

status(){
  echo "--- hub-sync"; systemctl is-active hq-hub-sync.service; cat /var/lib/hqsync/status.json 2>/dev/null; echo
  echo "--- mirrors"; ls "$MIRRORS" 2>/dev/null | tr '\n' ' '; echo
  echo "--- owner remotes"; for d in "$HQ" "$HQ"/rigs/*/; do [[ "$(basename "$d")" =~ -[0-9a-f]{4}$ ]] && continue; [ -d "$d/.git" ] && printf '%s %s\n' "$(basename "$d")" "$(git -C "$d" remote get-url origin)"; done
  echo "--- owner PAT file present: $([ -e "$OWNER_STORE" ] && echo yes || echo no)"
}

case "${1:-}" in
  --stage1) stage1;; --stage2) stage2;; --retire-pat) retire_pat;; --status) status;;
  "") stage1 && stage2;;
  *) die "unknown arg $1";;
esac
