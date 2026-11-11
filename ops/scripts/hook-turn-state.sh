#!/usr/bin/env bash
# Turn-state hook: records whether an HQ terminal is mid-turn or has finished its turn,
# so the console can tell a working pane from one that is done and wants the owner
# (the owner, 2026-10-20: "a difference between an idle terminal, a working terminal,
# and a terminal that needs me").
#
# Wired in ~/.claude/settings.json (user level, so rig worktrees are covered too):
#   UserPromptSubmit and PreToolUse  -> working
#   Stop                             -> idle
# PreToolUse is there because a Stop that another hook blocks lets the session carry
# on without a new prompt; the next tool call puts it back to working.
#
# Idle here means only "the turn ended". Whether the terminal is really finished (the
# console's red card) is decided by ops/console/liveness.py from the claude process
# itself (Claude Code's own busy/shell/idle status and its child processes), because a
# turn can end with a background Bash, Monitor or Agent still running (hq-6ih29.1;
# counting those from hook events went red early twice in review).
#
# Writes $HQ/state/turns/<id>.json = {"turn":"working|idle","at":"<ISO UTC>"} for the
# session id the launcher exported (CDP_TERMINAL_ID for spawn.sh, n for wake.sh and
# term.sh, HQ_CONSOLE_SID for console terminals). No id, no write. Rewrites only on a change of
# turn (and a working mark every 5 minutes), so the PreToolUse hot path is one small read. Fail-open: always exits 0, prints
# nothing.

set -u
# The session evaluator is a claude -p child of the session it judges; its turns are not
# the pane's. Children inherit the parent's ids, so the id a launcher set explicitly for
# its own child wins: CDP_TERMINAL_ID (spawn.sh), then n (wake.sh, term.sh), and the
# console's HQ_CONSOLE_SID only when neither is set.
[ "${HQ_SESSION_EVAL:-}" = 1 ] && exit 0
id="${CDP_TERMINAL_ID:-${n:-${HQ_CONSOLE_SID:-}}}"
[ -n "$id" ] || exit 0
case "$id" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac
[ "${#id}" -le 64 ] || exit 0

event="${1:-}"
if [ -z "$event" ]; then
  # Claude Code passes the event on stdin as JSON; only the name is needed.
  event="$(head -c 4096 2>/dev/null | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[A-Za-z]*"' | head -1 | sed 's/.*"\([A-Za-z]*\)"$/\1/')"
fi
case "$event" in
  UserPromptSubmit|PreToolUse) turn=working ;;
  Stop) turn=idle ;;
  *) exit 0 ;;
esac

dir="${HQ_TURN_DIR:-${HQ_ROOT:-$HOME/hq}/state/turns}"
file="$dir/$id.json"
# Unchanged turn: no write. A working mark is refreshed every 5 minutes so the console
# can tell a long turn from one that died without a Stop (Esc, a killed process).
if [ -r "$file" ] && grep -q "\"turn\":\"$turn\"" "$file" 2>/dev/null; then
  [ "$turn" = working ] && [ -z "$(find "$file" -mmin +5 2>/dev/null)" ] && exit 0
  [ "$turn" = idle ] && exit 0
fi
mkdir -p "$dir" 2>/dev/null || exit 0
tmp="$file.$$.tmp"
printf '{"turn":"%s","at":"%s"}\n' "$turn" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp" 2>/dev/null \
  && mv -f "$tmp" "$file" 2>/dev/null
rm -f "$tmp" 2>/dev/null
exit 0
