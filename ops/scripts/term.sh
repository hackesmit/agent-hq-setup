#!/usr/bin/env bash
# term.sh [rig] [--task "..."] [--model M] [--dry-run]
# Create an interactive Claude terminal as a tiled pane in the hq:work window (on the
# tmux server that holds the hq session, see hq_tmux_server; console v2 terminals are
# hqt-* sessions made by hq-runner instead, not by this script).
# If a rig is given and its main checkout is already held by a live terminal, the new
# one gets its own git worktree so two terminals on the same project never clash.
# Called by the Alt-n / Alt-t keybindings, by hq.sh for the first terminal, or by hand.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
STATE_DIR="${HQ_STATE_DIR:-$HQ/state}"
die(){ echo "term: $1" >&2; exit "${2:-1}"; }

# Which tmux server holds the hq session (console v2, hq-fgg3.4). hq.sh starts `hq` on
# whatever server its caller's tmux resolves to: the default one, or hq-runner's hqterm
# server (`tmux -L hqterm`) when it ran from a console terminal; a call from the console
# itself has no $TMUX. Find the server with a session named exactly hq (`=hq`, because a
# bare `-t hq` prefix-matches hq-errors) and point tmux, and the term-retile.sh child, at it.
# The console's own terminals are separate hqt-* sessions on hqterm that hq-runner owns;
# this script never creates those.
. "$SCRIPT_DIR/lib/tmux-server.sh"   # hq_tmux_server (shared, hq-1nkg.1)

rig=""; task=""; model=""; dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --task) task="${2:-}"; shift;;
    --model) model="${2:-}"; shift;;
    --dry-run) dry=1;;
    --*) die "unknown arg: $1" 2;;
    *) if [ -z "$rig" ]; then rig="$1"; else task="$1"; fi;;
  esac; shift
done
# a blank rig arg (from the Alt-t prompt) means "no rig"
[ "$rig" = "hq" ] && rig=""

id="t-$(printf '%04x' $((RANDOM%65536)))"
# A bare terminal is the owner at the keyboard: start at the ceiling (CLAUDE.md
# dispatch routing), not one tier below it.
[ -n "$model" ] || model="claude-opus-5-5"
cwd="$HQ"; worktree=""; branch=""

if [ -n "$rig" ]; then
  RIGDIR="$HQ/rigs/$rig"
  git -C "$RIGDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "no such rig: $rig" 2
  # contention: is the rig's main checkout already held by a live terminal?
  taken="$(RIGDIR="$RIGDIR" "$REGSH" list --json 2>/dev/null | RIGDIR="$RIGDIR" python3 -c '
import json,sys,os
rigdir=os.environ["RIGDIR"]
try: rows=json.load(sys.stdin)
except Exception: rows=[]
print(any(r.get("status")=="active" and r.get("worktree")==rigdir for r in rows))' 2>/dev/null)"
  if [ "$taken" = "True" ]; then
    worktree="$HQ/rigs/$rig-${id#t-}"; branch="$rig-${id#t-}"; cwd="$worktree"
    git -C "$RIGDIR" worktree add "$worktree" -b "$branch" >/dev/null 2>&1 || die "worktree add failed ($worktree)"
  else
    cwd="$RIGDIR"; worktree="$RIGDIR"   # holds the main checkout; the next term on this rig will branch
  fi
fi

target="dry"
if [ "$dry" != 1 ]; then
  hq_tmux_server || die "no 'hq' session on the default or hqterm tmux server; run: hq" 2
  # Launch Claude via a per-session script that resets mouse/focus reporting on ANY exit —
  # normal quit, Ctrl-c, or a kill signal (tmux sends SIGHUP) — via a trap, so it can never
  # leave the terminal stuck in mouse mode. (SIGKILL can't be trapped; nothing can.)
  mkdir -p "$STATE_DIR/logs"
  ls_="$STATE_DIR/logs/term-$id.sh"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' '_reset(){ printf "\033[?1000l\033[?1002l\033[?1003l\033[?1004l\033[?1005l\033[?1006l\033[?1015l\033[?1016l\033[?9l\033[?1001l"; }'
    printf '%s\n' 'trap _reset EXIT INT TERM HUP'
    printf 'export CDP_TERMINAL_ID=%q\n' "$id"
    printf 'cd %q || exit 1\n' "$cwd"
    printf '%s\n' 'claude --dangerously-skip-permissions --strict-mcp-config'
  } > "$ls_"
  chmod +x "$ls_"
  printf -v cmd 'bash %q' "$ls_"   # safe if the state path ever contains spaces
  # remain-on-exit BEFORE the pane exists where possible, so even an instantly-dying
  # command routes through term-reap.sh (pane-died hook) instead of racing the option
  if tmux list-windows -t hq -F '#W' 2>/dev/null | grep -qx work; then
    tmux set -w -t hq:work remain-on-exit on 2>/dev/null || true
    target="$(tmux split-window -h -t hq:work -c "$cwd" -PF '#{pane_id}' "$cmd" 2>/dev/null)"
  else
    target="$(tmux new-window -t hq -n work -c "$cwd" -PF '#{pane_id}' "$cmd" 2>/dev/null)"
    tmux set -w -t hq:work remain-on-exit on 2>/dev/null || true
  fi
  [ -n "$target" ] || die "failed to create the terminal pane"
  "$SCRIPT_DIR/term-retile.sh" hq:work >/dev/null 2>&1 || true
  tmux select-pane -t "$target" -T "$id ${rig:-hq}${branch:+ [wt]}" >/dev/null 2>&1 || true
  # rig terminals: one-line KB prime so the agent inherits prior knowledge + contributes back
  if [ -n "$rig" ]; then
    kb="Orient from the project KB first — read ~/hq/outbox/vault/01 Projects/$rig/Knowledge.md and graphify-out/GRAPH_REPORT.md. HQ tools on PATH: \`vault $rig \"<note>\" --tag <kind>\` to record reusable learnings; \`pp item view --vault-name Personal --item-title <X> --field password\` for secrets; \`lucy\` for cross-vendor adversarial review before you ship a non-trivial diff."
    if [ -n "$task" ]; then task="$kb  Task: $task"; else task="$kb  Then tell me you're ready and await my task."; fi
  fi
  # self-naming: a console card should say what the terminal is for, not t-XXXX
  np="Name yourself on the console so the owner can tell the panes apart: run \`ops/console/ctl.sh name \$(ops/console/ctl.sh whoami) \"<short label for what you are working on>\"\`, and re-run it whenever your focus changes."
  # questions: asked here, in this terminal, and filed so the card shows a waiting mark
  ap="When you need the owner's input, ask it here and wait: first run \`ops/console/ctl.sh ask \"<question>\"\` (no --wait) so your console card shows the question as waiting, put the question in your reply and end your turn, and when he answers here run \`ops/console/ctl.sh answer <req-id> --here \"<his answer>\"\`."
  task="${task:+$task  }$np  $ap"
  [ -n "$task" ] && tmux send-keys -t "$target" "$task" Enter 2>/dev/null || true
fi

"$REGSH" register --id "$id" --kind terminal --rig "$rig" --worktree "$worktree" \
  --branch "$branch" --window "$target" --model "$model" >/dev/null || die "register failed"

[ "$dry" = 1 ] && echo "term-plan: id=$id rig=${rig:-none} cwd=$cwd worktree=${worktree:-none} branch=${branch:-none}"
echo "$id"
