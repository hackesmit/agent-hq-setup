#!/usr/bin/env bash
# audit-sweep.sh - close the audit beads the retro has already reviewed.
# Destination: ops/scripts/audit-sweep.sh (first staged in ops/proposals/42-audit-bead-sweep/).
#
# Two bead families are filed automatically and are explicitly NOT dispatchable work
# (CLAUDE.md, Ledger section): "egress-ledger" domain acquisitions filed by
# hook-egress-ledger.sh, and "session-eval" verdicts filed by session-eval-run.sh.
# CLAUDE.md says both are reviewed keep-or-revert at the weekly retro, but nothing ever
# closed them, so the open count lies and every ledger read pays for them. On 2026-09-06
# that was 818 of the hq ledger's 1004 open beads (793 egress, 25 session-eval).
#
# DRY RUN BY DEFAULT: it prints the plan and touches nothing. "--apply" is the only path
# that ever calls "bd close", and it closes in batches of 50 with one line per batch.
#
# Never touched:
#   - anything younger than the age cutoff (14 days by default)
#   - anything whose status is not "open"
#   - anything carrying a comment (a human annotated it, so a human decides)
#   - anything with a dependency edge in either direction (a follow-up exists)
#   - an egress bead whose domain is no longer granted in settings, unless
#     --close-revoked says otherwise: without the flag that bead is a live revert
#     decision, with it the revert is read as already in effect
#   - any egress bead at all when no settings file could be read (fail safe: with no
#     grant source there is nothing to verify against, and --close-revoked does not
#     override that, since every domain would look revoked)
#   - a session-eval ESCALATE, ever
#
# Usage:
#   audit-sweep.sh                    dry run, human summary
#   audit-sweep.sh --json             dry run, one JSON record per bead on stdout
#   audit-sweep.sh --days 30          different age cutoff
#   audit-sweep.sh --settings PATH    extra grant source, repeatable
#   audit-sweep.sh --close-revoked    also close aged egress beads whose domain is gone
#   audit-sweep.sh --apply            actually closes, in batches of 50
#
# Selection lives in audit_select, which reads a JSON array of beads on stdin and writes
# one JSON record per bead on stdout ({id, title, category, select, reason}). It calls
# nothing else, so the fixture test drives it directly with no bd and no ledger.
set -uo pipefail

AUDIT_BATCH="${AUDIT_BATCH:-50}"
AUDIT_CLOSED=0
AUDIT_FAILED=0

audit_hq_roots() {
  # Every checkout root worth reading settings from: the one holding this script, and,
  # when that is a git worktree, the main checkout too (settings.local.json is
  # gitignored, so a worktree carries no copy of the grant list).
  local dir root common
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$dir"
  while [ "$root" != "/" ] && [ ! -f "$root/.claude/settings.json" ]; do
    root="$(dirname "$root")"
  done
  [ "$root" = "/" ] && return 0
  printf '%s\n' "$root"
  if [ -f "$root/.git" ]; then
    common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
    if [ -n "$common" ]; then
      common="$(dirname "$common")"
      if [ "$common" != "$root" ] && [ -d "$common/.claude" ]; then
        printf '%s\n' "$common"
      fi
    fi
  fi
  return 0
}

audit_granted_domains() {
  # One granted domain per line, read-only, from every settings file given. A missing or
  # unparsable file contributes nothing and is not an error.
  python3 - "$@" <<'PY'
import json, sys
out = []
for path in sys.argv[1:]:
    try:
        cfg = json.load(open(path))
    except Exception:
        continue
    net = ((cfg.get("sandbox") or {}).get("network") or {})
    for d in (net.get("allowedDomains") or []):
        d = str(d).strip().lower().lstrip("*.")
        if d:
            out.append(d)
print("\n".join(sorted(set(out))))
PY
}

# The selection program, kept in a variable and run with python3 -c so that stdin
# stays free for the bead JSON (a python3 heredoc would eat it).
read -r -d '' AUDIT_SELECT_PY <<'PY' || true
import json, os, re, sys, datetime

UTC = datetime.timezone.utc

def parse_ts(s):
    if not s:
        return None
    s = str(s).strip().replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(s)
    except Exception:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)

now = parse_ts(os.environ.get("AUDIT_NOW", "")) or datetime.datetime.now(UTC)
try:
    max_age = float(os.environ.get("AUDIT_MAX_AGE_DAYS") or 14)
except ValueError:
    max_age = 14.0
granted = {l.strip().lower() for l in os.environ.get("AUDIT_GRANTED", "").splitlines() if l.strip()}
grants_found = os.environ.get("AUDIT_GRANTS_FOUND", "1") != "0"
close_revoked = os.environ.get("AUDIT_CLOSE_REVOKED", "0") == "1"

TITLE_DOMAIN = re.compile(r"^acquisition:\s*domain\s+(\S+)", re.I)
DESC_DOMAIN = re.compile(r"what:\s*domain\s*\(([^)]+)\)", re.I)
TITLE_VERDICT = re.compile(r"session-eval\s+([A-Za-z]+)", re.I)
DESC_VERDICT = re.compile(r"^\s*verdict:\s*([A-Za-z]+)", re.I | re.M)
VERDICTS = ("PASS", "FLAG", "ESCALATE")

