#!/usr/bin/env bash
# git-sync: the auto-pusher.
#
# Reviewed branches are merged into the local main/master in-repo (local merges need
# no credential and no network). This daemon runs as a plain tmux window, outside any
# agent session, and watches each repo; when the default branch is ahead of origin, it
# pushes. Since proposal 58 agents can push too, so this is the routine path, not a
# privilege boundary: it keeps main published within about 45 seconds of a merge.
#
# Push policy (the owner's choice): auto-push ALL rigs including acme (which
# deploys to Vercel prod). Fast-forward only — the pre-push hook blocks force
# and delete regardless. The quality gate is the adversarial reviewer plus the
# overseer's serial-merge discipline: main only advances via reviewed merges.
#
# Pull policy (2026-08-17): every cycle also fetches, and when the default branch
# is BEHIND origin and not ahead it fast-forwards. Two boxes (laptop WSL and
# hqbox) both merge and push; before this, neither ever pulled, so each drifted
# until a push was rejected as non-fast-forward and both sides went silent. A
# diverged branch is not resolved here (a rebase on main is a judgment call);
# it is reported through the error system so the one-shot fixer picks it up.
#
# Reporting: fetch, push and pull failures and divergence go to hq_mail.report as
# [HQ-ERROR] (project hq-git-sync), rate-limited to one report per repo and
# type per hour so a 45s loop cannot turn one failure into a mail storm. Every
# cycle touches state/heartbeat/git-sync; the mail poller reports the loop
# dead if it stops (ops/mail/heartbeats.json).
#
# Usage: git-sync.sh [--watch]   (no arg = one-shot; --watch = 45s loop)
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
CRED="store --file $HQ/.git-credentials"
LOG="$HQ/ops/git-sync.log"

MAIL="$HQ/ops/mail"
STAMPS="$HQ/state/git-sync"
REPORT_COOLDOWN=3600

# report_once <repo-name> <type> <message>: one [HQ-ERROR] per repo+type per
# hour, context = the tail of this log. Returns 1 while the cooldown holds so
# the caller can gate its desktop ping on the same clock. The reporter itself
# never fails the caller: it is a side channel, and a reporter that could
# wedge the sync loop would be worse than the failure it reports, hence the
# hard timeout. The stamp is written AFTER a confirmed send; a failed send
# backdates it so the retry comes in REPORT_RETRY seconds, not an hour.
REPORT_TIMEOUT=60
REPORT_RETRY=300
report_once() {
  local name="$1" type="$2" msg="$3"
  mkdir -p "$STAMPS" 2>/dev/null || true
  local stamp="$STAMPS/$name.$type"
  if [ -e "$stamp" ]; then
    local age=$(( $(date +%s) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) ))
    [ "$age" -lt "$REPORT_COOLDOWN" ] && return 1
  fi
  if tail -n 40 "$LOG" 2>/dev/null | PYTHONPATH="$MAIL${PYTHONPATH:+:$PYTHONPATH}" \
      timeout "$REPORT_TIMEOUT" python3 -m hq_mail.report --project hq-git-sync \
        --type "$type" --message "$msg" --frame "$name" --context-file - >>"$LOG" 2>&1; then
    touch "$stamp" 2>/dev/null || true
    return 0
  fi
  echo "$(date +%H:%M:%S) report of $name $type failed to send; retry in ${REPORT_RETRY}s" >>"$LOG"
  touch -d "@$(( $(date +%s) - REPORT_COOLDOWN + REPORT_RETRY ))" "$stamp" 2>/dev/null || true
  return 1
}

heartbeat() {
  PYTHONPATH="$MAIL${PYTHONPATH:+:$PYTHONPATH}" \
    timeout 20 python3 -m hq_mail.heartbeat touch git-sync >>"$LOG" 2>&1 || true
}

# fold_if_upstream <repo> <name> <branch> <ahead>: 0 when all local-only commits
# are present upstream by patch-id and the rebase onto @{u} succeeded, else 1
# (nothing changed). Rebase runs with --autostash so a dirty shared checkout is
# left exactly as it was; a rebase that would stop is aborted.
fold_if_upstream() {
  local repo="$1" name="$2" br="$3" ahead="$4" up_ids local_ids id
  up_ids=$(git -C "$repo" log --format=%H '@{u}' --not HEAD 2>/dev/null | while read -r c; do git -C "$repo" show "$c" 2>/dev/null | git patch-id --stable | cut -d' ' -f1; done)
  local_ids=$(git -C "$repo" log --format=%H HEAD --not '@{u}' 2>/dev/null | while read -r c; do git -C "$repo" show "$c" 2>/dev/null | git patch-id --stable | cut -d' ' -f1; done)
  # every local-only commit must be upstream by patch-id; a commit with no diff
  # (allow-empty markers, e.g. sync checks) has no patch-id and is folded freely
  local n_local
  n_local=$(git -C "$repo" rev-list --count HEAD --not '@{u}' 2>/dev/null || echo 0)
  [ "${n_local:-0}" -gt 0 ] || return 1
  for id in $local_ids; do
    printf '%s\n' "$up_ids" | grep -qx "$id" || return 1
  done
  if git -C "$repo" rebase --quiet --autostash '@{u}' >>"$LOG" 2>&1; then
    return 0
  fi
  git -C "$repo" rebase --abort >>"$LOG" 2>&1 || true
  echo "$(date +%H:%M:%S) fold of $name failed; rebase aborted (see ops/git-sync.log)"
  return 1
}

