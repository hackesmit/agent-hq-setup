#!/usr/bin/env bash
# spawn.sh <rig> "<task>" [--interactive|--worker] [--model M] [--bead B] [--pane] [--dry-run] [--force] [--review]
# A --bead that a live session (or another dispatch's claim) already holds is
# refused with exit 3 naming the holder (statelib.bead_hold, hq-4npjr.10); a
# dead pane counts as free. --force starts a second worker anyway. A fault in the
# hold check itself (corrupt registry, python error) exits 5 'hold check failed'.
# --review spawns a reviewer on --bead past any hold: the row carries role=reviewer
# and never holds the bead itself (hq-oq30g.2).
# S1: create a worktree+branch for a task, write a durable seed/objectives file, register
# the session, and launch it. --interactive = a tmux terminal the owner drives (Opus);
# --worker = an unattended headless `claude -p` (Sonnet default). Prints the session id last.
# Workers run in the detached tmux session hq-bg (one window each), not tiled in hq:work,
# so the owner's screen holds only what he drives (orchestrator design section 3, hq-4npjr.4).
# --pane restores the tiled hq:work pane. --interactive is always a tiled pane.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
STATE_DIR="${HQ_STATE_DIR:-$HQ/state}"
OBJ_DIR="$STATE_DIR/objectives"
now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
die(){ echo "spawn: $1" >&2; exit "${2:-1}"; }

# ---- unattended workers may run as a less-privileged unix user (bead hq-l7et) ----
# HQ_WORKER_USER names a account with no sudo that owns nothing but its worktrees.
# Only `--worker` sessions are moved: interactive panes are the owner driving, and the
# meta terminal (Capri) is uncaged on purpose, so neither is in scope here.
#
# The one rule that matters: this FAILS THE SPAWN if it cannot actually switch user.
# A silent fall back to the invoking account would be the worst possible outcome,
# because the fleet would look isolated on the dashboard while running with the
# privileges the isolation exists to remove.
worker_user_cmd(){   # $1 = launch script path -> prints the command tmux should run
  if [ -z "${HQ_WORKER_USER:-}" ]; then printf 'bash %s\n' "$1"; return 0; fi
  command -v sudo >/dev/null 2>&1 || die "HQ_WORKER_USER=$HQ_WORKER_USER but sudo is not installed" 3
  id -u "$HQ_WORKER_USER" >/dev/null 2>&1 || die "HQ_WORKER_USER=$HQ_WORKER_USER is not a user on this box" 3
  sudo -n -u "$HQ_WORKER_USER" true 2>/dev/null \
    || die "cannot run as $HQ_WORKER_USER without a password; add the narrow sudoers rule from bead hq-l7et, or unset HQ_WORKER_USER to run workers as $(id -un)" 3
  printf 'sudo -n -u %s bash %s\n' "$HQ_WORKER_USER" "$1"
}

rig="${1:-}"; task="${2:-}"
[ -n "$rig" ] && [ -n "$task" ] || die "usage: spawn.sh <rig> \"<task>\" [--interactive|--worker] [--model M] [--bead B] [--pane] [--dry-run] [--force] [--review]" 2
shift 2
mode="worker"; model=""; bead=""; dry=0; pane=0; force=0; review=0; role=""
while [ $# -gt 0 ]; do
  case "$1" in
    --interactive) mode="interactive";;
    --worker) mode="worker";;
    --model) model="${2:-}"; shift;;
    --bead) bead="${2:-}"; shift;;
    --pane) pane=1;;
    --dry-run) dry=1;;
    --force) force=1;;
    --review) review=1; role=reviewer;;
    *) die "unknown arg: $1" 2;;
  esac; shift
done

# rig "hq" is the hq repo itself (~/hq), not a directory under rigs/.
[ "$rig" = hq ] && RIGDIR="$HQ" || RIGDIR="$HQ/rigs/$rig"
git -C "$RIGDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "no such rig: $rig ($RIGDIR)" 2

