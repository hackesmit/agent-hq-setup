#!/usr/bin/env bash
# finish.sh [<id>] [--confirm]
# S4: wind a session down cleanly. Without --confirm: DRY — print the finish-plan, mutate
# nothing irreversible. With --confirm: commit pending work, refresh codemaps, merge the
# branch to the rig default (conflict-checked, degrades without S3's conflict-check.sh),
# close the bead IFF it carries a Verification receipt, remove the worktree, and — only when
# merged AND closed — deregister + kill the tmux window; otherwise mark status=finishable.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
. "$SCRIPT_DIR/lib/tmux-server.sh"   # hq_kill_registry_window (hq-1nkg.1)
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BD="${HQ_BD:-bd}"
die(){ echo "finish: $1" >&2; exit "${2:-1}"; }

# --- args ---
id=""; confirm=0; reqapp=0; expecthead=""
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) confirm=1;;
    --require-approval) reqapp=1;;
    # The sha the operator actually approved. The approval gate below proves the
    # branch head matches a Review-Approve marker, which says "somebody reviewed
    # this head"; it does not say "the human who just clicked read THIS head". If
    # the branch advanced and picked up a newer marker, both are true of a commit
    # nobody at the keyboard has seen. This pins it.
    --expect-head) expecthead="${2:-}"; shift;;
    --*) die "unknown arg: $1" 2;;
    *) id="$1";;
  esac; shift
done
if [ -n "$expecthead" ]; then
  case "$expecthead" in *[!0-9a-f]*) die "bad --expect-head: not lowercase hex" 2;; esac
  [ "${#expecthead}" -eq 40 ] || die "bad --expect-head: want a full 40-character sha" 2
fi

# --- resolve session ---
if [ -z "$id" ]; then
  ids="$("$REGSH" list --status active --json 2>/dev/null | python3 -c 'import json,sys
[print(e["id"]) for e in json.load(sys.stdin)]' 2>/dev/null)"
  n="$(printf '%s\n' "$ids" | grep -c . || true)"
  [ "$n" = 1 ] || die "specify a session id (active: $(echo $ids))" 2
  id="$(printf '%s' "$ids" | tr -d '[:space:]')"
fi
entry="$("$REGSH" get "$id" 2>/dev/null)" || die "no such session: $id" 2
getf(){ printf '%s' "$entry" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }
rig="$(getf rig)"; worktree="$(getf worktree)"; branch="$(getf branch)"
bead="$(getf bead)"; window="$(getf tmux_window)"
# rig "hq" is the hq repo itself (~/hq), not a directory under rigs/.
[ "$rig" = hq ] && RIGDIR="$HQ" || RIGDIR="$HQ/rigs/$rig"
default="$(git -C "$RIGDIR" symbolic-ref --short HEAD 2>/dev/null || echo main)"