def covered(host):
    # the host itself or any parent domain is granted; a bare TLD never counts
    parts = host.split(".")
    return any(".".join(parts[i:]) in granted for i in range(max(1, len(parts) - 1)))

def domain_of(bead):
    m = TITLE_DOMAIN.search(str(bead.get("title") or ""))
    if not m:
        m = DESC_DOMAIN.search(str(bead.get("description") or ""))
    if not m:
        return ""
    return m.group(1).strip().strip("'\"").lower().rstrip(".")

def verdict_of(bead):
    labels = {str(l).strip().upper() for l in (bead.get("labels") or [])}
    for v in VERDICTS:
        if v in labels:
            return v
    for rx, field in ((TITLE_VERDICT, "title"), (DESC_VERDICT, "description")):
        m = rx.search(str(bead.get(field) or ""))
        if m and m.group(1).upper() in VERDICTS:
            return m.group(1).upper()
    return ""

def has_comments(bead):
    if bead.get("comments"):
        return True
    try:
        return int(bead.get("comment_count") or 0) > 0
    except (TypeError, ValueError):
        return False

def edge_count(bead):
    total = 0
    for key in ("dependency_count", "dependent_count"):
        try:
            total += int(bead.get(key) or 0)
        except (TypeError, ValueError):
            pass
    return total

def decide(bead):
    labels = {str(l).strip().lower() for l in (bead.get("labels") or [])}
    if "egress-ledger" in labels:
        category = "egress-ledger"
    elif "session-eval" in labels:
        category = "session-eval"
    else:
        return "other", False, "not an audit bead"

    status = str(bead.get("status") or "").lower()
    if status != "open":
        return category, False, "status is %s, not open" % (status or "unknown")
    if has_comments(bead):
        return category, False, "carries a comment, a human annotated it"
    if edge_count(bead):
        return category, False, "has a dependency edge, a follow-up exists"

    created = parse_ts(bead.get("created_at"))
    if created is None:
        return category, False, "created_at is missing or unparsable"
    age = (now - created).total_seconds() / 86400.0
    if age < max_age:
        return category, False, "age %.1f days is under the %.0f day cutoff" % (age, max_age)

    if category == "egress-ledger":
        if not grants_found:
            return category, False, "no readable grant source, cannot verify the domain"
        host = domain_of(bead)
        if not host:
            return category, False, "no domain found in title or description"
        if not covered(host):
            if close_revoked:
                return category, True, "grant gone; revert or re-request at the retro"
            return category, False, "domain %s is no longer granted, needs a revert decision" % host
        return category, True, "kept at retro, domain still granted"

    verdict = verdict_of(bead)
    if verdict == "ESCALATE":
        return category, False, "verdict ESCALATE, never swept"
    if verdict not in ("PASS", "FLAG"):
        return category, False, "verdict could not be read"
    return category, True, "reviewed at retro, verdict %s with no open follow-up" % verdict

try:
    data = json.load(sys.stdin)
except Exception as exc:
    sys.stderr.write("audit-sweep: could not parse bead JSON on stdin: %s\n" % exc)
    sys.exit(2)
if isinstance(data, dict):
    data = data.get("issues") or data.get("beads") or []
if not isinstance(data, list):
    sys.stderr.write("audit-sweep: expected a JSON array of beads on stdin\n")
    sys.exit(2)

for bead in data:
    if not isinstance(bead, dict):
        continue
    category, ok, reason = decide(bead)
    print(json.dumps({"id": bead.get("id"), "title": bead.get("title"),
                      "category": category, "select": bool(ok), "reason": reason},
                     ensure_ascii=False))
PY

audit_select() {
  # stdin: JSON array of bead records (the shape bd list --json emits).
  # stdout: one JSON record per bead, {id, title, category, select, reason}.
  # Environment: AUDIT_NOW (ISO 8601, default now), AUDIT_MAX_AGE_DAYS (default 14),
  # AUDIT_GRANTED (newline separated domains), AUDIT_GRANTS_FOUND (0 disables egress),
  # AUDIT_CLOSE_REVOKED (1 also selects aged egress beads whose domain is gone).
  python3 -c "$AUDIT_SELECT_PY"
}

audit_collect() {
  # Every open bead carrying either audit label, deduped by id.
  local eg se
  eg="$(bd list --json --status open --limit 0 -l egress-ledger 2>/dev/null)" || eg=""
  se="$(bd list --json --status open --limit 0 -l session-eval 2>/dev/null)" || se=""
  [ -n "$eg" ] || eg="[]"
  [ -n "$se" ] || se="[]"
  printf '%s\n%s\n' "$eg" "$se" | jq -s 'map(select(type == "array")) | add | unique_by(.id)'
}

