#!/usr/bin/env bash
# wake.sh <id>  — fired by the scheduler (or by hand). Revive a snoozed session:
# reopen a seeded terminal in its worktree with objectives reinjected, mark it active,
# clear wake_at, and remove the one-shot systemd user timer hq-wake-<id> (hq-1nkg.2).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
. "$SCRIPT_DIR/lib/tmux-server.sh"   # hq_tmux_server (hq-1nkg.1)
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SYSTEMCTL="${HQ_SYSTEMCTL:-systemctl}"
die(){ echo "wake: $1" >&2; exit "${2:-1}"; }

id="${1:-}"; [ -n "$id" ] || die "usage: wake.sh <id>" 2
# one wake per id at a time: the lock covers the snoozed check through the registry update, so
# two wakes started together cannot both read snoozed and open two panes (hq-1nkg.15). The
# second waits, then re-reads the row, sees active, and exits 3.
STATE="${HQ_STATE_DIR:-$HQ/state}"; mkdir -p "$STATE"
exec 9>"$STATE/wake-$id.lock"
flock -w 60 9 || die "could not lock $id within 60s (another wake holds it)" 1
entry="$("$REGSH" get "$id" 2>/dev/null)" || die "no such session: $id" 2
getf(){ printf '%s' "$entry" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }
status="$(getf status)"
# only a snoozed row is revived: a timer that fires after a manual wake, a second wake-resume
# pass, or a console answer racing the timer must not open a second pane (hq-1nkg.14). Exit 3
# is the distinct "already revived, nothing done" code, so callers can tell it from a launch.
if [ "$status" != snoozed ]; then
  echo "wake: $id is $status, not snoozed; nothing to do"; exit 3
fi
rig="$(getf rig)"; worktree="$(getf worktree)"; bead="$(getf bead)"
objrel="$(getf objectives_file)"; obj="$HQ/$objrel"

[ -x "$HQ/ops/scripts/notify.sh" ] && "$HQ/ops/scripts/notify.sh" default "wake" \
  "reviving $bead ($rig)" >/dev/null 2>&1 || true

# relaunch as a tiled pane in the hq:work window, reinjecting the objectives file. The hq
# session is on the default or the hqterm server and the console calls this with no $TMUX:
# hq_tmux_server points tmux at the right server, and every target is the exact `=hq`
# (a bare `-t hq` prefix-matched hq-errors and revived the worker there, hq-1nkg.1).
target="hq:work"
# HQ_NO_TMUX is the explicit test/headless opt-out and counts as launched; otherwise a pane
# must really open, or the row stays snoozed and wake.sh exits 1 so callers retry (hq-1nkg.14).
nopane(){ echo "wake: $id not woken: no pane launched ($1); row stays snoozed" >&2; exit 1; }
if [ -n "${HQ_NO_TMUX:-}" ]; then :
elif ! hq_tmux_server; then nopane "hq tmux session missing"
fi
# The revived pane reuses the id, so the turn file the hook left at snooze time would show
# a stale idle mark (a red "finished" card) until the seed prompt submits. Start clean:
# no turn data reads as idle, never red (hq-6ih29.1).
rm -f "$STATE/turns/$id.json" 2>/dev/null
if [ -z "${HQ_NO_TMUX:-}" ]; then
  kind="$(getf kind)"; model="$(getf model)"
  if [ "$kind" = worker ]; then
    ls_="${HQ_STATE_DIR:-$HQ/state}/launch-$id-wake.sh"
    mkdir -p "${HQ_STATE_DIR:-$HQ/state}/logs"
    {
      printf '%s\n' '#!/usr/bin/env bash'
      printf '%s\n' 'set -o pipefail'
      printf 'export CDP_TERMINAL_ID=%q\n' "$id"
      # A revived rig worker loads hq's hooks the same way spawn.sh launches it (hq-je3fk.6).
      wsettings=""
      hooks_hq="$(git -C "$HQ" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"; hooks_hq="${hooks_hq:-$HQ}"
      if [ "$rig" != hq ] && [ -f "$hooks_hq/ops/config/worker-hooks.json" ]; then
        printf 'export HQ_HOOK_DIR=%q\n' "$hooks_hq/ops/scripts"
        wsettings="$(printf ' --settings %q' "$hooks_hq/ops/config/worker-hooks.json")"
      fi
      printf 'cd %q || exit 1\n' "$worktree"
      printf 'claude -p %q --dangerously-skip-permissions --strict-mcp-config%s --model %q 2>&1 | tee -a %q\n' \
        "Read $obj and resume where you left off." "$wsettings" "${model:-claude-opus-5-5}" "${HQ_STATE_DIR:-$HQ/state}/logs/$id.log"
    } > "$ls_"
    chmod +x "$ls_"
    printf -v cmd 'bash %q' "$ls_"   # safe if the state path ever contains spaces
  else
    cmd="env CDP_TERMINAL_ID=$id claude --dangerously-skip-permissions --strict-mcp-config"
  fi
  if tmux list-windows -t '=hq' -F '#W' 2>/dev/null | grep -qx work; then
    target="$(tmux split-window -t '=hq:work' -c "$worktree" -PF '#{pane_id}' "$cmd" 2>/dev/null)"
  else
    target="$(tmux new-window -t '=hq:' -n work -c "$worktree" -PF '#{pane_id}' "$cmd" 2>/dev/null)"
  fi
  case "$target" in %*) ;; *) nopane "tmux did not open a pane";; esac
  tmux set -w -t '=hq:work' remain-on-exit on 2>/dev/null || true
  # term-retile.sh keeps its plain hq:work (its lock name is shared with term.sh); tmux tries an
  # exact session name before a prefix, and hq_tmux_server proved =hq exists on this server.
  "$SCRIPT_DIR/term-retile.sh" hq:work >/dev/null 2>&1 || tmux select-layout -t '=hq:work' tiled >/dev/null 2>&1 || true
  tmux select-pane -t "$target" -T "$id $rig (woke)" >/dev/null 2>&1 || true
  [ "$kind" = worker ] || tmux send-keys -t "$target" "Read $obj and resume where you left off." Enter 2>/dev/null || true
fi

# record the NEW pane id so reconcile doesn't prune the revived session
"$REGSH" update "$id" --status active --wake-at "" --window "$target" >/dev/null 2>&1 || true
# unschedule: an elapsed transient timer can stay loaded, and a manual wake must cancel a
# pending one. Stop the timer only, never hq-wake-<id>.service: when the timer fired, this
# script IS that service. Tolerant when the timer is already gone.
if [ -z "${HQ_NO_SCHEDULE:-}" ]; then
  "$SYSTEMCTL" --user stop "hq-wake-$id.timer" >/dev/null 2>&1 || true
  "$SYSTEMCTL" --user reset-failed "hq-wake-$id.timer" >/dev/null 2>&1 || true
fi

echo "woke $id ($rig): status=active"