# --- assess (read-only) ---
pending=0
if [ -d "$worktree" ] && [ -n "$(git -C "$worktree" status --porcelain 2>/dev/null)" ]; then pending=1; fi
has_receipt=0
# hq-caa6. finish.sh runs UNATTENDED, and a stop here is expensive: it leaves a
# merged branch with an open bead and a live pane for the operator to rescue by
# hand. A friction audit of the 95 real receipts in this workspace found the
# documented three-field shape is honored in the breach (19 carry no separator at
# all, 11 carry one), so enforcing it here would have stopped most honest closes.
# The close decision therefore stays exactly as permissive as it has always been:
# any Verification line counts. receipt_ok below decides only whether a WARNING is
# printed. hook-verify-gate.sh is the teacher, because it is interactive and can
# print something the worker acts on immediately; this is a visibility backstop.
# TRADE ACCEPTED, stated plainly: this reopens the path where a hollow receipt
# merges and closes. On a single-operator box a false stop costs more than a fake
# receipt slipping past, and the warning still puts it on the operator's screen.
receipt_ok(){
  awk -v LONE=20 '
  BEGIN {
    # Class vocabulary and leniency rules kept in step with hook-verify-gate.sh.
    # The aliases beyond the table in CLAUDE.md (docs, test, build, lint, config)
    # are what workers actually write, and rejecting them taught nobody anything.
    TOK   = "(docs-only|docs|doc|not run|markdown|memory|report|json|settings"
    TOK   = TOK "|shell[ _-]?hook|shell|code|url|ui|deploy|data|tests|test|lint"
    TOK   = TOK "|build|config|script|hook)"
    # a TIGHT hyphen also joins a union (workers write url-ui as often as url/ui);
    # a SPACED hyphen stays a separator, so `code - build - 12 passed` is unharmed
    JOIN  = "([[:space:]]*[/,+][[:space:]]*|-)"
    CEXPR = "^" TOK "(" JOIN TOK ")*"
    SEP   = "[[:space:]]+[^[:alnum:][:space:]]+[[:space:]]+"
    PADC  = "[`*_.,;:![:space:]]"
    # only the tokens from the bead template count as an unfilled placeholder, so
    # an honest receipt mentioning <div> or an html comment is not thrown out
    PH    = "<[[:space:]]*(class|command or tool|command/tool|command|tool|result"
    PH    = PH "|blocker)[[:space:]]*>"
  }
  function trim(s){ sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
  function strippad(s){ gsub("^" PADC "+", "", s); gsub(PADC "+$", "", s); return s }
  # true when the WHOLE field is a hopeful word rather than a named tool. Equality
  # only, never substring, so npm test and cargo test survive. jq is NOT here,
  # because the JSON row in CLAUDE.md prescribes exactly that command.
  function hopeful(s, minlen,  t){
    t = tolower(strippad(s))
    if (length(t) < minlen) return 1
    if (t == "ok" || t == "okay" || t == "test" || t == "tests" ||
        t == "pass" || t == "passed" || t == "passes" || t == "done" ||
        t == "yes" || t == "fine" || t == "good" || t == "green" ||
        t == "true" || t == "n/a" || t == "na") return 1
    return 0
  }
  function evaluate(s,  r, cexpr, rest, n, parts, m, toks, i, twofield, ev, res){
    r = tolower(s)
    n = index(r, "verification:")
    if (n == 0) return 0
    r = trim(substr(r, n + 13))
    if (r ~ PH) return 0
    if (!match(r, CEXPR)) return 0
    cexpr = substr(r, 1, RLENGTH)
    rest = substr(r, RLENGTH + 1)
    # the class ends at whitespace, or at punctuation that is itself the separator
    # (workers write `Shell hook: bash -n ...` as often as `shell hook - ...`)
    if (rest != "" && rest !~ /^[[:space:]]/){
      if (rest !~ /^[^[:alnum:][:space:]]+[[:space:]]/) return 0
      rest = " " rest
    }
    twofield = (cexpr == "not run" || cexpr == "docs-only")
    n = split(rest, parts, SEP)
    if (n > 0 && strippad(parts[1]) != "") return 0
    if (n < 2) return 0
    ev = parts[2]
    for (i = 3; i <= n; i++) ev = ev " " parts[i]
    # not run / docs-only: the single field carries everything, floor of 2 chars
    if (twofield) return hopeful(ev, 2) ? 0 : 1
    # one separator only: accept when that field is long enough to be naming both a
    # tool and an outcome, which is how a third of real receipts are actually written
    if (n == 2) return length(strippad(ev)) >= LONE ? 1 : 0
    if (hopeful(parts[2], 2)) return 0         # the command field must name a tool
    res = parts[3]
    for (i = 4; i <= n; i++) res = res " " parts[i]
    if (strippad(res) == "") return 0          # the result field only has to exist
    return 1
  }
  { lines[NR] = $0 }
  END {
    for (i = 1; i <= NR; i++){
      if (tolower(lines[i]) !~ /verification:/) continue
      cand = lines[i]
      if (evaluate(cand)){ found = 1; break }
      # bd show hard-wraps: a third of real receipts span 4 or more display lines
      for (k = 1; k <= 6 && i + k <= NR; k++){
        nx = lines[i + k]
        if (trim(nx) == "") break
        if (tolower(nx) ~ /verification:/) break
        if (nx ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_]*:[[:space:]]/) break
        cand = cand " " trim(nx)
        if (length(cand) > 600) break
        if (evaluate(cand)){ found = 1; break }
      }
      if (found) break
    }
    exit (found ? 0 : 1)
  }'
}
has_receipt=0
# the close decision itself: unchanged, permissive, any Verification line counts
bead_show="$("$BD" show "$bead" 2>/dev/null)"
# Capturado en variable a proposito: con set -o pipefail, un | grep -q sale en
# la primera coincidencia, cierra la tuberia, bd muere con SIGPIPE y el estado
# de la tuberia es 141, asi que un bead CON recibo se reportaba MISSING y
# finish.sh no cerraba nada en ningun rig. Propuesta 49, bead hq-nfbov.
if grep -qi 'Verification:' <<<"$bead_show"; then has_receipt=1; fi
receipt_parses=0
if [ "$has_receipt" = 1 ] && printf '%s\n' "$bead_show" | receipt_ok; then
  receipt_parses=1
