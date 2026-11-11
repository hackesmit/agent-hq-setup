#!/usr/bin/env bash
# Fixture cases for hook-orchestrator-delegate.sh (hq-4npjr.26): with
# HQ_CONSOLE_ROLE=orchestrator, inline work is denied (exit 2) and bookkeeping
# passes; without it every tool passes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hook-orchestrator-delegate.sh"
ROOT="$(cd "$HERE/../../.." && pwd)"
fails=0
run() { # role expect json
  local role="$1" want="$2" json="$3" got
  printf '%s' "$json" | env -u HQ_CONSOLE_ROLE ${role:+HQ_CONSOLE_ROLE=$role} bash "$HOOK" >/dev/null 2>"$ERR"
  got=$?
  if [ "$got" != "$want" ]; then echo "FAIL (want $want got $got, role=${role:-none}): $json"; fails=$((fails+1)); fi
}
ERR="$(mktemp)"; trap 'rm -f "$ERR"' EXIT
O=orchestrator
run $O 2 '{"tool_name":"WebSearch","tool_input":{"query":"media server"}}'
grep -q "spawn.sh" "$ERR" || { echo "FAIL: deny reason does not name spawn.sh"; fails=$((fails+1)); }
run $O 2 '{"tool_name":"WebFetch","tool_input":{"url":"https://x.test"}}'
run $O 2 '{"tool_name":"Artifact","tool_input":{}}'
run $O 2 '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/tmp/a.ipynb"}}'
run $O 2 "{\"tool_name\":\"Write\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"$ROOT/rigs/x/index.html\",\"content\":\"x\"}}"
run $O 2 "{\"tool_name\":\"Edit\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"rigs/x/a.js\"}}"
run $O 2 "{\"tool_name\":\"Write\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"$ROOT/state/../ops/scripts/x.sh\"}}"
run $O 2 "{\"tool_name\":\"Write\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"$ROOT/CLAUDE.md\"}}"
run $O 0 "{\"tool_name\":\"Write\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"$ROOT/state/orchestrator/chat-notes.md\",\"content\":\"x\"}}"
run $O 0 "{\"tool_name\":\"Edit\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"state/orchestrator/chat-notes.md\"}}"
run $O 0 "{\"tool_name\":\"Edit\",\"cwd\":\"$ROOT\",\"tool_input\":{\"file_path\":\"$ROOT/ops/reference/owner-facts.md\"}}"
run $O 0 '{"tool_name":"Write","tool_input":{"file_path":"/tmp/claude-1000/abc/scratchpad/n.md"}}'
run $O 0 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$HOME/.claude/projects/-home-owner-hq/memory/x.md\"}}"
run $O 0 '{"tool_name":"Agent","tool_input":{"prompt":"x","run_in_background":true}}'
run $O 2 '{"tool_name":"Agent","tool_input":{"prompt":"x","run_in_background":false}}'
run $O 2 '{"tool_name":"Agent","tool_input":{"prompt":"x"}}'
run $O 2 '{"tool_name":"Task","tool_input":{"prompt":"x"}}'
run $O 0 '{"tool_name":"Bash","tool_input":{"command":"bd ready"}}'
run $O 0 '{"tool_name":"Read","tool_input":{"file_path":"/etc/hosts"}}'
run $O 0 'not json'
run "" 0 '{"tool_name":"WebSearch","tool_input":{"query":"x"}}'
run "" 0 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$ROOT/rigs/x/index.html\"}}"
run "" 0 '{"tool_name":"Agent","tool_input":{"prompt":"x"}}'
run worker 0 '{"tool_name":"WebSearch","tool_input":{"query":"x"}}'
[ "$fails" = 0 ] && echo PASS || { echo "$fails failed"; exit 1; }