_audit_close_chunk() {
  local reason="$1"; shift
  local n=$#
  if bd close "$@" -r "$reason" >/dev/null 2>&1; then
    echo "audit-sweep: closed $n ($reason)"
    AUDIT_CLOSED=$((AUDIT_CLOSED + n))
    return 0
  fi
  echo "audit-sweep: FAILED to close a batch of $n ($reason)" >&2
  AUDIT_FAILED=$((AUDIT_FAILED + 1))
  return 1
}

audit_close_batches() {
  # stdin: the selected JSONL records. Groups by reason so one --reason covers a batch,
  # then closes AUDIT_BATCH ids at a time. The ONLY caller of bd close in this file.
  local plan reasons reason ids id
  local -a chunk=()
  plan="$(cat)"
  reasons="$(printf '%s\n' "$plan" | jq -r '.reason' | sort -u)"
  while IFS= read -r reason; do
    [ -n "$reason" ] || continue
    ids="$(printf '%s\n' "$plan" | jq -r --arg r "$reason" 'select(.reason == $r) | .id')"
    chunk=()
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      chunk+=("$id")
      if [ "${#chunk[@]}" -ge "$AUDIT_BATCH" ]; then
        _audit_close_chunk "$reason" "${chunk[@]}"
        chunk=()
      fi
    done <<< "$ids"
    if [ "${#chunk[@]}" -gt 0 ]; then
      _audit_close_chunk "$reason" "${chunk[@]}"
    fi
  done <<< "$reasons"
  echo "audit-sweep: closed $AUDIT_CLOSED bead(s) in total, $AUDIT_FAILED batch failure(s)"
  [ "$AUDIT_FAILED" -eq 0 ]
}

audit_usage() {
  sed -n '/^# Usage:/,/^# Selection lives/p' "${BASH_SOURCE[0]}" | sed '$d'
}

audit_main() {
  local apply=0 json_out=0 revoked=0 days="${AUDIT_MAX_AGE_DAYS:-14}"
  local -a sources=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --apply) apply=1 ;;
      --json) json_out=1 ;;
      --close-revoked) revoked=1 ;;
      --days) days="${2:-14}"; shift ;;
      --settings) [ -n "${2:-}" ] && sources+=("$2"); shift ;;
      -h|--help) audit_usage; return 0 ;;
      *) echo "audit-sweep: unknown argument $1" >&2; return 64 ;;
    esac
    shift
  done

  if [ "${#sources[@]}" -eq 0 ]; then
    local root
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      sources+=("$root/.claude/settings.json" "$root/.claude/settings.local.json")
    done < <(audit_hq_roots)
  fi

  local granted grants_found=1 ndom
  if [ "${#sources[@]}" -gt 0 ]; then
    granted="$(audit_granted_domains "${sources[@]}")"
  else
    granted=""
  fi
  [ -n "$granted" ] || grants_found=0
  ndom="$(printf '%s\n' "$granted" | grep -c . )" || true

  local beads plan rc
  beads="$(audit_collect)"
  plan="$(printf '%s' "$beads" | AUDIT_MAX_AGE_DAYS="$days" AUDIT_GRANTED="$granted" \
    AUDIT_GRANTS_FOUND="$grants_found" AUDIT_CLOSE_REVOKED="$revoked" audit_select)"
  rc=$?
  [ $rc -eq 0 ] || return $rc

  if [ "$json_out" -eq 1 ]; then
    printf '%s\n' "$plan"
    return 0
  fi

  local scanned selected eg se
  scanned="$(printf '%s\n' "$plan" | grep -c . )" || true
  selected="$(printf '%s\n' "$plan" | jq -r 'select(.select) | .id' | grep -c . )" || true
  eg="$(printf '%s\n' "$plan" | jq -r 'select(.select and .category == "egress-ledger") | .id' | grep -c . )" || true
  se="$(printf '%s\n' "$plan" | jq -r 'select(.select and .category == "session-eval") | .id' | grep -c . )" || true

  local revoked_note="off"
  [ "$revoked" -eq 1 ] && revoked_note="on"
  echo "audit-sweep: scanned $scanned open audit beads, age cutoff $days days"
  echo "  grant sources: ${#sources[@]} settings path(s), $ndom domains granted"
  echo "  close-revoked: $revoked_note"
  echo "  closable egress-ledger: $eg"
  echo "  closable session-eval:  $se"
  echo "  closable total:         $selected"
  echo "  held back:"
  printf '%s\n' "$plan" | jq -r 'select(.select | not) | .reason' \
    | sed -E 's/domain [^ ]+ is no longer granted/domain no longer granted/; s/age [0-9.]+ days is under/age is under/' \
    | sort | uniq -c | sort -rn | sed 's/^/    /'

  if [ "$apply" -eq 0 ]; then
    echo "DRY RUN, nothing closed. Re-run with --apply to close $selected bead(s)."
    return 0
  fi
  if [ "$selected" -eq 0 ]; then
    echo "audit-sweep: nothing to close"
    return 0
  fi
  printf '%s\n' "$plan" | jq -c 'select(.select)' | audit_close_batches
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  audit_main "$@"
fi
