#!/usr/bin/env bash
# vercel-deploy.sh: publish a rig's default branch to Vercel production by API
# (hq-0hq6). Why by API: the orbit-acme team is Hobby and silently BLOCKS the
# git-triggered deploy of any commit authored by your-gh-user, so a merge to main
# never reaches production on its own; between 2026-10-09 and 2026-10-10 five
# merges sat unpublished. finish.sh calls this after a merge; it also runs by
# hand after a merge done outside finish.sh.
#
#   vercel-deploy.sh --rig R [--project P] [--dry-run] [--no-push] [--timeout S]
#   vercel-deploy.sh --check --rig R   validate only: exit 0 = configured and
#                                      valid, 3 = rig not in the map, 2 = map or
#                                      entry invalid (finish.sh decides with this,
#                                      so both scripts share ONE validation)
#
# What it does, in order: push the rig's default branch to origin and check the
# remote sha equals the local one (the API builds from GitHub, not from disk);
# then for each Vercel project of the rig (ops/config/vercel-deploy.json) create a
# production deployment from that ref, poll it to READY, and check the deployed
# sha is the one pushed. Any ERROR/CANCELED, timeout or sha mismatch exits 1
# with the project named; the merge is never undone here (that is the
# operator's call), it just stops being silent. --dry-run prints the plan and
# touches nothing. The token comes from Proton Pass at run time and is never
# printed or written to disk.
set -uo pipefail
HQ="${HQ_ROOT:-$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)}"
CONF="$HQ/ops/config/vercel-deploy.json"
export PATH="$HOME/.local/bin:$PATH"

rig=""; only=""; dry=0; push=1; timeout=600; check=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rig) rig="${2:-}"; shift;;
    --check) check=1;;
    --project) only="${2:-}"; shift;;
    --dry-run) dry=1;;
    --no-push) push=0;;
    --timeout) timeout="${2:-600}"; shift;;
    -h|--help) sed -n 2,19p "$0"; exit 0;;
    *) echo "vercel-deploy: unknown arg $1" >&2; exit 2;;
  esac; shift
done
[ -n "$rig" ] || { echo "vercel-deploy: --rig is required" >&2; exit 2; }
[ -f "$CONF" ] || { echo "vercel-deploy: missing $CONF" >&2; exit 2; }
# An unreadable map is an error, never "nothing to do" (lucy): a truncated file
# must not turn the deploy step off in silence.
# Exactly one JSON document and it is an object: an empty file or a bare
# scalar is a broken map, not "no rigs" (lucy, round 2).
jq -s -e 'length == 1 and (.[0] | type == "object")' "$CONF" >/dev/null 2>&1 \
  || { echo "vercel-deploy: FAIL $CONF is not a single JSON object" >&2; exit 2; }
if ! jq -e --arg r "$rig" 'has($r)' "$CONF" >/dev/null 2>&1; then
  echo "vercel-deploy: rig $rig has no Vercel projects in $CONF; nothing to do"
  [ "$check" = 1 ] && exit 3 || exit 0
fi
conf="$(jq -c --arg r "$rig" '.[$r]' "$CONF")"
jq -e '(type=="object") and (.team_id|type=="string") and (.repo_id|type=="number") and (.ref|type=="string") and (.projects|type=="array" and length>0 and all(type=="string")) and (.token.vault|type=="string") and (.token.item|type=="string") and (.token.field|type=="string")' <<<"$conf" >/dev/null 2>&1 \
  || { echo "vercel-deploy: FAIL entry for $rig in $CONF is incomplete (team_id, repo_id, ref, projects, token.{vault,item,field})" >&2; exit 2; }