# ---- one worker per bead (hq-4npjr.10) ----
# Under the console lock: refuse a bead a live session holds, or one another
# dispatch claimed. ctl dispatch passes its own claim's nonce in HQ_CLAIM_NONCE;
# a direct spawn writes its own claim, so two spawns racing on one bead cannot
# both pass, and releases it once the registry row holds the bead.
own_claim=""
if [ -n "$bead" ] && [ "$force" = 0 ] && [ "$review" = 0 ]; then
  own_claim="$(HQ_CLAIM_NONCE="${HQ_CLAIM_NONCE:-}" BEAD="$bead" RIG="$rig" WR="$STATE_DIR/console" \
    CTL_DIR="$SCRIPT_DIR/../console" python3 - <<'PY'
import os, sys
sys.path.insert(0, os.environ["CTL_DIR"]); import statelib as sl
os.makedirs(os.environ["WR"], exist_ok=True)
bead, given = os.environ["BEAD"], os.environ["HQ_CLAIM_NONCE"]
with sl.locked():
    why = sl.bead_hold(bead, own_nonce=given)
    if why:
        print("refused: " + why + " (--force starts a second worker anyway)", file=sys.stderr)
        raise SystemExit(3)
    if not given:
        nonce = "spawn-" + os.urandom(8).hex()
        sl.claim_bead(bead, os.environ["RIG"], nonce)
        print(nonce)
PY
)"; hold_rc=$?
  # 3 = a real refusal (the holder is on stderr); anything else is the check failing
  case "$hold_rc" in
    0) ;;
    3) die "bead $bead is held; not spawning" 3;;
    *) die "hold check failed for $bead (exit $hold_rc); not spawning" 5;;
  esac
fi
release_own_claim(){
  [ -n "$own_claim" ] || return 0
  NONCE="$own_claim" BEAD="$bead" WR="$STATE_DIR/console" CTL_DIR="$SCRIPT_DIR/../console" python3 -c '
import os, sys
sys.path.insert(0, os.environ["CTL_DIR"]); import statelib as sl
sl.release_claim(os.environ["BEAD"], os.environ["NONCE"])' 2>/dev/null || true
  own_claim=""
}
trap release_own_claim EXIT
# --force over a held bead is the 2026-11-04 incident class, so it leaves a record:
# forced_by on the registry row, a forced line in the orchestrator event log, and a
# notify.sh low. A --force on a free bead is a plain spawn and records nothing.
forced_over=""
if [ -n "$bead" ] && [ "$force" = 1 ]; then
  forced_over="$(BEAD="$bead" WR="$STATE_DIR/console" CTL_DIR="$SCRIPT_DIR/../console" python3 - <<'PY' 2>/dev/null
import os, sys
sys.path.insert(0, os.environ["CTL_DIR"]); import statelib as sl
os.makedirs(os.environ["WR"], exist_ok=True)
with sl.locked():
    print(sl.bead_hold(os.environ["BEAD"], own_nonce=os.environ.get("HQ_CLAIM_NONCE", "")) or "")
PY
)" || forced_over="hold unknown"
fi

suffix="$(printf '%04x' $((RANDOM % 65536)))"
id="s-$suffix"
[ -n "$bead" ] || bead="$rig-$suffix"
slug="$(printf '%s' "$task" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//' | cut -c1-24)"
[ -n "$slug" ] || slug="task"
branch="$rig-$suffix-$slug"
worktree="$HQ/rigs/$rig-$suffix"
# hq worktrees go under the gitignored .claude/worktrees: under rigs/ the mail
# coverage audit would report a worktree of an unlisted project named hq.
[ "$rig" = hq ] && worktree="$HQ/.claude/worktrees/hq-$suffix"
window="hq:$suffix"
if [ -z "$model" ]; then
  # Routing (stack refresh 2026-10-08, proposal 57 carries the CLAUDE.md text):
  # interactive terminals are the owner driving, so they get the current Opus. An
  # unflagged --worker stays on the current Sonnet, the tier for simple beads
  # that spawn without an explicit --model; anything larger is routed with
  # --model at dispatch. Haiku 5.5 is selectable but not the default until five
  # trivial beads have run on it.
  [ "$mode" = interactive ] && model="claude-opus-5-5" || model="claude-sonnet-5-5"
fi

