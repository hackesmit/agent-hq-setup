#!/usr/bin/env bash
# usage: route.sh [--findings FILE] [--config FILE] [--state FILE] [--date YYYY-MM-DD] [--max-dispatch N] [--offline] [--dry-run]
#
# Autonomy tiers (hq-8cry.5, hardened in hq-8cry.9). Reads a findings file from
# match.sh (default: the newest state/security/findings-*.json), plans each
# finding with route.py and ops/config/security-tiers.json, then acts:
#   every new finding    one bead in the right ledger (the rig's own when the
#                        policy says ledger rig, else hq with the rig label),
#                        external ref secwatch:<rig>/<eco>/<pkg>@<installed>
#   tier C               P0 bead plus notify.sh urgent
#   tier B               redteam bead; the coordinator runs the normal flow plus lucy
#   tier A               spawn.sh worker (Sonnet) that bumps, tests, re-checks the
#                        tier, gets an Opus review and runs finish.sh; held until the
#                        fix version is cooldown_days old, at most --max-dispatch
#                        (default 2) per run
#   a known finding      nothing, unless it gained advisories, a higher fixed
#                        version or a higher tier: then the bead's title,
#                        description, priority and labels are rewritten, it gets a
#                        comment, and an escalation to C pages urgent; a change
#                        in KEV or malicious evidence or a higher severity
#                        alone also rewrites, and KEV or malicious news on an
#                        inactive bead (closed, deferred) reopens it
# The policy text is in .claude/rules/security-watch.md. The rule for duplicates: the
# routing state (state/security/routed.json) plus every secwatch ref already in
# a ledger, open or closed, so a lost state file never files a second bead; a
# bead found only in a ledger is adopted with its tier, advisories, target and
# dispatch state read back from the bead, never assumed.
#
# Side effects are durable: each rewrite, comment, page and label cleanup is
# first queued in the state entry's pending list and removed only after it
# succeeds, so a failed one is retried on every later run. A new bead's entry is
# written before bd create. Every state write is checked (mktemp then mv); a
# failed one stops the run. One run at a time: an exclusive flock on
# <state>.lock covers the plan and every side effect.
#
# Env: HQ (default ~/hq), BD, NOTIFY, SPAWN (commands; tests swap them),
# HQ_SEC_PUBLISHED (publish-date cache, default state/security/published.json).
# Exit 0 routed (an incomplete findings file is routed and reported), 2 usage,
# 3 no findings file, 4 another run holds the lock, 1 a bd, notify or spawn
# call or a state write failed (a failed side effect is retried next run). No
# secret is read or written.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ:-$HOME/hq}"
BD="${BD:-bd}"
NOTIFY="${NOTIFY:-$HQ/ops/scripts/notify.sh}"
SPAWN="${SPAWN:-$HQ/ops/scripts/spawn.sh}"
SESSIONS="${HQ_SESSIONS:-${HQ_STATE_DIR:-$HQ/state}/sessions.json}"
CONFIG="$HERE/../config/security-tiers.json"
STATE="$HQ/state/security/routed.json"
PUBLISHED="${HQ_SEC_PUBLISHED:-$HQ/state/security/published.json}"
FINDINGS=""
DATE="$(date +%F)"
MAXD=2
OFFLINE=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --findings) FINDINGS="${2:?}"; shift 2 ;;
    --config) CONFIG="${2:?}"; shift 2 ;;
    --state) STATE="${2:?}"; shift 2 ;;
    --date) DATE="${2:?}"; shift 2 ;;
    --max-dispatch) MAXD="${2:?}"; shift 2 ;;
    --offline) OFFLINE=--offline; shift ;;
    --dry-run) DRY=1; shift ;;
    *) sed -n '2p' "$0" >&2; exit 2 ;;
  esac
