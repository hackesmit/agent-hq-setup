#!/usr/bin/env bash
# gworkspace MCP launcher. Pulls the Google OAuth client from Proton Pass at spawn time and
# execs the pinned server on stdio. No secret ever touches a file or a command line: both
# values travel as environment variables into the child process only.
#
# Proton Pass item: API-credential item "Google mcp oauth" in vault
# "Imported on 2026-07-13 at 14.56.53"; field "API Key" = OAuth client id, "Secret" = client secret.
# Scope knobs (override via env before spawn):
#   GWORKSPACE_TIER   core|extended|complete            (default core)
#   GWORKSPACE_TOOLS  space-separated services           (default: gmail drive calendar docs sheets)
#   GWORKSPACE_READ_ONLY=1  request read-only scopes only
set -uo pipefail
HQ="${HQ_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PP="$HQ/ops/scripts/pp.sh"
VAULT="${GWORKSPACE_PP_VAULT:-Imported on 2026-07-13 at 14.56.53}"
ITEM="${GWORKSPACE_PP_ITEM:-Google mcp oauth}"
export PROTON_PASS_AGENT_REASON="gworkspace MCP spawn: Google OAuth client for workspace-mcp"

cid="$("$PP" item view --vault-name "$VAULT" --item-title "$ITEM" --field "API Key" 2>/dev/null)"
csec="$("$PP" item view --vault-name "$VAULT" --item-title "$ITEM" --field "Secret" 2>/dev/null)"
if [ -z "$cid" ] || [ -z "$csec" ]; then
  echo "gworkspace-launch: Proton Pass item '$ITEM' in vault '$VAULT' missing or empty (need fields 'API Key'=client id, 'Secret'=client secret)" >&2
  exit 1
fi

export GOOGLE_OAUTH_CLIENT_ID="$cid" GOOGLE_OAUTH_CLIENT_SECRET="$csec"
export USER_GOOGLE_EMAIL="${USER_GOOGLE_EMAIL:-owner@example.com}"
export WORKSPACE_MCP_CREDENTIALS_DIR="${WORKSPACE_MCP_CREDENTIALS_DIR:-$HOME/.google_workspace_mcp/credentials}"
export WORKSPACE_MCP_ATTACHMENT_DIR="${WORKSPACE_ATTACHMENT_DIR:-/tmp/hq-gworkspace-attachments}"
unset cid csec

args=(--tool-tier "${GWORKSPACE_TIER:-core}" --single-user)
# shellcheck disable=SC2206
tools=(${GWORKSPACE_TOOLS:-gmail drive calendar docs sheets})
args+=(--tools "${tools[@]}")
[ "${GWORKSPACE_READ_ONLY:-0}" = "1" ] && args+=(--read-only)

exec uvx "workspace-mcp==1.24.1" "${args[@]}"
