#!/usr/bin/env bash
# Fixture test for audit-sweep.sh selection.
# Destination: ops/scripts/tests/audit-sweep.test.sh (the path resolution below works
# from either location, since it only looks one directory up for the script).
#
# Drives audit_select directly with a synthetic bead list on stdin: no bd, no ledger, no
# network, nothing closed. Six cases, exactly two of which must be selected.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$DIR/../audit-sweep.sh"
[ -f "$SUT" ] || { echo "FAIL: cannot find audit-sweep.sh at $SUT"; exit 1; }
# shellcheck source=/dev/null
source "$SUT"

FAILURES=0
check() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    echo "ok   $label"
  else
    echo "FAIL $label"
    echo "     want: $want"
    echo "     got:  $got"
    FAILURES=$((FAILURES + 1))
  fi
}

# Six synthetic beads, timestamped relative to a fixed AUDIT_NOW so the fixture never
# goes stale: fresh egress, old egress still granted, old egress revoked, old
# session-eval PASS, old session-eval ESCALATE, old egress with a comment from the owner.
FIXTURE="$(python3 - <<'PY'
import json, datetime
now = datetime.datetime(2026, 9, 6, 12, 0, 0, tzinfo=datetime.timezone.utc)
def ago(days):
    return (now - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")

def egress(bid, host, days, **extra):
    b = {"id": bid, "title": "Acquisition: domain %s" % host,
         "description": ("What: domain (%s)\nWhy: contacted by Bash\n"
                         "Revert: remove '%s' from .claude/settings.local.json allowedDomains"
                         % (host, host)),
         "status": "open", "priority": 2, "issue_type": "task",
         "created_at": ago(days), "updated_at": ago(days),
         "labels": ["acquisition", "egress-ledger"],
         "dependency_count": 0, "dependent_count": 0, "comment_count": 0}
    b.update(extra)
    return b

def evaluation(bid, verdict, days, **extra):
    b = {"id": bid, "title": "session-eval %s: abc12345" % verdict,
         "description": "Verdict: %s (confidence 0.8)\nSummary: synthetic\n" % verdict,
         "status": "open", "priority": 1 if verdict == "ESCALATE" else 2,
         "issue_type": "task", "created_at": ago(days), "updated_at": ago(days),
         "labels": ["session-eval", verdict, "P1" if verdict == "ESCALATE" else "P2"],
         "dependency_count": 0, "dependent_count": 0, "comment_count": 0}
    b.update(extra)
    return b

beads = [
    egress("eg-fresh", "fresh.example.com", 2),
    egress("eg-old-granted", "granted.example.com", 40),
    egress("eg-old-revoked", "revoked.invalid", 40),
    evaluation("se-old-pass", "PASS", 40),
    evaluation("se-old-escalate", "ESCALATE", 40),
    egress("eg-old-commented", "granted.example.com", 40, comment_count=1),
]
print(json.dumps(beads))
PY
)"

export AUDIT_NOW="2026-09-06T12:00:00Z"
export AUDIT_MAX_AGE_DAYS=14
export AUDIT_GRANTS_FOUND=1
export AUDIT_GRANTED="granted.example.com
fresh.example.com"

PLAN="$(printf '%s' "$FIXTURE" | audit_select)"
rc=$?
check "audit_select exits 0" "0" "$rc"

records="$(printf '%s\n' "$PLAN" | grep -c . )" || true
check "one record per bead" "6" "$records"

selected="$(printf '%s\n' "$PLAN" | jq -r 'select(.select) | .id' | sort | paste -sd, -)"
check "exactly the two closable beads are selected" "eg-old-granted,se-old-pass" "$selected"

reason_for() { printf '%s\n' "$PLAN" | jq -r --arg i "$1" 'select(.id == $i) | .reason'; }
category_for() { printf '%s\n' "$PLAN" | jq -r --arg i "$1" 'select(.id == $i) | .category'; }

check "fresh egress held for age" \
  "yes" "$(case "$(reason_for eg-fresh)" in *"under the 14 day cutoff"*) echo yes;; *) echo "no: $(reason_for eg-fresh)";; esac)"
check "revoked domain held for the grant check" \
  "yes" "$(case "$(reason_for eg-old-revoked)" in *"no longer granted"*) echo yes;; *) echo "no: $(reason_for eg-old-revoked)";; esac)"
check "ESCALATE is never swept" \
  "yes" "$(case "$(reason_for se-old-escalate)" in *"ESCALATE"*) echo yes;; *) echo "no: $(reason_for se-old-escalate)";; esac)"