fi
# hq-0hq6: rigs whose merges must be published to Vercel by API (Hobby blocks
# the git-triggered deploy of your-gh-user's commits). Read once, used in the plan
# and after the merge.
# ONE validation for both scripts: vercel-deploy.sh --check says 0 (configured),
# 3 (rig not in the map) or 2 (map or entry invalid). Invalid is never "off":
# it shows in the plan and counts as a failed deploy after a merge (lucy).
vercel_projects=""; vercel_conf_bad=0
if [ -f "$HQ/ops/config/vercel-deploy.json" ]; then
  if [ -x "$SCRIPT_DIR/vercel-deploy.sh" ]; then
    vcheck="$("$SCRIPT_DIR/vercel-deploy.sh" --check --rig "$rig" 2>&1)"; vrc0=$?
    case "$vrc0" in
      0) vercel_projects="${vcheck#*configured for }";;
      3) vercel_projects="";;
      *) vercel_conf_bad=1; vercel_projects="(INVALID map or entry: ${vcheck:0:160})";;
    esac
  else
    vercel_conf_bad=1; vercel_projects="(vercel-deploy.sh missing or not executable)"
  fi
fi
mergeable="unknown"
if [ -x "$SCRIPT_DIR/conflict-check.sh" ]; then
  if "$SCRIPT_DIR/conflict-check.sh" "$default" "$branch" --rig "$rig" >/dev/null 2>&1; then mergeable="clean"; else mergeable="conflict"; fi
fi

plan(){
  echo "finish-plan for $id ($rig):"
  echo "  bead:      $bead   receipt: $([ "$has_receipt" = 1 ] && echo present || echo MISSING)"
  echo "  branch:    $branch -> $default   mergeable: $mergeable"
  echo "  worktree:  $worktree   pending-changes: $([ "$pending" = 1 ] && echo yes || echo no)"
  echo "  window:    $window"
  echo "  on --confirm:"
  echo "    - $([ "$pending" = 1 ] && echo 'commit pending work' || echo 'no pending commit')"
  echo "    - attempt merge $branch -> $default (skip + keep branch on conflict)"
  echo "    - drift gate BEFORE the merge: drift-check at the default tip and at the would-be merge result; refuse if the result ADDS a drift item (HQ_DRIFT_BLOCK=0 overrides)"
  echo "    - eval gate BEFORE the merge: if it changes a file in evals/prompt-files.txt, require a passing eval receipt for the merged content (HQ_EVAL_BLOCK=0 overrides)"
  echo "    - $([ "$has_receipt" = 1 ] && echo "close bead $bead" || echo 'SKIP close (no Verification receipt) - leave open')"
  echo "    - remove worktree if merged; deregister + kill window $window only if merged AND closed"
  if [ -n "$vercel_projects" ]; then
    echo "    - publish $default to Vercel by API after the merge ($vercel_projects); a failed deploy warns, never undoes the merge"
  fi
}

if [ "$confirm" != 1 ]; then
  plan
  exit 0
fi

