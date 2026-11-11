#!/usr/bin/env bash
# claude-md-shrink.test.sh (hq-pgbpq.9): proves the CLAUDE.md shrink lost no rule.
#
# Static (default): CLAUDE.md is under 20000 bytes; every rule unit of the old
# CLAUDE.md (pinned commit) is either still present verbatim, mapped to a home
# with an anchor that home contains (docs/plans/claude-md-shrink.rules.tsv), or
# marked trimmed/superseded with a reason; every rule file is path-scoped; the
# Rigs table matches the per-rig rule files; drift-check claims still match.
# --live: also runs two short Haiku sessions in a throwaway tree with an
# InstructionsLoaded hook and checks each rule file loads on its paths, never
# at session start, and that a nested rig worktree gets only its rig's notes.
#
# Run: bash ops/scripts/tests/claude-md-shrink.test.sh [--live]   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$HERE/claude_md_shrink.py" "$@"
