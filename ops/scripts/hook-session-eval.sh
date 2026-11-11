#!/usr/bin/env bash
# Stop hook: per-session post-hoc eval (fire-and-forget behavioral backstop).
# Catches what a diff cannot: scope drift, guardrail-fighting, wrong-target action,
# credential exposure, the claim-vs-evidence gap. Gates in the foreground (dedup,
# trivial-session skip, self-skip), then backgrounds a cheap-model reviewer so the
# session exits with zero delay. Verdict -> P2 session-eval bead; ESCALATE -> P1.
# Respects stop_hook_active; skips its own eval subprocesses; fail-open throughout.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
# A rig worker loads this hook through ops/config/worker-hooks.json, so its project dir is
# the rig, not hq. spawn.sh exports HQ_HOOK_DIR (the main hq checkout's ops/scripts) for
# exactly those workers, so state lands in hq by an explicit root, never by a filename guess.
if [ -n "${HQ_HOOK_DIR:-}" ] && [ -d "$HQ_HOOK_DIR" ]; then HQ="$(cd "$HQ_HOOK_DIR/../.." && pwd)"
elif [ ! -f "$HQ/ops/scripts/$(basename "$0")" ]; then HQ="$(cd "$(dirname "$0")/../.." && pwd)"; fi
# A session in an hq worktree records to the main checkout, which outlives the worktree.
_hq_main="$(git -C "$HQ" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
case "$_hq_main" in */.git) [ -d "${_hq_main%/.git}/ops/scripts" ] && HQ="${_hq_main%/.git}" ;; esac
export PATH="$HOME/.local/bin:$PATH"

# Never eval an eval (the reviewer runs headless with this set).
[ "${HQ_SESSION_EVAL:-0}" = "1" ] && exit 0

PAYLOAD="$(cat)"
export PAYLOAD HQ

read -r SID TPATH ACTIVE <<<"$(python3 -c '
import json,os,sys
try:
    d=json.loads(os.environ.get("PAYLOAD",""))
except Exception:
    print("unknown  0"); raise SystemExit
sid=str(d.get("session_id") or "unknown")
tp=str(d.get("transcript_path") or "")
active="1" if d.get("stop_hook_active") else "0"
print(sid, tp if tp else "-", active)
' 2>/dev/null || echo "unknown - 0")"

[ "$ACTIVE" = "1" ] && exit 0
[ "$TPATH" = "-" ] || [ -z "$TPATH" ] && exit 0
[ -f "$TPATH" ] || exit 0

# dedup by session id
SEEN="$HQ/state/eval/eval-seen"
mkdir -p "$HQ/state/eval" 2>/dev/null || true
if [ -f "$SEEN" ] && grep -qxF "$SID" "$SEEN" 2>/dev/null; then exit 0; fi

# Build the packet once (also gives us the trivial-session counts).
PACKET_JSON="$(python3 "$DIR/session-eval-packet.py" "$TPATH" "$HQ" 2>/dev/null || echo '{}')"
export PACKET_JSON

read -r TOOLS MUT TIER RIG <<<"$(python3 -c '
import json,os
try:
    d=json.loads(os.environ.get("PACKET_JSON","") or "{}")
except Exception:
    d={}
print(int(d.get("tool_count",0)), int(d.get("mutation_count",0)),
      d.get("tier","haiku"), d.get("rig","") or "hq")
' 2>/dev/null || echo "0 0 haiku hq")"

# trivial-session gate: skip if <3 tools and 0 mutations. Do NOT mark the session
# seen here: Stop fires every turn, and a quiet first turn used to exempt the whole
# session for good (2026-10 retro: 15 evals against ~420 non-trivial transcripts).
if [ "${TOOLS:-0}" -lt 3 ] && [ "${MUT:-0}" -eq 0 ]; then
    exit 0
fi

echo "$SID" >> "$SEEN" 2>/dev/null || true
SAFE_SID="$(printf '%s' "$SID" | tr -c 'A-Za-z0-9._-' '_')"
PFILE="$HQ/state/eval/${SAFE_SID}.packet.json"
printf '%s' "$PACKET_JSON" > "$PFILE" 2>/dev/null || exit 0

# Fire-and-forget: detach the model call so Stop returns immediately.
MODEL="claude-haiku-5-5"
[ "$TIER" = "sonnet" ] && MODEL="claude-sonnet-5-5"
setsid bash "$DIR/session-eval-run.sh" "$PFILE" "$MODEL" "$RIG" "$SID" \
    >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