# --- execute (--confirm) ---
if [ "$pending" = 1 ]; then
  git -C "$worktree" add -A >/dev/null 2>&1 || true
  git -C "$worktree" commit -q -m "finish: wrap up $bead" >/dev/null 2>&1 || true
fi

# --- approval gate (console path): runs AFTER the wrap-up commit, immediately
# before merge, so the sha that merges is exactly the sha that was approved ---
if [ "$reqapp" = 1 ]; then
  bhead="$(git -C "$RIGDIR" rev-parse "$branch" 2>/dev/null || true)"
  # structured comment parse: the marker must live in an actual bead COMMENT
  # (newest matching comment wins), never in the description or other fields
  appr="$("$BD" show "$bead" --json --include-comments 2>/dev/null | python3 -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
    d = d[0] if isinstance(d, list) else d
except Exception:
    sys.exit(0)
best = ""
for c in sorted(d.get("comments") or [], key=lambda c: str(c.get("created_at") or "")):
    m = re.findall(r"Review-Approve: ([0-9a-f]{40})", str(c.get("text") or ""))
    if m:
        best = m[-1]
print(best)' || true)"
  [ -n "$bhead" ] && [ "$appr" = "$bhead" ] || \
    die "approval gate: Review-Approve marker (${appr:-none}) != branch head (${bhead:-unknown})" 3
fi

# Refuse outright when the branch no longer points at what was approved. This runs
# after the wrap-up commit, so a session whose own finish added a commit is compared
# against the head that commit produced, not the one from before it.
if [ -n "$expecthead" ]; then
  nowhead="$(git -C "$RIGDIR" rev-parse "$branch" 2>/dev/null || true)"
  [ "$nowhead" = "$expecthead" ] || \
    die "branch moved since you read the gate: approved ${expecthead%"${expecthead#??????????}"} but head is ${nowhead:-unknown}; re-run the check" 3
fi

# --- executable DoD checks (proposal 32, hardened per cross-vendor review):
# a bead may carry one line
#   Checks: <command>
# in its description; it runs in the WORKTREE before the merge, and a
# failure stops the finish exactly like a conflict. Bead text is
# AGENT-WRITABLE while this script runs uncaged, so the command is NOT
# free-form: only known test-runner shapes execute (allowlisted first
# word), anything else is refused loudly. The worktree must come back
# CLEAN: a check that mutated files validated something other than the
# pinned sha, so it does not count. HQ_CHECKS_BLOCK accepts only 0 or 1.
case "${HQ_CHECKS_BLOCK:-1}" in
  0|1) ;;
  *) die "HQ_CHECKS_BLOCK must be 0 or 1, got '${HQ_CHECKS_BLOCK}'" 2;;
esac
# Only the bead's own description counts: review comments routinely quote
# "Checks:" lines (failing checks, file paths) that are not the DoD's command.
checks_cmd="$("$BD" show "$bead" --json 2>/dev/null | jq -r '.[0].description // ""' 2>/dev/null | sed -n 's/^[[:space:]]*Checks:[[:space:]]*//p' | head -1)"
if [ -n "$checks_cmd" ] && [ -d "$worktree" ]; then
  case "$checks_cmd" in
    pytest\ *|pytest|npm\ test*|npm\ run\ test*|npx\ vitest*|vitest*|make\ test*|make\ check*|\
    go\ test*|cargo\ test*|bash\ -n\ *|jq\ empty\ *|python3\ -m\ pytest*|python3\ -m\ unittest*)
      ;;
    *)
      die "bead Checks command is not on the allowlist (test runners only): $checks_cmd" 4;;
  esac
  case "$checks_cmd" in
    *'$('*|*'`'*|*';'*|*'|'*|*'&'*|*'>'*|*'<'*)
      die "bead Checks command may not contain shell metacharacters: $checks_cmd" 4;;
  esac
  checks_log="$(mktemp /tmp/finish-checks-XXXXXX.log)"
  echo "finish: running bead checks: $checks_cmd"
  checks_ok=1
  ( cd "$worktree" && timeout --signal=TERM --kill-after=10s 600s bash -c "$checks_cmd" ) \
    >"$checks_log" 2>&1 || checks_ok=0
  if [ -n "$(git -C "$worktree" status --porcelain 2>/dev/null)" ]; then
    git -C "$worktree" checkout -- . >/dev/null 2>&1 || true
    git -C "$worktree" clean -fd >/dev/null 2>&1 || true
    die "bead checks modified the worktree; the pinned sha was not what passed" 4
  fi
  if [ "$checks_ok" != 1 ]; then
    tail -20 "$checks_log" >&2 || true
    if [ "${HQ_CHECKS_BLOCK:-1}" = 1 ]; then
      "$REGSH" update "$id" --status finishable >/dev/null 2>&1 || true
      die "bead checks FAILED (log: $checks_log); branch and worktree kept" 4
    fi
    echo "finish: checks failed but HQ_CHECKS_BLOCK=0; continuing" >&2
  fi