done
STATE_ABS="$(realpath -m "$STATE")"
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "route: bad --date $DATE" >&2; exit 2; }
[[ "$MAXD" =~ ^[0-9]+$ ]] || { echo "route: bad --max-dispatch $MAXD" >&2; exit 2; }
[ -n "$FINDINGS" ] || FINDINGS="$(ls "$HQ"/state/security/findings-????-??-??.json 2>/dev/null | sort | tail -1)"
[ -s "$FINDINGS" ] || { echo "route: no findings file (run match.sh)" >&2; exit 3; }
jq empty "$CONFIG" || { echo "route: bad config $CONFIG" >&2; exit 2; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
rc=0

# One run at a time, from the ledger read to the last side effect.
mkdir -p "$(dirname "$STATE")" || { echo "route: cannot create $(dirname "$STATE")" >&2; exit 1; }
exec 9>>"$STATE.lock" || { echo "route: cannot open $STATE.lock" >&2; exit 1; }
flock -n 9 || { echo "route: another run holds $STATE.lock" >&2; exit 4; }
# Every external command runs with fd 9 closed, so a daemon that bd starts or a
# worker that spawn.sh leaves running never inherits (and keeps) the lock.
bdx() { $BD "$@" 9>&-; }

# ledger_dir <ledger> <rig>: where bd runs for that ledger.
ledger_dir() { if [ "$1" = rig ]; then echo "$HQ/rigs/$2"; else echo "$HQ"; fi; }

# Every secwatch bead already filed, in hq and in each own-ledger rig, with what
# route.py needs to read its routing state back (tier label, advisories, target,
# status, dispatched label).
# A ledger that cannot be read stops the run: read as empty, it would refile
# and redispatch every bead the state lost.
: >"$W/known.jsonl"
while read -r d; do
  [ -d "$d/.beads" ] || continue
  if ! (cd "$d" && bdx list --all -n 0 --json 2>"$W/err") >"$W/ledger.json" || ! jq -e 'type == "array"' "$W/ledger.json" >/dev/null 2>&1; then
    echo "route: cannot read the ledger in $d, stopping: $(tail -1 "$W/err")" >&2; exit 1
  fi
  jq -c '.[] | select((.external_ref // "") | startswith("secwatch:")) | {(.external_ref): {id, status, labels, priority, title, description}}' "$W/ledger.json" >>"$W/known.jsonl"
done < <(echo "$HQ"; jq -r '.rigs | to_entries[] | select(.value.ledger=="rig") | .key' "$CONFIG" | sed "s|^|$HQ/rigs/|")
jq -s 'add // {}' "$W/known.jsonl" >"$W/known.json" || { echo "route: cannot build the ledger index" >&2; exit 1; }

python3 "$HERE/route.py" --findings "$FINDINGS" --config "$CONFIG" --state "$STATE" --date "$DATE" \
  --published "$PUBLISHED" --known "$W/known.json" $OFFLINE >"$W/plan.json" || { echo "route: plan failed" >&2; exit 1; }

summary() { jq -r --arg d "$1" '"route: \($d)\(.file|length) new (\([.file[]|select(.tier=="A")]|length) A, \([.file[]|select(.tier=="B")]|length) B, \([.file[]|select(.tier=="C")]|length) C), \([.update[]|select(.rewrite)]|length) updated, \([.update[]|select(.adopted)]|length) recovered from a ledger, \(.dispatch|length) to dispatch, \(.held|length) held by the cooldown, \(.duplicates) already routed\(if .incomplete then "; findings file INCOMPLETE, kev null routed as unknown" else "" end)"' "$W/plan.json"; }
if [ "$DRY" = 1 ]; then
  summary "dry run: "
  jq -r '.file[] | "  \(.tier) P\(.priority) \(.ledger)/\(.label) \(.package) \(.installed) to \(.fixed // "no fix") (\(.severity), \(.ids|length) advisories): \(.reason)"' "$W/plan.json"
  jq -r '.update[] | select(.rewrite) | "  update \(.bead) to tier \(.tier) P\(.priority)\(if .escalated_from then ", from tier \(.escalated_from)" else "" end)\(if .fixed_from then ", target \(.fixed_from) to \(.fixed)" else "" end)\(if (.new_ids|length)>0 then ", new \(.new_ids|join(", "))" else "" end)"' "$W/plan.json"
  exit 0
fi

# Routing state: key -> {ledger, label, bead, tier, ids, fixed, dispatched, filed,
# item (the last plan for it), pending (side effects not yet done)}.
[ -s "$STATE" ] || printf '{"routed":{}}\n' >"$STATE" || { echo "route: cannot write $STATE" >&2; exit 1; }
st() {  # st <jq args...>: one checked, atomic rewrite of the state file
  local tmp
  tmp="$(mktemp "$STATE.XXXXXX")" || return 1
  if jq "$@" "$STATE" >"$tmp" && [ -s "$tmp" ] && mv -f "$tmp" "$STATE"; then return 0; fi
  rm -f "$tmp"; return 1
}
die_state() { echo "route: state write to $STATE failed, stopping (the ledger refs stop a refile next run)" >&2; exit 1; }
# entry: the state entry for one planned item, merged over what was there.
ENTRY='.routed[$it.key] as $p | .routed[$it.key] = (($p // {}) + {ledger:$it.ledger, label:$it.label,
  tier:$it.tier, ids:$it.ids, fixed:$it.fixed, item:$it, filed:($p.filed // $day)})'
# addops: append ops to an entry's pending list, each at most once.
ADDOPS='.routed[$it.key].pending = (reduce ($ops[]) as $o (.routed[$it.key].pending // []; if any(.[]; . == $o) then . else . + [$o] end))'

body() {  # the bead description for one item, in the ops/templates/bead.md shape
  jq -r --argjson cd "$(jq '.cooldown_days // 7' "$CONFIG")" '
    def flow: if .tier=="A" then "Tier A (autonomous): bump to \(.fixed) in a worktree, run the rig test suite; on green, commit, get a fresh-context Opus 5.5 review (ops/templates/reviewer.md) of the diff plus the raw test output, then re-check that this bead still carries tier-a and still targets \(.fixed) (a later run may have escalated or retargeted it), and only then run ops/scripts/finish.sh. A failing test, a non-approve or a changed tier or target turns this into tier B: stop, comment, relabel tier-b."
      elif .tier=="B" then "Tier B: the normal flow. Dispatch on its own, redteam pass (ops/templates/redteam.md) and a lucy pass on the full diff before merge. No autonomous merge."
      else "Tier C (P0): the owner was paged. Fix now on its own session with a redteam pass (ops/templates/redteam.md); lucy on the full diff before merge. No autonomous merge." end;
    "Rig: \(.label)\nModel: \(if .tier=="A" then "claude-sonnet-5-5" else "claude-opus-5-5" end)\nMCP: none\n" +
    "Context: Security watch finding (hq-8cry). \(.ecosystem) package \(.package) \(.installed) in \(.rig) (\(.sources|join(", "))). Severity \(.severity); KEV \(if .kev==true then "yes" elif .kev==null then "unknown (catalog unavailable)" else "no" end); malicious \(if .malicious==true then "yes" elif .malicious==null then "unknown (not confirmed clean)" else "no" end). Advisories: \(.ids|join(", ")). Tier \(.tier): \(.reason).\n" +
    "Files owned: the dependency manifest and lockfile that pin \(.package) in \(.rig)\n" +
    "Steps: \(flow)\n" +
    "Definition of Done:\n" +
    "- Outcome: \(if .malicious==true then "\(.package) is removed or replaced with a clean version and every secret it could reach is rotated" elif .fixed then "\(.package) resolves to \(.fixed) or later in \(.rig)" else "\(.package) is replaced, removed or mitigated (no fixed version is published)" end)\(if .malicious==null then ", the package is confirmed not malicious (else remove it and rotate every secret it could reach)" else "" end), and the osv-scanner rerun shows none of these advisories\n" +
    "- Proof: ~/.local/bin/osv-scanner scan source -L <lockfile> lists none of \(.ids|join(", ")), and the rig test suite exits 0\n" +
    "- Constraints: no version published less than \($cd) days ago\(if .kev_bypass then " (waived: KEV fix, use --min-release-age=0 on that one install)" elif .hold_until then " (\(.fixed) clears the cooldown on \(.hold_until))" else "" end); install scripts stay off (ops/security/guardrails.sh); no secret in any file, log or bead; no em dashes\n" +
    "- Stop-when: the fix needs a major upgrade or code change beyond the bump (comment, relabel tier-b), or the rig is not deployable\n" +
    "- Verification receipt emitted before close: Verification: code - <osv-scanner and test command> - <result>\n" +
    "Out of scope: other packages, other advisories, refactors"' <<<"$1"
}

# --- new findings: the entry (with its page, if C) is written before the bead ---
while IFS= read -r it; do
  read -r tier ledger rig pri key < <(jq -r '[.tier,.ledger,.rig,.priority,.key]|@tsv' <<<"$it")
  ops='[]'; [ "$tier" = C ] && ops='[{"op":"page"}]'
  st --argjson it "$it" --arg day "$DATE" --argjson ops "$ops" "$ENTRY | .routed[\$it.key] += {bead:\"\", dispatched:false} | $ADDOPS" || die_state
  dir="$(ledger_dir "$ledger" "$rig")"
  mapfile -t lab < <(jq -r '.labels[]' <<<"$it")
  id="$(cd "$dir" 2>/dev/null && bdx create "$(jq -r .title <<<"$it")" -d "$(body "$it")" -p "$pri" -t task -l "$(IFS=,; echo "${lab[*]}")" --external-ref "secwatch:$key" --silent 2>"$W/err")"
  if [ -z "$id" ]; then
    echo "route: filing $key in $dir failed: $(tail -1 "$W/err")" >&2; rc=1; continue
  fi
  st --arg k "$key" --arg b "$id" '.routed[$k].bead = $b' || die_state
  echo "route: filed $id ($tier) $key"
done < <(jq -c '.file[]' "$W/plan.json")

# --- known findings: record the new plan and queue its rewrite, comment and page ---
while IFS= read -r it; do
  msg="$(jq -r --arg d "$DATE" '[(if (.new_ids|length)>0 then "new advisories \(.new_ids|join(", "))" else empty end),
      (if .fixed_from then "target rose \(.fixed_from) to \(.fixed)" else empty end),
      (if .escalated_from then "tier rose \(.escalated_from) to \(.tier): \(.reason)" else empty end),
      ((.evidence // [])[] | "evidence \(.)")]
    | if length>0 then "Security watch \($d): \(join("; "))." else "" end' <<<"$it")"
  ops="$(jq -c --arg m "$msg" '[(if .reopen then {op:"reopen"} else empty end), (if .rewrite then {op:"rewrite"} else empty end), (if $m!="" then {op:"comment",msg:$m} else empty end), (if .page then {op:"page"} else empty end)]' <<<"$it")"
  st --argjson it "$it" --arg day "$DATE" --argjson ops "$ops" \
    "$ENTRY | .routed[\$it.key] += {bead:\$it.bead, dispatched:((\$p.dispatched == true) or (\$it.dispatched == true))} | $ADDOPS" || die_state
  jq -e '.adopted' <<<"$it" >/dev/null && echo "route: recovered $(jq -r '"\(.bead) \(.key) from its ledger (tier \(.tier), dispatched \(.dispatched))"' <<<"$it")"
done < <(jq -c '.update[]' "$W/plan.json")

# --- drain: every pending side effect, from this run or an earlier one ---
# done_op <key> <op json>: drop one op after it succeeded.
done_op() { st --arg k "$1" --argjson o "$2" '.routed[$k].pending -= [$o]' || die_state; }
while IFS= read -r key; do
  e="$(jq -c --arg k "$key" '.routed[$k]' "$STATE")"
  bead="$(jq -r '.bead // ""' <<<"$e")"
  [ -n "$bead" ] || continue  # not filed yet: its ops wait for the bead
  it="$(jq -c '.item // empty' <<<"$e")"
  dir="$(ledger_dir "$(jq -r .ledger <<<"$e")" "$(jq -r '.item.rig // (.label)' <<<"$e")")"
  while IFS= read -r op; do
    case "$(jq -r .op <<<"$op")" in
      rewrite)
        [ -n "$it" ] || { done_op "$key" "$op"; continue; }
        args=()
        while IFS= read -r l; do args+=(--add-label "$l"); done < <(jq -r '.labels[]' <<<"$it")
        while IFS= read -r l; do args+=(--remove-label "$l"); done < <(jq -r '.labels as $keep | (["tier-a","tier-b","tier-c","P0","P1","P2","P3","P4"] - $keep)[]' <<<"$it")
        if (cd "$dir" && bdx update "$bead" --title "$(jq -r .title <<<"$it")" -d "$(body "$it")" -p "$(jq -r .priority <<<"$it")" "${args[@]}" >/dev/null 2>"$W/err"); then
          done_op "$key" "$op"; echo "route: rewrote $bead (tier $(jq -r .tier <<<"$it"), target $(jq -r '.fixed // "no fix"' <<<"$it"))"
        else echo "route: rewrite of $bead failed, retried next run: $(tail -1 "$W/err")" >&2; rc=1; fi ;;
      reopen)
        if (cd "$dir" && bdx reopen "$bead" -r "Security watch: KEV or malicious evidence on an inactive bead" >/dev/null 2>"$W/err"); then
          done_op "$key" "$op"; echo "route: reopened $bead (KEV or malicious evidence)"
        else echo "route: reopening $bead failed, retried next run: $(tail -1 "$W/err")" >&2; rc=1; fi ;;
      comment)
        if (cd "$dir" && bdx comment "$bead" "$(jq -r .msg <<<"$op")" >/dev/null 2>&1); then done_op "$key" "$op"
        else echo "route: comment on $bead failed, retried next run" >&2; rc=1; fi ;;
      page)
        if "$NOTIFY" urgent "Security P0: $(jq -r '"\(.rig) \(.package)"' <<<"$it")" "$bead: $(jq -r '"\(.reason), \(.severity)"' <<<"$it"). Fix now." >/dev/null 2>&1 9>&-; then
          # One atomic swap: the page is done and its paged label is owed, so a
          # failed relabel is retried on every later run instead of lost.
          st --arg k "$key" --argjson o "$op" '.routed[$k].pending = (((.routed[$k].pending // []) - [$o]) + [{op:"mark-paged"}])' || die_state
          echo "route: paged urgent for $bead"
          if (cd "$dir" && bdx update "$bead" --add-label paged >/dev/null 2>&1); then done_op "$key" '{"op":"mark-paged"}'
          else echo "route: adding the paged label to $bead failed, retried next run" >&2; rc=1; fi
        else echo "route: notify failed for $bead, retried next run" >&2; rc=1; fi ;;
      mark-paged)
        if (cd "$dir" && bdx update "$bead" --add-label paged >/dev/null 2>&1); then done_op "$key" "$op"
        else echo "route: adding the paged label to $bead failed, retried next run" >&2; rc=1; fi ;;
      unmark)
        if (cd "$dir" && bdx update "$bead" --remove-label dispatched >/dev/null 2>&1); then done_op "$key" "$op"
        else echo "route: removing the dispatched label from $bead failed, retried next run" >&2; rc=1; fi ;;
      *) done_op "$key" "$op" ;;
    esac
  done < <(jq -c '.pending[]?' <<<"$e")