# Decimal, positive: "08" would be read as octal by $(( )) and "00" is not positive.
case "$timeout" in ''|*[!0-9]*) echo "vercel-deploy: --timeout must be a positive integer of seconds" >&2; exit 2;; esac
timeout=$((10#$timeout)); [ "$timeout" -gt 0 ] || { echo "vercel-deploy: --timeout must be a positive integer of seconds" >&2; exit 2; }
if [ "$check" = 1 ]; then echo "vercel-deploy: $rig configured for $(jq -r '.projects | join(", ")' <<<"$conf")"; exit 0; fi

# rig "hq" is the hq repo itself (~/hq), not a directory under rigs/.
[ "$rig" = hq ] && RIGDIR="$HQ" || RIGDIR="$HQ/rigs/$rig"
[ -d "$RIGDIR/.git" ] || [ -f "$RIGDIR/.git" ] || { echo "vercel-deploy: no rig at $RIGDIR" >&2; exit 2; }
team="$(jq -r .team_id <<<"$conf")"; repo_id="$(jq -r .repo_id <<<"$conf")"; ref="$(jq -r .ref <<<"$conf")"
mapfile -t projects < <(jq -r '.projects[]' <<<"$conf")
if [ -n "$only" ]; then projects=("$only"); fi
local_sha="$(git -C "$RIGDIR" rev-parse "$ref" 2>/dev/null)" || { echo "vercel-deploy: $rig has no branch $ref" >&2; exit 2; }

echo "vercel-deploy: rig=$rig ref=$ref sha=${local_sha:0:7} projects=${projects[*]}"
if [ "$dry" = 1 ]; then
  echo "  plan: git push origin $ref; then POST /v13/deployments (target=production, gitSource github repoId=$repo_id ref=$ref) for each project; poll to READY (timeout ${timeout}s); check deployed sha == ${local_sha:0:7}"
  exit 0
fi

# 1. The remote must carry exactly what merged: the API builds from GitHub.
if [ "$push" = 1 ]; then
  if ! git -C "$RIGDIR" push -q origin "$ref" 2>&1 | grep -v '^$'; then :; fi
fi
git -C "$RIGDIR" fetch -q origin "$ref" 2>/dev/null || true
remote_sha="$(git -C "$RIGDIR" rev-parse "origin/$ref" 2>/dev/null)"
if [ "$remote_sha" != "$local_sha" ]; then
  echo "vercel-deploy: FAIL origin/$ref is ${remote_sha:0:7} but local $ref is ${local_sha:0:7}; push did not land, nothing deployed" >&2
  exit 1
fi

# 2. Token at run time, never echoed.
tv="$(jq -r .token.vault <<<"$conf")"; ti="$(jq -r .token.item <<<"$conf")"; tf="$(jq -r .token.field <<<"$conf")"
TOK="$(PROTON_PASS_AGENT_REASON="vercel-deploy.sh: publish $rig $ref ${local_sha:0:7} to Vercel production" pp item view --vault-name "$tv" --item-title "$ti" --field "$tf" 2>/dev/null)"
[ -n "$TOK" ] || { echo "vercel-deploy: FAIL could not read the Vercel token from Proton Pass ($ti)" >&2; exit 1; }
api() { curl -sS --max-time 60 -H "Authorization: Bearer $TOK" "$@"; }
# Production is published only when the deployment is READY, carries the
# pushed sha, and its aliases are assigned without error: READY alone is just a
# finished build (lucy). A real deadline bounds HTTP time as well as sleeps.

rc=0
for p in "${projects[@]}"; do
  body="$(jq -nc --arg p "$p" --arg ref "$ref" --argjson repo "$repo_id" \
    '{name: $p, project: $p, target: "production", gitSource: {type: "github", repoId: $repo, ref: $ref}}')"
  res="$(api -X POST -H 'Content-Type: application/json' "https://api.vercel.com/v13/deployments?teamId=$team" -d "$body")"
  dpl="$(jq -r '.id // empty' <<<"$res")"
  if [ -z "$dpl" ]; then
    echo "vercel-deploy: FAIL $p: create returned $(jq -r '.error.message // .error.code // "no id"' <<<"$res" | head -c 200)" >&2
    rc=1; continue
  fi
  echo "  $p: $dpl $(jq -r '.url' <<<"$res") created, waiting"
  state=""; d="{}"; t0=$SECONDS; deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    left=$((deadline - SECONDS)); [ "$left" -gt 60 ] && left=60
    d="$(curl -sS --max-time "$left" -H "Authorization: Bearer $TOK" "https://api.vercel.com/v13/deployments/$dpl?teamId=$team" 2>/dev/null || echo '{}')"
    state="$(jq -r '.readyState // ""' <<<"$d")"
    assigned="$(jq -r '.aliasAssigned // false' <<<"$d")"
    case "$state" in
      ERROR|CANCELED|BLOCKED) break;;
      READY) [ "$assigned" = true ] && break;;
    esac
    left=$((deadline - SECONDS)); [ "$left" -gt 10 ] && left=10
    [ "$left" -gt 0 ] && sleep "$left"
  done
  waited=$((SECONDS - t0))
  dsha="$(jq -r '.meta.githubCommitSha // ""' <<<"$d")"
  aliases="$(jq -r '[.alias[]?] | join(",")' <<<"$d")"
  alias_err="$(jq -r '.aliasError.message // .aliasError.code // ""' <<<"$d")"
  if [ "$state" = READY ] && [ "$dsha" = "$local_sha" ] && [ "$assigned" = true ] && [ -n "$aliases" ] && [ -z "$alias_err" ]; then
    echo "  $p: READY sha=${dsha:0:7} ${waited}s aliases=$aliases"
  elif [ "$state" = READY ] && [ "$dsha" != "$local_sha" ]; then
    echo "vercel-deploy: FAIL $p: READY but sha=${dsha:0:7}, expected ${local_sha:0:7}" >&2; rc=1
  elif [ "$state" = READY ]; then
    echo "vercel-deploy: FAIL $p: build READY but production alias not assigned (aliasAssigned=$assigned aliases='$aliases' aliasError='${alias_err:0:200}')" >&2; rc=1
  else
    echo "vercel-deploy: FAIL $p: state=${state:-no terminal state after ${waited}s} $(jq -r '.errorMessage // ""' <<<"$d" | head -c 200)" >&2; rc=1
  fi
done
[ "$rc" = 0 ] && echo "vercel-deploy: $rig ${local_sha:0:7} published to ${projects[*]}"
exit $rc
