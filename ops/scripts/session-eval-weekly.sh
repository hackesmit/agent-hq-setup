#!/usr/bin/env bash
# Weekly (runs after retro.sh via hq-retro.service): fold the last 7 days of session-eval
# FLAG verdicts into ONE fix bead, only if some cause repeats twice; otherwise nothing.
# Reads ops/metrics/session-eval.log (verdict lines end with cause=<class>, a class from
# session_eval_cause.py; older free-form causes map by keyword). --dry-run prints.
# Env: SESSION_EVAL_LOG (log path), SESSION_EVAL_NOW (epoch, for fixtures).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
LOG="${SESSION_EVAL_LOG:-$HQ/ops/metrics/session-eval.log}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
[ -f "$LOG" ] || exit 0

REPORT="$(LOG="$LOG" NOW="${SESSION_EVAL_NOW:-$(date +%s)}" SE_DIR="$DIR" python3 - <<'PY'
import os, re, sys, datetime, collections
sys.path.insert(0, os.environ["SE_DIR"])
from session_eval_cause import classify
now = int(os.environ["NOW"]); groups = collections.defaultdict(list)
for line in open(os.environ["LOG"]):
    f = line.rstrip("\n").split("\t")
    if len(f) < 6 or "verdict=FLAG" not in f: continue
    try:
        if now - datetime.datetime.fromisoformat(f[0]).timestamp() > 7 * 86400: continue
    except Exception: continue
    raw = next((x[6:] for x in f if x.startswith("cause=")), "")
    detail = next((x[7:] for x in f if x.startswith("detail=")), "") or raw
    # group by fixed class (hq-oq30g.1); old free-form causes map by keyword, and what
    # still lands in "other" groups by its own words so an exact repeat still folds
    cls = classify(raw)
    key = cls if cls and cls != "other" else (f"other: {detail}" if detail else "uncategorized")
    groups[key].append((f[1][4:12], f[5], detail))
rep = {c: v for c, v in groups.items() if len(v) >= 2 and c != "uncategorized"}
for c, v in sorted(rep.items(), key=lambda kv: -len(kv[1])):
    print(f"Cause: {c} ({len(v)} sessions)")
    for sid, summ, det in v[:6]: print(f"  - {sid} [{det}]: {summ[:140]}")
PY
)"
if [ -z "$REPORT" ]; then echo "no repeated FLAG cause this week: no bead"; exit 0; fi

DESC="Repeated session-eval FLAG causes in the last 7 days (source: ops/metrics/session-eval.log).
$REPORT

Definition of Done:
- Outcome: the top cause no longer repeats (guard, rule or hook that prevents it)
- Proof: a fixture or command showing the guarded case; the next weekly run lists the cause fewer than twice
- Constraints: smallest enforcing mechanism; reversible; revert step on the bead
- Stop-when: the fix would remove a check that guards money, auth or data; ask
- Verification receipt emitted before close"
if [ "$DRY" = 1 ]; then echo "WOULD FILE: session-eval weekly fix"; echo "$DESC"; exit 0; fi
# one open weekly bead at a time: append to it instead of filing another
cd "$HQ" && OPEN="$(bd list --label session-eval-weekly --status open --limit 0 --json 2>/dev/null | jq -r '.[0].id // empty')"
if [ -n "$OPEN" ]; then bd comment "$OPEN" "$DESC" >/dev/null; echo "commented $OPEN"; exit 0; fi
bd create "Session-eval: repeated FLAG cause (weekly)" -t task -p 2 -l session-eval-weekly,hq,P2 -d "$DESC"