push_one() {
  local repo="$1" name="$2"
  [ -e "$repo/.git" ] || return 0
  local br; br=$(git -C "$repo" symbolic-ref --short HEAD 2>/dev/null) || return 0
  { [ "$br" = main ] || [ "$br" = master ]; } || return 0   # default branch only
  git -C "$repo" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || return 0  # has upstream
  # Fetch first so ahead/behind is measured against origin as it is now, not
  # as it was at the last push. A failed fetch (revoked PAT, DNS, GitHub down)
  # skips this cycle rather than acting on a stale @{u}, and is reported on
  # the hourly clock: with nothing to push, a dead fetch is otherwise the one
  # failure this loop would never notice.
  if ! git -C "$repo" -c credential.helper="$CRED" fetch -q >>"$LOG" 2>&1; then
    echo "$(date +%H:%M:%S) FETCH FAILED $name (see ops/git-sync.log)"
    report_once "$name" FetchFailed "git fetch of $name/$br from origin failed; ahead/behind cannot be trusted and nothing is pulled or pushed until it recovers" || true
    return 0
  fi
  local ahead behind
  ahead=$(git -C "$repo" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  behind=$(git -C "$repo" rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
  if [ "${behind:-0}" -gt 0 ] && [ "${ahead:-0}" -eq 0 ]; then
    if git -C "$repo" merge --ff-only '@{u}' >>"$LOG" 2>&1; then
      echo "$(date +%H:%M:%S) pulled $name ($behind commit(s) <- origin/$br)"
    else
      echo "$(date +%H:%M:%S) PULL FAILED $name (see ops/git-sync.log)"
      report_once "$name" PullFailed "fast-forward of $name/$br from origin failed with $behind commit(s) behind; likely a dirty working tree or a local file in the way"
    fi
    return 0
  fi
  if [ "${behind:-0}" -gt 0 ] && [ "${ahead:-0}" -gt 0 ]; then
    # Fold: when every local-only commit already exists upstream by patch-id (the
    # other box or hub-sync rebased and pushed our commits), replaying them onto
    # @{u} is a no-op and the branch simply catches up. autostash keeps other
    # sessions' uncommitted work; anything else stays a reported divergence.
    if fold_if_upstream "$repo" "$name" "$br" "$ahead"; then
      echo "$(date +%H:%M:%S) folded $name ($ahead local commit(s) already upstream, now at origin/$br)"
      return 0
    fi
    echo "$(date +%H:%M:%S) DIVERGED $name (ahead $ahead, behind $behind); not pushing"
    if report_once "$name" Diverged "$name/$br has diverged from origin: ahead $ahead, behind $behind. Both boxes merged; the local commits need a rebase onto origin/$br (git rebase origin/$br in $repo), then git-sync pushes"; then
      "$DIR/notify.sh" default "Diverged" "$name ahead $ahead / behind $behind; reported to the error system"
    fi
    return 0
  fi
  [ "${ahead:-0}" -gt 0 ] || return 0
  if git -C "$repo" -c credential.helper="$CRED" push >>"$LOG" 2>&1; then
    echo "$(date +%H:%M:%S) pushed $name ($ahead commit(s) -> origin/$br)"
  else
    echo "$(date +%H:%M:%S) PUSH FAILED $name (see ops/git-sync.log)"
    if report_once "$name" PushFailed "push of $name/$br rejected with $ahead commit(s) ahead; see the log tail for git's reason"; then
      "$DIR/notify.sh" default "Push failed" "$name; reported to the error system, see ops/git-sync.log"
    fi
  fi
}

sync_all() {
  push_one "$HQ" "agent-hq"
  for r in "$HQ"/rigs/*/; do push_one "$r" "$(basename "$r")"; done
}

# Repo-wide write lock shared with the console (design 4.2, hq-fyyl): the
# console's truths writes and this loop's fetch/ff/push must not interleave on
# the hq repo. Provisioning creates /run/lock/hq-git.lock on hqbox (root-owned,
# group hqgit, 0660); where it does not exist or is not openable (this laptop,
# a box before provisioning) the cycle runs bare, exactly as before. A holder
# that keeps us out past 60s skips ONE cycle and reports on the hourly clock.
GIT_LOCK="/run/lock/hq-git.lock"
sync_all_locked() {
  if [ -w "$GIT_LOCK" ]; then
    (
      exec 9>>"$GIT_LOCK" || exit 0
      if ! flock -w 60 9; then
        echo "$(date +%H:%M:%S) LOCK BUSY: hq-git.lock held over 60s; skipping this cycle"
        report_once "agent-hq" LockBusy "hq-git.lock held over 60 seconds; git-sync skipped a cycle. A wedged console truths write or a manual holder needs a look." || true
        exit 0
      fi
      sync_all
    )
  else
    sync_all
  fi
}

if [ "${1:-}" = "--watch" ]; then
  echo "git-sync watching (every 45s). Ctrl-c to stop."
  # also flush the knowledge outbox into the vault each cycle. Agents append knowledge
  # via vault.sh; it lands here.
  # hub-auth-alert turns hub-sync's published auth state into one notify per outage
  # (hub-sync runs as hqsync and cannot reach notify.sh, hq-7llgp.1)
  while true; do sync_all_locked; "$DIR/vault-sync.sh" >>"$LOG" 2>&1 || true; "$HQ/ops/console/v2/sync/hub-auth-alert.sh" >>"$LOG" 2>&1 || true; heartbeat; sleep 45; done
else
  sync_all_locked
  "$DIR/vault-sync.sh" >>"$LOG" 2>&1 || true
  "$HQ/ops/console/v2/sync/hub-auth-alert.sh" >>"$LOG" 2>&1 || true
  heartbeat
fi
