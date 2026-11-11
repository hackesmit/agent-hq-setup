#!/usr/bin/env bash
# vault.sh <rig> "<text>" [--tag pattern|gotcha|command|decision|howto|glossary|note]
# Add reusable project knowledge to the rig's vault Knowledge base. Agents call this
# WHENEVER they learn something a future agent would want — a gotcha, a pattern, a useful
# command, an architecture insight — so the project's knowledge compounds. It writes to the
# outbox; the git-sync daemon merges it into the real Obsidian
# vault within ~45s. Read the same note first: outbox/vault/01 Projects/<rig>/Knowledge.md
# → 01 Projects/<rig>/Knowledge.md in the vault.
#   <rig> = a rig name, or "." to infer it from the current directory.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
die(){ echo "vault: $1" >&2; exit "${2:-1}"; }

rig="${1:-}"; shift 2>/dev/null || true
text=""; tag="note"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:-note}"; shift;;
    --*) die "unknown arg: $1" 2;;
    *) [ -z "$text" ] && text="$1";;
  esac; shift
done
# infer rig from cwd when asked
if [ "$rig" = "." ]; then
  top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  rig="$(basename "$top" | sed -E 's/-[0-9a-f]{4}$//')"   # strip a -<hex4> worktree suffix
fi
[ -n "$rig" ] && [ -n "$text" ] || die "usage: vault.sh <rig|.> \"<text>\" [--tag pattern|gotcha|command|decision|howto|glossary]" 2

who="${CDP_TERMINAL_ID:-${CLAUDE_SESSION_ID:-session}}"
note="$HQ/outbox/vault/01 Projects/$rig/Knowledge.md"
mkdir -p "$(dirname "$note")"
if [ ! -f "$note" ]; then
  {
    printf '# %s — Knowledge base\n\n' "$rig"
    printf 'Reusable notes agents accumulate as they work this project. **Read this first**; add to it as you learn.\n'
    printf 'Tags for search: `#pattern` `#gotcha` `#command` `#decision` `#howto` `#glossary`\n\n'
    printf '## Notes\n'
  } > "$note"
fi
printf -- '- %s #%s (%s) — %s\n' "$(date -u +%Y-%m-%d)" "$tag" "$who" "$text" >> "$note"
echo "noted to $rig KB (#$tag) — syncs to the vault within ~45s"