git -C "$RIGDIR" worktree add "$worktree" -b "$branch" >/dev/null 2>&1 || die "worktree add failed ($worktree / $branch)"

mkdir -p "$OBJ_DIR"
obj="$OBJ_DIR/$id.md"

# Project truths (design 4.2, hq-fyyl): render ops/projects/<rig>/truths.json into
# the seed so every worker starts from stated facts instead of guesses. The repo
# copy is the source (readable by every worker), never the vault mirror. The
# console is the single writer; a worker that disagrees asks, it never edits.
truths_file="$HQ/ops/projects/$rig/truths.json"
truths_block="(none recorded yet)"
if [ -s "$truths_file" ]; then
  truths_block="$(jq -r '
    .entries // [] | if length == 0 then "(none recorded yet)" else
      map("- [" + .kind + ", " + (if .confirmed then "confirmed" else "UNCONFIRMED" end) + "] "
          + .text + (if .source then " (source: " + .source + ")" else "" end)) | join("\n")
    end' "$truths_file" 2>/dev/null || echo "(truths.json unreadable; flag it with console.sh ask)")"
fi

# KB tail inlined at spawn (hq-1sdr): the seed used to point workers at the vault
# KB and only about 11% of sessions actually opened it, so the tail of it now rides
# along inside the seed itself. Two filters on the way in:
#   - heading lines and the KB boilerplate ("Read this first", "Tags for search")
#     are dropped. Several vault KBs have a SECOND project's header block appended
#     into them (acme-dashboard at line 125, hq has nine), so a raw tail carries a
#     foreign project's read-this-first directive into a seed whose own instruction
#     is to read this first.
#   - 25 lines, not 40. Measured on the busiest rig KB: 9.2 KB raw over 40 lines,
#     5.7 KB after this filter, and that block is the first thing the worker reads.
kb_file="$("$SCRIPT_DIR/vault-path.sh" 2>/dev/null)/01 Projects/$rig/Knowledge.md"
kb_tail=""
if [ -f "$kb_file" ]; then
  kb_tail="$(grep -v -e '^[[:space:]]*#' -e 'Read this first' -e '^Tags for search:' \
                     "$kb_file" 2>/dev/null | tail -n 25)"
fi
# The ORIENT sentence has to describe what actually got appended. Two of the five
# rigs have no Knowledge.md at all (one has no vault directory either), and the
# vault mount can be missing for any of them, so a seed that promises an inlined
# section which is not there sends the worker hunting before it starts.
if [ -n "$kb_tail" ]; then
  kb_orient="this rig's KB tail is inlined at the END of this file. Read it now, before anything else. Open the full \`01 Projects/$rig/Knowledge.md\` or \`graphify-out/GRAPH_REPORT.md\` only when you need more depth than the tail gives."
else
  kb_orient="this rig has no \`01 Projects/$rig/Knowledge.md\` yet (or the vault is not mounted), so nothing is inlined below and there is no KB section to look for. Skim \`graphify-out/GRAPH_REPORT.md\` instead, and start the KB yourself with the CONTRIBUTE command below."
fi

cat > "$obj" <<EOF
# Objectives — $id ($rig)

**Task:** $task
**Bead:** $bead
**Branch:** $branch
**Worktree:** $worktree
**Model:** $model
**Started:** $(now)

## Definition of Done
- [ ] Task implemented with tests (TDD, house idiom)
- [ ] Docs/codemaps refreshed (finish.sh handles this)
- [ ] Checks green; branch ready for merge (the owner confirms)

## Decisions / progress
(keep this current before any risky or long step — PreCompact backstops it)