done < <(jq -r '.routed | to_entries[] | select((.value.pending // []) | length > 0) | .key' "$STATE")

# --- tier A dispatch: beads filed above and earlier held or capped ones ---
# The session registry is the proof of a worker: a bead that already has a
# session is recorded dispatched and never spawned twice. The state records the
# dispatch only after the spawn succeeds, so a crash before the spawn leaves it
# undispatched and the next run sends it (the run lock keeps runs serial).
has_session() {
  [ -f "$SESSIONS" ] && jq -e --arg b "$1" '[(.sessions // .) | to_entries[]? | select((.value.bead? // "") == $b)] | length > 0' "$SESSIONS" >/dev/null 2>&1
}
n=0
while IFS= read -r it; do
  key="$(jq -r .key <<<"$it")"
  read -r disp bead < <(jq -r --arg k "$key" '[(.routed[$k].dispatched // false), (.routed[$k].bead // "")]|@tsv' "$STATE")
  [ -n "$bead" ] && [ "$disp" != true ] || continue
  if [ "$n" -ge "$MAXD" ]; then echo "route: $bead waits for the next run (dispatch cap $MAXD)"; continue; fi
  read -r ledger rig pkg inst fixed < <(jq -r '[.ledger,.rig,.package,.installed,.fixed]|@tsv' <<<"$it")
  dir="$(ledger_dir "$ledger" "$rig")"
  # Fail closed when the registry cannot answer: a corrupt registry never spawns,
  # and a missing one never respawns a bead the ledger already marks dispatched.
  if [ -f "$SESSIONS" ] && ! jq -e 'type == "object"' "$SESSIONS" >/dev/null 2>&1; then
    echo "route: session registry $SESSIONS is unreadable, $bead not dispatched" >&2; rc=1; continue
  fi
  if [ ! -f "$SESSIONS" ] && jq -e '.dispatch_label == true' <<<"$it" >/dev/null; then
    echo "route: no session registry to prove $bead has no worker, not dispatched" >&2; rc=1; continue
  fi
  # The bead itself, read right before the spawn: a claimed or closed bead has or had
  # a worker whatever the state says, and an unreadable bead is never spawned.
  if ! bst="$(cd "$dir" && bdx show "$bead" --json 2>/dev/null | jq -er '.[0].status')"; then
    echo "route: cannot read $bead before the spawn, not dispatched" >&2; rc=1; continue
  fi
  if [ "$bst" = in_progress ] || [ "$bst" = closed ]; then
    st --arg k "$key" '.routed[$k].dispatched = true' || die_state
    echo "route: $bead is $bst in its ledger, recorded as dispatched"; continue
  fi
  if has_session "$bead"; then
    st --arg k "$key" '.routed[$k].dispatched = true' || die_state
    echo "route: $bead already has a worker session, recorded as dispatched"; continue
  fi
  st --arg k "$key" '.routed[$k].pending -= [{op:"unmark"}]' || die_state
  if ! (cd "$dir" && bdx update "$bead" --add-label dispatched >/dev/null 2>&1); then
    echo "route: marking $bead dispatched failed, not dispatched" >&2; rc=1; continue
  fi
  # The re-check reads the routing state as well as the bead: a failed escalation
  # rewrite leaves tier-a on the bead, but the state already holds the new tier and
  # the queued rewrite. An unreadable state fails the check (fail closed). The bead
  # must carry tier-a and no other tier label, and its title must say tier A.
  check="cd $dir && $BD show $bead --json | jq -e --arg f '$fixed' '.[0] | ([(.labels // [])[] | select(startswith(\"tier-\"))] == [\"tier-a\"]) and (.title | endswith(\", tier A)\")) and (.title | contains(\" to \" + \$f + \" (\"))' && jq -e --arg k '$key' --arg f '$fixed' '.routed[\$k] | .tier == \"A\" and .fixed == \$f and ([(.pending // [])[] | select(.op == \"rewrite\")] | length == 0)' $STATE_ABS"
  task="Work security bead $bead (tier A, .claude/rules/security-watch.md). Bump $pkg from $inst to $fixed in $rig, run the rig test suite. On green: commit, spawn a fresh-context Opus 5.5 reviewer (ops/templates/reviewer.md) with only the diff, the bead DoD and the raw test output. On approve, re-check the tier right before finishing: [$check] must exit 0 (the bead is still tier-a and still targets $fixed). Only then write the summary and Verification receipt on the bead and run ops/scripts/finish.sh with your session id and --confirm. On a red test, a non-approve, or a failed tier re-check (a later security run escalated or retargeted the bead): comment why, relabel tier-a to tier-b if it is not already, and stop without merging."
  if "$SPAWN" "$rig" "$task" --worker --model claude-sonnet-5-5 --bead "$bead" >"$W/spawn" 2>&1 9>&-; then
    n=$((n + 1))
    st --arg k "$key" '.routed[$k].dispatched = true' || die_state
    echo "route: dispatched $bead ($(tail -1 "$W/spawn"))"
  else
    echo "route: spawn for $bead failed: $(tail -1 "$W/spawn")" >&2; rc=1
    (cd "$dir" && bdx update "$bead" --remove-label dispatched >/dev/null 2>&1) \
      || st --arg k "$key" '.routed[$k].pending = ((.routed[$k].pending // []) + [{op:"unmark"}])' || die_state
  fi
done < <(jq -c '.dispatch[]' "$W/plan.json")

summary ""
exit $rc