check "a commented bead is left to the human" \
  "yes" "$(case "$(reason_for eg-old-commented)" in *"carries a comment"*) echo yes;; *) echo "no: $(reason_for eg-old-commented)";; esac)"
check "granted egress reason names the rule" \
  "kept at retro, domain still granted" "$(reason_for eg-old-granted)"
check "session-eval reason names the verdict" \
  "reviewed at retro, verdict PASS with no open follow-up" "$(reason_for se-old-pass)"
check "categories are labelled" "egress-ledger session-eval" \
  "$(category_for eg-old-granted) $(category_for se-old-pass)"

# --close-revoked (AUDIT_CLOSE_REVOKED=1) is off by default: the two checks above already
# prove the revoked bead is held when it is unset. With it on, that bead joins the plan
# with the revoked reason, and nothing else about the plan moves.
revoked_plan="$(printf '%s' "$FIXTURE" | AUDIT_CLOSE_REVOKED=1 audit_select)"
check "close-revoked adds the revoked bead and nothing else" \
  "eg-old-granted,eg-old-revoked,se-old-pass" \
  "$(printf '%s\n' "$revoked_plan" | jq -r 'select(.select) | .id' | sort | paste -sd, -)"
check "close-revoked reason names the rule" \
  "grant gone; revert or re-request at the retro" \
  "$(printf '%s\n' "$revoked_plan" | jq -r 'select(.id == "eg-old-revoked") | .reason')"
check "close-revoked does not sweep the fresh bead" "" \
  "$(printf '%s\n' "$revoked_plan" | jq -r 'select(.select and .id == "eg-fresh") | .id')"
check "close-revoked does not sweep ESCALATE" "" \
  "$(printf '%s\n' "$revoked_plan" | jq -r 'select(.select and .id == "se-old-escalate") | .id')"
check "close-revoked does not sweep a commented bead" "" \
  "$(printf '%s\n' "$revoked_plan" | jq -r 'select(.select and .id == "eg-old-commented") | .id')"
check "the flag is off unless asked for" \
  "eg-old-granted,se-old-pass" \
  "$(printf '%s' "$FIXTURE" | audit_select | jq -r 'select(.select) | .id' | sort | paste -sd, -)"

# The no-grant-source fail safe outranks the flag: with nothing to verify against, every
# domain would look revoked, so no egress bead is selected even with --close-revoked.
nogrant_revoked="$(printf '%s' "$FIXTURE" | AUDIT_GRANTED="" AUDIT_GRANTS_FOUND=0 \
  AUDIT_CLOSE_REVOKED=1 audit_select | jq -r 'select(.select) | .id' | sort | paste -sd, -)"
check "no grant source outranks close-revoked" "se-old-pass" "$nogrant_revoked"

# A dependency edge means a follow-up exists: never swept.
DEP="$(printf '%s' "$FIXTURE" | jq -c '[.[] | select(.id == "eg-old-granted") | .dependent_count = 1]')"
dep_selected="$(printf '%s' "$DEP" | audit_select | jq -r 'select(.select) | .id' | paste -sd, -)"
check "a dependency edge blocks selection" "" "$dep_selected"

# With no readable grant source, no egress bead may be closed; session-eval is unaffected.
nogrant="$(printf '%s' "$FIXTURE" | AUDIT_GRANTED="" AUDIT_GRANTS_FOUND=0 audit_select \
  | jq -r 'select(.select) | .id' | sort | paste -sd, -)"
check "no grant source closes no egress bead" "se-old-pass" "$nogrant"

# An in_progress or already closed bead is out of scope.
CLOSED="$(printf '%s' "$FIXTURE" | jq -c '[.[] | select(.id == "se-old-pass") | .status = "closed"]')"
closed_selected="$(printf '%s' "$CLOSED" | audit_select | jq -r 'select(.select) | .id' | paste -sd, -)"
check "a non-open bead is skipped" "" "$closed_selected"

# Beads carrying neither audit label are ignored outright.
OTHER='[{"id":"x1","title":"real work","status":"open","created_at":"2026-01-01T00:00:00Z","labels":["automation"],"comment_count":0,"dependency_count":0,"dependent_count":0}]'
other_reason="$(printf '%s' "$OTHER" | audit_select | jq -r '.reason')"
check "a normal bead is never a candidate" "not an audit bead" "$other_reason"

if [ "$FAILURES" -eq 0 ]; then
  echo "audit-sweep.test.sh: all checks passed"
  exit 0
fi
echo "audit-sweep.test.sh: $FAILURES check(s) failed"
exit 1
