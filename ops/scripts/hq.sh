#!/usr/bin/env bash
# hq.sh — start (or attach to) the HQ terminal workspace.
# A tiled 'work' window of Claude terminals you create/kill/move/resize with Alt-keys
# (see ops/tmux/hq.conf), plus background service windows (monitor, git-sync; the console is hq-console.service).
set -e
export PATH="$HOME/.local/bin:$PATH"
# hq_tmux_server: the hq session may already run on the default or the hqterm server
# (console v2). Every target below is the exact `=hq`; a bare `-t hq` prefix-matched
# hq-errors, so the boot "attached" to that and never built hq (hq-1nkg.1).
. "$(cd "$(dirname "$(readlink -f "$0")")" && pwd)/lib/tmux-server.sh"
cd ~/hq
caller_tmux="${TMUX:-}"

# Attach only when there is a terminal. Under systemd (tmux-hq.service) there
# is no tty, so after the layout is built the launcher exits 0 instead of
# running a tmux attach that is certain to fail. That keeps a non-zero exit
# meaning a real failure, so the unit treats it as one and OnFailure= alerts.
# switch-client only works inside a client of the same server; from anywhere else attach
# to the server that holds hq by its socket ($TMUX unset, or tmux refuses to nest).
land() {
  hq_tmux_server || true
  local sock="${TMUX:-}"; sock="${sock%%,*}"
  if [ -n "$caller_tmux" ] && [ "${caller_tmux%%,*}" = "$sock" ]; then exec tmux switch-client -t '=hq'; fi
  if [ -t 0 ] && [ -t 1 ]; then
    if [ -n "$sock" ]; then exec env -u TMUX tmux -S "$sock" attach -t '=hq'; fi
    exec tmux attach -t '=hq'
  fi
  echo "hq session ready (no tty, not attaching): tmux ${sock:+-S $sock }attach -t =hq"
  exit 0
}

# already running (on the default or the hqterm server)? attach.
if hq_tmux_server; then land; fi

# The integrity check and canaries WARN, they do not refuse the boot (hq-fgg3.3).
# Before proposal 58 these were a gate: modified guards meant possibly
# tampered guards, so nothing launched. Since proposal 58 agents edit hooks and
# settings as normal work (invariant 7) and hold root, so a dirty tree is a
# usual state and refusing protects nothing. Refusing took down git-sync, the
# monitor and stall-watch with it (2026-10-16, 58 h, hq-7pvm), which is far
# worse than the drift it reported. the owner still gets an urgent notify.
if ! git diff --quiet -- .claude ops/githooks ops/scripts || \
   [ -n "$(git status --porcelain -- .claude ops/githooks ops/scripts)" ]; then
  ./ops/scripts/notify.sh urgent "Config drift" "Uncommitted changes in .claude, ops/githooks or ops/scripts at boot; launching anyway. Review with git -C ~/hq status." || true
  echo "WARN: guard/hook/settings files differ from committed state; launching anyway."
fi
if ! ./ops/scripts/canaries.sh; then
  ./ops/scripts/notify.sh urgent "Canaries failed" "Guard canaries failed at boot; launching anyway. Run ops/scripts/canaries.sh." || true
  echo "WARN: canaries failed; launching anyway."
fi

# session + workspace keybindings/settings
tmux new-session -d -s hq -n monitor './ops/scripts/monitor.sh'
tmux source-file ops/tmux/hq.conf

# background service windows
tmux new-window -t '=hq:' -n sync './ops/scripts/git-sync.sh --watch'
tmux new-window -d -t '=hq:' -n watch 'bash ~/hq/tools/hq-watch/stall-watch.sh --loop'
tmux new-window -d -t '=hq:' -n cpu-watch 'bash ~/hq/tools/hq-watch/cpu-watch.sh --loop'

# the first work terminal (term.sh creates the 'work' window; fallback if anything errors)
./ops/scripts/term.sh >/dev/null 2>&1 || tmux new-window -t '=hq:' -n work -c ~/hq 'claude --dangerously-skip-permissions --strict-mcp-config'

# land on the workspace
tmux select-window -t '=hq:work' 2>/dev/null || true
land
