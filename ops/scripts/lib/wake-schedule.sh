# wake-schedule.sh: shared by snooze.sh and wake-resume.sh (hq-1nkg.11).
# hq_schedule_wake <id> <epoch>: (re)create the one-shot user timer hq-wake-<id> that runs
# wake.sh <id> at <epoch>. Returns 0 when systemd-run accepted it. Needs HQ, SYSTEMD_RUN and
# SYSTEMCTL set by the caller. An older timer of the same name is stopped first because
# systemd-run refuses a unit name that is still loaded.
# hq-1nkg.17: the stop/recreate runs under state/wake-<id>.lock taken with flock -n on its own
# fd 8, so it cannot kill a wake.sh that already holds the lock (after the pane opened, before
# the registry update). Returns 3 when the lock is held (a wake is in flight, skip the row).
# Callers must not hold the lock themselves: wake.sh never calls this, snooze.sh and
# wake-resume.sh do not hold it (wake-resume's wake.sh child takes and drops it before exit).
hq_schedule_wake(){
  local id="$1" epoch="$2" unit="hq-wake-$1" v st="${HQ_STATE_DIR:-$HQ/state}" rc
  mkdir -p "$st" 2>/dev/null || true
  (
    flock -n 8 || exit 3
    "$SYSTEMCTL" --user stop "$unit.timer" "$unit.service" >/dev/null 2>&1 || true
    "$SYSTEMCTL" --user reset-failed "$unit.timer" "$unit.service" >/dev/null 2>&1 || true
    # the user manager's env is bare: carry PATH (claude, bd, tmux) and the HQ overrides along
    envs=(--setenv=PATH="$PATH" --setenv=HOME="$HOME")
    for v in HQ_ROOT HQ_STATE_DIR HQ_TMUX_SERVERS HQ_NO_NOTIFY TMUX_TMPDIR; do
      [ -n "${!v:-}" ] && envs+=(--setenv="$v=${!v}")
    done
    "$SYSTEMD_RUN" --user --no-block --collect --unit="$unit" \
      --on-calendar="@$epoch" --timer-property=AccuracySec=1s \
      --description="hq wake $id" "${envs[@]}" \
      "$HQ/ops/scripts/wake.sh" "$id" >/dev/null 2>&1 8>&-
  ) 8>"$st/wake-$id.lock"
}
