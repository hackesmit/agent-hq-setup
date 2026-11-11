#!/usr/bin/env bash
# SessionStart hook: reconcile registry drift. That is now its whole job.
# It registers NOTHING: spawn.sh registers real workers, and subagents, headless jobs
# and other Claude sessions must not pollute the registry. Fail-open.
#
# Removed 2026-08-20 (bead hq-qph1): the self-registration branch for kind=overseer.
# HQ has not been a single-overseer system since 2026-07-14, there is no hq:overseer
# tmux window, and state/sessions.json holds no overseer entry, so the branch and its
# HQ_FORCE_OVERSEER=1 test seam were unreachable code that a future agent would read
# and believe. Nothing else changes: reconcile ran unconditionally before and still does.
DIR="$(cd "$(dirname "$0")" && pwd)"
REG="$DIR/session-registry.sh"

# always reconcile (prune active entries whose tmux window/pane died)
"$REG" reconcile >/dev/null 2>&1 || true
exit 0