fi

merged=0
# with the approval gate on, merge the PINNED sha that was checked, not the
# branch name: the branch could advance between the check and the merge
mtarget="$branch"; [ "${reqapp:-0}" = 1 ] && [ -n "${bhead:-}" ] && mtarget="$bhead"
[ -n "$expecthead" ] && mtarget="$expecthead"

# Drift gate (hq-fgg3.1). Decided BEFORE the merge; the default branch is never
# reset. The would-be merge result is built as a dangling commit (merge-tree
# plus commit-tree) and checked out in a throwaway detached worktree under
# /tmp. drift-check runs twice, back to back against the same live box, with
# rigs/<rig> pointed at that worktree (DRIFT_RIG_OVERRIDE), or, when the merge
# is into the hq repo itself, with the checker's repo root (HQ_ROOT) at that
# worktree and its live state (DRIFT_LIVE_ROOT, HQ_STATE_DIR) at the real HQ:
# once at the current default tip, once at the merge result. The merge is refused (exit 5, branch,
# worktree and pane untouched, session finishable) only when the merge result
# ADDS an item. A check that could not run in either run is left out of the
# comparison (drift_check.py --new-since), so a systemd or tmux hiccup never
# turns existing drift into new drift. Any failure of the gate itself (no
# checker, a conflict merge-tree cannot resolve, a checker error) skips it
# with a warning: fail open. HQ_DRIFT_BLOCK=0 turns a refusal into a warning;
# HQ_DRIFT_CHECK overrides the checker (tests). Hooks are off in the throwaway
# worktree so the graphify post-checkout hook does not run there.
case "${HQ_DRIFT_BLOCK:-1}" in
  0|1) ;;
  *) die "HQ_DRIFT_BLOCK must be 0 or 1, got '${HQ_DRIFT_BLOCK}'" 2;;