## Knowledge base — read first, then contribute
- ORIENT: $kb_orient
- CONTRIBUTE: the moment you learn something reusable (gotcha, pattern, useful command, insight, decision+why), record it so the next agent is faster: \`vault $rig "<one line>" --tag <pattern|gotcha|command|decision|howto>\`. Aim for at least one good note this session.

## Project truths (work from these, never from guesses)
Source: \`ops/projects/$rig/truths.json\`. The console is the single writer: never edit it.
If your work proves an entry wrong, or you need a fact that is missing, say so with
\`ops/scripts/console.sh ask\` and keep going where you can.
$truths_block

## Console (keep the dashboard live for the owner)
- Refine your phases if the defaults don't fit: \`ops/scripts/console.sh phase set $bead "plan, implement, tests, review"\`
- Check off each phase as you finish it: \`ops/scripts/console.sh phase check $bead "<phase>"\`
- Before any ask, read \`ops/reference/owner-facts.md\`: an ask it already answers (or one it lists as open) is a defect.
- Blocked on the owner? Use the ANSWER PROTOCOL. The question prints in this terminal and your
  session's console card shows it as waiting, with an answer box; his reply comes back to you:
  1. \`ops/console/ctl.sh ask "<question>" --bead $bead --session $id --wait\`
  2. If it prints ANSWERED <rid> with the answer text below it: continue with that answer.
  3. If it prints WAITING <rid>: re-run \`ops/console/ctl.sh await <rid>\` (up to 3 times, then step 4).
  4. Still WAITING after that: park yourself and exit cleanly:
     \`ops/console/ctl.sh park-mark <rid> --session $id\`
     \`ops/scripts/snooze.sh "+8 hours" --id $id --reason "awaiting <rid>"\`
     the owner's answer will revive this session with the answer appended to this objectives file.
- Name your card so the dashboard reads as work, not session ids: \`ops/console/ctl.sh name \$(ops/console/ctl.sh whoami) "$task"\`
EOF

# The KB tail is appended with printf, never from inside the heredoc above: a note
# containing $(...) or backticks must land in the seed as inert text (hq-1sdr).
# The empty branch is not decoration: it is what keeps the ORIENT line above honest
# for a rig whose KB does not exist yet.
if [ -n "$kb_tail" ]; then
  printf '\n## Knowledge.md tail (inlined at spawn, last 25 lines, headings filtered)\n%s\n' "$kb_tail" >> "$obj"
else
  printf '\n## Knowledge.md tail (none yet for this rig)\n- No `01 Projects/%s/Knowledge.md` exists yet, so nothing was inlined. Start it: `vault %s "<one line>" --tag <pattern|gotcha|command|decision|howto>`\n' "$rig" "$rig" >> "$obj"
fi

# --- create the visible pane (tiled in the hq:work window) and launch ---
# Each session is a tiled pane in ONE "work" window so they sit side-by-side (Alt-arrows to move;
# click a pane to focus). CDP_TERMINAL_ID=<id> gives each its own stable `cdp` tab scope.
# The hq session is on whichever tmux server hq.sh ran under: the default one, or hq-runner's
# hqterm server (console v2), and a dispatch from the console arrives with no $TMUX. Find it by
# exact name (`=hq`: a bare `-t hq` prefix-matches hq-errors and tiled workers into that
# session) and point tmux, and the term-retile.sh child, at it (hq-fgg3.4). The console's own
# terminals are separate hqt-* sessions that hq-runner owns; stall-watch watches both.
. "$SCRIPT_DIR/lib/tmux-server.sh"   # hq_tmux_server (shared, hq-1nkg.1)
# where: bg = detached session hq-bg (default for --worker), pane = tiled hq:work
where=pane; [ "$mode" = worker ] && [ "$pane" != 1 ] && where=bg
[ "$where" = bg ] && target="hq-bg" || target="hq:work"   # placeholder for --dry-run (no pane created)
# Tags every usage row this session sends to the otel-ledger (hq-pgbpq.6) with the
# session, bead and rig. Only [A-Za-z0-9._-] survive: the attribute list is comma and
# equals separated, and the interactive cmd below is split on spaces.
otel_tag(){ printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
otel_attrs="hq.session=$(otel_tag "$id"),hq.bead=$(otel_tag "${bead:-none}"),hq.rig=$(otel_tag "$rig")"
if [ "$dry" != 1 ]; then
  mkdir -p "$STATE_DIR/logs"
  # A fresh session starts with no turn data (reads idle, never red), whatever an older
  # file under this id says (hq-6ih29.1).
  rm -f "$STATE_DIR/turns/$id.json" 2>/dev/null
  if [ "$mode" = interactive ]; then
    cmd="env CDP_TERMINAL_ID=$id HQ_SESSION_ID=$id HQ_BEAD=$(otel_tag "${bead:-}") OTEL_RESOURCE_ATTRIBUTES=$otel_attrs claude --dangerously-skip-permissions --strict-mcp-config"
  else
    # per-session launch script (avoids tmux command-string quoting; tees output to the log).
    # `claude -p` buffers plain-text output until the run ends, which left worker panes
    # blank for their whole life; stream-json rendered through worker-stream.jq keeps the
    # pane live, and the banner/exit lines make a stalled or dead pane self-describing.
    ls_="$STATE_DIR/launch-$id.sh"
    prompt="Read $obj and complete the task described there."
    log="$STATE_DIR/logs/$id.log"
    # A rig worktree has no .claude/settings.json of hq's, so a rig worker ran none of
    # hq's hooks (retro W44 decision 1, hq-je3fk.6). --settings adds them from the main
    # hq checkout, which outlives any worktree. An hq worker already loads them from its
    # own worktree, and adding them again would fire every hook twice.
    # HQ_HOOKS_ROOT overrides that checkout; only the tests set it.
    # The first entry of `git worktree list` is the main checkout, whatever the git-dir layout.
    hooks_hq="${HQ_HOOKS_ROOT:-$(git -C "$SCRIPT_DIR" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')}"
    [ -n "$hooks_hq" ] || hooks_hq="$(cd "$SCRIPT_DIR/../.." && pwd)"
    settings=""
    [ "$rig" != hq ] && [ -f "$hooks_hq/ops/config/worker-hooks.json" ] \
      && settings="$(printf ' --settings %q' "$hooks_hq/ops/config/worker-hooks.json")"
    {
      printf '%s\n' '#!/usr/bin/env bash'
      printf 'export CDP_TERMINAL_ID=%q\n' "$id"
      printf 'export OTEL_RESOURCE_ATTRIBUTES=%q\n' "$otel_attrs"
      printf 'export HQ_SESSION_ID=%q\n' "$id"
      printf 'export HQ_BEAD=%q\n' "${bead:-}"
      [ -n "$settings" ] && printf 'export HQ_HOOK_DIR=%q\n' "$hooks_hq/ops/scripts"
      printf 'cd %q || exit 1\n' "$worktree"
      printf 'echo %q\n' "worker $id  rig $rig  bead $bead  model $model"
      printf 'echo %q\n' "task: $task"
      printf 'echo %q; echo\n' "log: $log"
      if command -v jq >/dev/null 2>&1; then
        printf 'claude -p %q --dangerously-skip-permissions --strict-mcp-config%s --model %q --output-format stream-json --verbose 2>&1 | jq --unbuffered -Rr -f %q | tee %q\n' \
          "$prompt" "$settings" "$model" "$SCRIPT_DIR/worker-stream.jq" "$log"
      else
        printf 'claude -p %q --dangerously-skip-permissions --strict-mcp-config%s --model %q 2>&1 | tee %q\n' \
          "$prompt" "$settings" "$model" "$log"
      fi
      printf '%s\n' 'rc=${PIPESTATUS[0]}'
      printf '%s\n' 'echo; echo "[exit] worker rc=$rc $(date -u +%H:%M:%SZ)"'
      printf '%s\n' 'exit "$rc"'
    } > "$ls_"
    # 0755, not 0700: a different unix user has to read and execute this. It carries
    # the task prompt, the model and paths, never a secret, so widening the mode here
    # does not widen what a reader learns.
    chmod 0755 "$ls_"
    cmd="$(worker_user_cmd "$ls_")" || exit 3
  fi
  if hq_tmux_server; then
    # keep tmux's own complaint: a split that fails for want of room used to be
    # discarded, leaving target empty, the session registered against no pane,
    # and the caller told nothing. "Dispatch created no terminal" with no error
    # anywhere is the worst failure this script has.
    tmuxerr="$STATE_DIR/logs/spawn-$id.tmux.err"
    if [ "$where" = bg ]; then
      # one window per worker in a detached session; created on first use
      if tmux has-session -t '=hq-bg' 2>/dev/null; then
        target="$(tmux new-window -t '=hq-bg:' -n "$id" -c "$worktree" -PF '#{pane_id}' "$cmd" 2>"$tmuxerr")"
      else
        target="$(tmux new-session -d -s hq-bg -n "$id" -c "$worktree" -PF '#{pane_id}' "$cmd" 2>"$tmuxerr")"
      fi
    elif tmux list-windows -t hq -F '#W' 2>/dev/null | grep -qx work; then
      target="$(tmux split-window -t hq:work -c "$worktree" -PF '#{pane_id}' "$cmd" 2>"$tmuxerr")"
    else
      target="$(tmux new-window -t hq -n work -c "$worktree" -PF '#{pane_id}' "$cmd" 2>"$tmuxerr")"
    fi
    case "$target" in
      %*) rm -f "$tmuxerr";;
      *)  why="$(tail -n 1 "$tmuxerr" 2>/dev/null)"
          # roll back the worktree and branch so a retry is not blocked by the
          # leftovers of an attempt that never produced a session
          git -C "$RIGDIR" worktree remove --force "$worktree" >/dev/null 2>&1 || true
          git -C "$RIGDIR" branch -D "$branch" >/dev/null 2>&1 || true
          die "tmux made no pane in $([ "$where" = bg ] && echo hq-bg || echo hq:work) (${why:-no error text}); nothing was spawned"
          ;;
    esac
    if [ "$where" = bg ]; then
      tmux set -w -t "$target" remain-on-exit on 2>/dev/null || true   # finished windows stay readable until finish
    else
      tmux set -w -t hq:work remain-on-exit on 2>/dev/null || true   # finished panes stay readable until finish
      "$SCRIPT_DIR/term-retile.sh" hq:work >/dev/null 2>&1 || tmux select-layout -t hq:work tiled >/dev/null 2>&1 || true
    fi
    tmux select-pane -t "$target" -T "$id $rig${bead:+ $bead}" >/dev/null 2>&1 || true
    [ "$mode" = interactive ] && tmux send-keys -t "$target" "Read $obj and begin this task. $task" Enter 2>/dev/null || true
  else
    # no 'hq' tmux session (running outside the overseer) — fall back to headless, no pane
    target="detached"
    [ "$mode" = worker ] && ( CDP_TERMINAL_ID="$id" nohup bash "$ls_" >/dev/null 2>&1 & )
    echo "spawn: no 'hq' tmux session — ran $mode headless (no visible pane); start it with: hq" >&2
  fi
fi

"$REGSH" register --id "$id" --kind "$mode" --rig "$rig" --worktree "$worktree" \
  --branch "$branch" --bead "$bead" --window "$target" --model "$model" \
  --objectives "state/objectives/$id.md" ${role:+--role "$role"} \
  ${forced_over:+--forced-by "${HQ_SESSION_ID:-$(id -un)}: $forced_over"} \
  >/dev/null || die "register failed"
release_own_claim   # the registry row holds the bead from here on
if [ -n "$forced_over" ]; then
  echo "spawn: --force: $id starts on $bead over: $forced_over" >&2
  ( . "$SCRIPT_DIR/lib/orchestrator-event.sh" 2>/dev/null \
      && HQ_STATE_DIR="$STATE_DIR" orch_emit forced "$bead" "$id over $forced_over (by ${HQ_SESSION_ID:-$(id -un)})" ) || true
  "$SCRIPT_DIR/notify.sh" low "Forced second worker" "$id on $bead over: $forced_over" >/dev/null 2>&1 || true
fi

# seed a default phase checklist so the console shows this session immediately (worker refines it)
"$SCRIPT_DIR/console.sh" phase set "$bead" "plan, implement, tests, review" \
  --session "$id" --title "$task" >/dev/null 2>&1 || true

if [ "$dry" = 1 ]; then
  echo "spawn-plan: mode=$mode id=$id branch=$branch worktree=$worktree pane=$target where=$where model=$model runas=${HQ_WORKER_USER:-$(id -un)}"
else
  :   # (no spawn ping — it's a deliberate action; the pane appearing is the signal)
fi
echo "$id"
