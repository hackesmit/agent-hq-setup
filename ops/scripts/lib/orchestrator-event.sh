# Orchestrator event emitter (hq-4npjr.3). Sourced by notify.sh and finish.sh.
# orch_emit <type> <bead> <detail>: appends ONE json line to
# state/orchestrator/events.jsonl (design docs/designs/2026-11-04-orchestrator.md
# section 2). Types: worker_done, review_verdict, merge_ready, merge_done.
# Fail-open for the caller: it always returns 0, so a full disk or a bad path
# never breaks a notify or a merge. The file persists the event; the runner
# (hq-4npjr.2) reads it, so a dead runner loses nothing.
# Path: HQ_EVENTS_FILE, else <git common dir's repo>/state (worktree state/ is
# not the main one), else ops/../state. HQ_NO_NOTIFY (test seam) suppresses the
# write unless HQ_EVENTS_FILE is set explicitly.
orch_events_file() {
  if [ -n "${HQ_EVENTS_FILE:-}" ]; then printf '%s' "$HQ_EVENTS_FILE"; return; fi
  local base="${HQ_STATE_DIR:-}" lib common
  if [ -z "$base" ]; then
    lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    common="$(git -C "$lib" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
    if [ -n "$common" ] && [ -d "$(dirname "$common")/state" ]; then base="$(dirname "$common")/state"
    else base="$lib/../../../state"; fi
  fi
  printf '%s/orchestrator/events.jsonl' "$base"
}
orch_emit() {
  [ -n "${HQ_NO_NOTIFY:-}" ] && [ -z "${HQ_EVENTS_FILE:-}" ] && return 0
  local f line
  f="$(orch_events_file)" || return 0
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  # bead: the caller's, else the worker's HQ_BEAD (spawn.sh exports it); session: HQ_SESSION_ID.
  # Unknown stays empty, never guessed. review_verdict also gets a verdict field.
  line="$(ORCH_T="$1" ORCH_B="${2:-${HQ_BEAD:-}}" ORCH_D="${3:-}" ORCH_S="${HQ_SESSION_ID:-}" python3 -c '
import json,os,re,time
t,d=os.environ["ORCH_T"],os.environ["ORCH_D"]
ev={"ts":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"type":t,
 "bead":os.environ["ORCH_B"],"session":os.environ["ORCH_S"],"detail":d}
if t=="review_verdict":
    m=re.findall(r"VERDICT:\s*(approve|block)\b",d,re.I)
    if not m:  # reviewer wording: only when exactly one of the two stems appears
        w={x.lower() for x in re.findall(r"\b(approv|block)",d,re.I)}
        m=["approve" if w=={"approv"} else "block"] if len(w)==1 else []
    ev["verdict"]=m[-1].lower() if m else ""
print(json.dumps(ev))' 2>/dev/null)" || return 0
  [ -n "$line" ] || return 0
  # one O_APPEND write of a short line is atomic, so concurrent emitters never interleave
  printf '%s\n' "$line" >>"$f" 2>/dev/null || true
  return 0
}