esac
DRIFT_CHECK="${HQ_DRIFT_CHECK:-$SCRIPT_DIR/drift-check.sh}"
drift_tmp=""; drift_kind=""
drift_cleanup(){
  [ -n "$drift_tmp" ] || return 0
  git -C "$RIGDIR" worktree remove --force "$drift_tmp/wt" >/dev/null 2>&1 || true
  rm -rf "$drift_tmp"; git -C "$RIGDIR" worktree prune >/dev/null 2>&1 || true
  drift_tmp=""
}
trap drift_cleanup EXIT
drift_skip(){ echo "finish: WARNING drift gate skipped: $1" >&2; drift_cleanup; return 0; }
drift_run(){  # <out.json>: 0 when the checker produced a result (exit 0 or 1)
  local rc
  if [ "$drift_kind" = hq ]; then
    # hq-repo merge (hq-fgg3.17): the preview IS the repo tree to judge, so the
    # checker's repo root points at it; state/, rigs/ and gitignored local
    # files still come from the live box (DRIFT_LIVE_ROOT).
    HQ_ROOT="$drift_tmp/wt" DRIFT_LIVE_ROOT="$HQ" HQ_STATE_DIR="${HQ_STATE_DIR:-$HQ/state}" \
      timeout 300 "$DRIFT_CHECK" --json >"$1" 2>/dev/null; rc=$?
  else
    DRIFT_RIG_OVERRIDE="$rig=$drift_tmp/wt" timeout 300 "$DRIFT_CHECK" --json >"$1" 2>/dev/null; rc=$?
  fi
  case "$rc" in 0|1) return 0;; *) return 1;; esac
}
drift_gate(){  # returns 5 to refuse, 0 otherwise
  local t0 base out tree mcommit new rc g
  t0="$(date +%s)"
  g=(git -c core.hooksPath=/dev/null -C "$RIGDIR")
  [ -x "$DRIFT_CHECK" ] || { drift_skip "no checker at $DRIFT_CHECK"; return 0; }
  "${g[@]}" rev-parse --verify -q "$mtarget^{commit}" >/dev/null || return 0
  base="$("${g[@]}" rev-parse HEAD 2>/dev/null)" || { drift_skip "no default tip"; return 0; }
  # Only a merge that touches what drift-check reads can add drift; anything
  # else would only measure environment flap between two runs. The path list
  # is runtime.json gate_paths (drift_check.py --gate-relevant). A relevance
  # check that errors runs the gate anyway.
  local hits
  drift_kind="$rig"
  [ "$(git -C "$RIGDIR" rev-parse --show-toplevel 2>/dev/null)" = "$(git -C "$HQ" rev-parse --show-toplevel 2>/dev/null)" ] && drift_kind=hq
  hits="$("${g[@]}" diff --no-renames --name-only "$base...$mtarget" 2>/dev/null \
          | HQ_ROOT="$HQ" python3 "$SCRIPT_DIR/drift_check.py" --gate-relevant "$drift_kind" 2>/dev/null)"; rc=$?
  if [ "$rc" = 1 ]; then
    echo "finish: drift gate not needed: the merge touches nothing drift-check reads" >&2
    return 0
  fi
  [ "$rc" = 0 ] && echo "finish: drift gate runs: the merge touches $(printf '%s' "$hits" | tr '\n' ' ')" >&2
  out="$("${g[@]}" merge-tree --write-tree "$base" "$mtarget" 2>/dev/null)" \
    || { drift_skip "merge-tree could not build the merge result"; return 0; }
  tree="${out%%$'\n'*}"
  mcommit="$("${g[@]}" commit-tree "$tree" -p "$base" -p "$mtarget" -m "finish drift preview" 2>/dev/null)" \
    || { drift_skip "commit-tree failed"; return 0; }
  drift_tmp="$(mktemp -d /tmp/finish-drift-XXXXXX)" || { drift_skip "mktemp failed"; return 0; }
  "${g[@]}" worktree add -q --detach "$drift_tmp/wt" "$base" >/dev/null 2>&1 \
    || { drift_skip "could not create the preview worktree"; return 0; }
  drift_run "$drift_tmp/before.json" || { drift_skip "drift-check failed at the default tip"; return 0; }
  git -c core.hooksPath=/dev/null -C "$drift_tmp/wt" checkout -q --detach "$mcommit" >/dev/null 2>&1 \
    || { drift_skip "could not check out the merge result"; return 0; }
  drift_run "$drift_tmp/after.json" || { drift_skip "drift-check failed at the merge result"; return 0; }
  new="$(python3 "$SCRIPT_DIR/drift_check.py" --new-since "$drift_tmp/before.json" "$drift_tmp/after.json" 2>&1)"; rc=$?
  drift_cleanup
  echo "finish: drift gate took $(( $(date +%s) - t0 ))s" >&2
  case "$rc" in
    0) [ -n "$new" ] && printf 'finish: drift gate: %s\n' "$new" >&2; return 0 ;;
    1) echo "finish: the merge result ADDS drift (ops/scripts/drift-check.sh):" >&2
       printf '%s\n' "$new" | sed 's/^/  /' >&2
       if [ "${HQ_DRIFT_BLOCK:-1}" = 1 ]; then return 5; fi
       echo "finish: HQ_DRIFT_BLOCK=0, merging anyway" >&2; return 0 ;;
    *) drift_skip "could not compare the two runs: $new"; return 0 ;;
  esac
}
drift_gate; drc=$?
if [ "$drc" = 5 ]; then
  "$REGSH" update "$id" --status finishable >/dev/null 2>&1 || true
  die "refused before merging: the change adds drift (listed above). Nothing was merged; branch, worktree and pane are as they were. If an item is a unit or installed file that differs or is not installed because the branch changed it, install it from the branch, then re-run finish.sh. Otherwise fix it, or re-run with HQ_DRIFT_BLOCK=0 to merge and accept the drift" 5
fi

# Chatbot eval gate (hq-43e6.3): a merge that changes a bot's prompt, tools or
# model (the repo's evals/prompt-files.txt) needs a passing eval receipt for the
# merged content. Same posture as the drift gate: decided before the merge.
EVAL_GATE="${HQ_EVAL_GATE:-$SCRIPT_DIR/eval-gate.sh}"
# Fails closed: a missing gate or any exit other than 0 refuses, unless HQ_EVAL_BLOCK=0.
if git -C "$RIGDIR" rev-parse --verify "$branch" >/dev/null 2>&1; then
  if [ -x "$EVAL_GATE" ]; then HQ_ROOT="$HQ" "$EVAL_GATE" "$RIGDIR" HEAD "$mtarget"; erc=$?
  else echo "finish: eval gate missing or not executable: $EVAL_GATE" >&2; erc=7; fi
  [ "$erc" != 0 ] && [ "${HQ_EVAL_BLOCK:-1}" = 0 ] && { echo "finish: HQ_EVAL_BLOCK=0, merging despite eval gate rc=$erc" >&2; erc=0; }
  if [ "$erc" != 0 ]; then
    "$REGSH" update "$id" --status finishable >/dev/null 2>&1 || true
    die "refused before merging: chatbot behavior files changed without a passing eval (listed above). Nothing was merged. Run the eval on the branch, then re-run finish.sh, or HQ_EVAL_BLOCK=0 to merge anyway and say why on the bead" 6
  fi
fi

if git -C "$RIGDIR" rev-parse --verify "$branch" >/dev/null 2>&1; then
  if git -C "$RIGDIR" merge --no-ff --no-edit "$mtarget" >/dev/null 2>&1; then
    merged=1
  else
    git -C "$RIGDIR" merge --abort >/dev/null 2>&1 || true
  fi
fi

# The graph rebuild runs HERE, after the merge landed (hq-i100). Run before it, as
# it was, it indexes the rig WITHOUT the branch being finished, so the report stays
# one merge behind for ever: a rebuild that succeeds and still leaves the drift.
# No merge means nothing new to index, so it does not run and says nothing extra;
# a failed merge already reports itself.
# graphify lives in ~/.local/bin, which an unattended finish does not have on PATH,
# so the guard extends PATH the way hook-verify-gate.sh and console.sh already do.
# A warning in every branch, a block in none: a stale graph never stops a finish.
if [ "$merged" = 1 ]; then
  export PATH="$HOME/.local/bin:$PATH"
  if command -v graphify >/dev/null 2>&1; then
    glog="$HQ/state/logs/graphify-$(date +%F).log"
    mkdir -p "$HQ/state/logs"
    ( cd "$RIGDIR" && graphify update . ) >>"$glog" 2>&1
    grc=$?
    if [ "$grc" != 0 ]; then
      echo "finish: WARNING graphify update failed for rig $rig (exit $grc); see $glog" >&2
    fi
  else
    echo "finish: WARNING graphify not found on PATH; skipped the graph rebuild for rig $rig (its GRAPH_REPORT.md will drift)" >&2
  fi
fi
# hq-0hq6: the merge is not done until production has it. For rigs listed in
# ops/config/vercel-deploy.json the git-triggered deploy is BLOCKED (Hobby team,
# your-gh-user commits), so vercel-deploy.sh pushes the default branch and creates
# the production deployment by API, waiting for READY. A failure warns loudly
# (stderr, notify, the finish log) and never undoes the merge: the operator
# re-runs `ops/scripts/vercel-deploy.sh --rig <rig>` once the cause is fixed.
deployed="n/a"
if [ "$merged" = 1 ] && [ -n "$vercel_projects" ]; then
  vlog="$HQ/state/logs/vercel-deploy-$(date +%F).log"
  mkdir -p "$HQ/state/logs"
  if [ "$vercel_conf_bad" = 1 ]; then
    echo "== $(date -u +%FT%TZ) finish $id ($rig): deploy not attempted: $vercel_projects" >>"$vlog"; vrc=2
  else
    { echo "== $(date -u +%FT%TZ) finish $id ($rig)"; "$SCRIPT_DIR/vercel-deploy.sh" --rig "$rig"; } >>"$vlog" 2>&1
    vrc=$?
  fi
  if [ "$vrc" = 0 ]; then
    deployed="ok"
    echo "finish: published $default of $rig to Vercel ($vercel_projects); see $vlog"
  else
    deployed="FAILED"
    echo "finish: WARNING Vercel deploy of $rig FAILED (exit $vrc); the merge stands, production is stale. Fix and re-run: ops/scripts/vercel-deploy.sh --rig $rig  (log: $vlog)" >&2
    [ -x "$HQ/ops/scripts/notify.sh" ] && "$HQ/ops/scripts/notify.sh" default "Vercel deploy failed" \
      "$id ($rig): merged but not published; re-run ops/scripts/vercel-deploy.sh --rig $rig" >/dev/null 2>&1 || true
  fi
fi
# hq-caa6: the receipt never blocks the close here, it only speaks up. An
# unattended stop would leave a merged branch with an open bead and a live pane
# for the operator to rescue by hand, which costs more than a hollow receipt.
if [ "$has_receipt" = 1 ] && [ "$receipt_parses" = 0 ]; then
  echo "finish: WARNING receipt on $bead does not parse as class - command - result; closing anyway" >&2
fi
closed=0
if [ "$merged" = 1 ] && [ "$has_receipt" = 1 ]; then
  "$BD" close "$bead" -r "finished via finish.sh ($id)" >/dev/null 2>&1 && closed=1 || true
fi

removed=0
if [ "$merged" = 1 ] && [ -d "$worktree" ]; then
  git -C "$RIGDIR" worktree remove "$worktree" >/dev/null 2>&1 && removed=1 || true
fi

if [ "$merged" = 1 ] && [ "$closed" = 1 ]; then
  "$REGSH" deregister "$id" >/dev/null 2>&1 || true
  # hq-1nkg.7: the session is done, so its generated launcher scripts go too.
  # Only on this branch: a finishable session keeps them for a revive.
  rm -f "${HQ_STATE_DIR:-$HQ/state}/launch-$id.sh" "${HQ_STATE_DIR:-$HQ/state}/launch-$id-wake.sh" "${HQ_STATE_DIR:-$HQ/state}/wake-$id.lock" 2>/dev/null || true
  # on the server that holds =hq (default or hqterm), never by prefix (hq-1nkg.1)
  if [ -z "${HQ_NO_TMUX:-}" ] && [ -n "$window" ]; then
    hq_kill_registry_window "$window" || true
  fi
else
  "$REGSH" update "$id" --status finishable >/dev/null 2>&1 || true
fi

# hq-4npjr.3: tell the orchestrator a merge landed (fail-open, file only).
if [ "$merged" = 1 ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/lib/orchestrator-event.sh" 2>/dev/null \
    && HQ_STATE_DIR="${HQ_STATE_DIR:-$HQ/state}" orch_emit merge_done "$bead" "$id ($rig): closed=$closed deployed=$deployed" || true
fi
[ -x "$HQ/ops/scripts/notify.sh" ] && "$HQ/ops/scripts/notify.sh" low "finish" \
  "$id ($rig): merged=$merged closed=$closed worktree_removed=$removed" >/dev/null 2>&1 || true
"$SCRIPT_DIR/console.sh" log-change "finished $bead ($rig): merged=$merged closed=$closed" \
  --session "$id" >/dev/null 2>&1 || true

echo "finished $id: merged=$merged closed=$closed worktree_removed=$removed deployed=$deployed"
