#!/usr/bin/env bash
# pp — Proton Pass access for agents. Thin wrapper over `pass-cli` that keeps a persistent,
# logged-in session using the PAT stored in gitignored ops/.env (agents never need
# to `cat` ops/.env directly; this wrapper reads it internally).
# Agents just run:  pp vault list   |   pp item view --vault-name V --item-title T --field password
# Reason: `item view/create/update/trash`, `vault update` require a reason; we default one so
# calls never fail, but set PROTON_PASS_AGENT_REASON="<why>" for a meaningful audit trail.
set -uo pipefail
HQ="${HQ_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
export PROTON_PASS_SESSION_DIR="${PROTON_PASS_SESSION_DIR:-$HQ/state/pass-session}"
mkdir -p "$PROTON_PASS_SESSION_DIR"
export PROTON_PASS_AGENT_REASON="${PROTON_PASS_AGENT_REASON:-automated access via HQ pp wrapper}"

_pat(){ grep -E '^PROTON_PASS_PERSONAL_ACCESS_TOKEN=' "$HQ/ops/.env" 2>/dev/null | head -1 | cut -d= -f2-; }

ensure_login(){
  pass-cli info >/dev/null 2>&1 && return 0          # session still valid → reuse it
  local tok; tok="$(_pat)"
  [ -n "$tok" ] || { echo "pp: no PROTON_PASS_PERSONAL_ACCESS_TOKEN in ops/.env" >&2; return 1; }
  pass-cli logout --force >/dev/null 2>&1 || true    # clear any stale session
  PROTON_PASS_PERSONAL_ACCESS_TOKEN="$tok" pass-cli login >/dev/null 2>&1 \
    || { echo "pp: login failed (PAT rejected or network) — try: pp-login" >&2; return 1; }
}

# `pp-login` / `pp login` forces a fresh login; otherwise just ensure a session then pass through.
if [ "${1:-}" = "login" ] || [ "${1:-}" = "relogin" ]; then
  pass-cli logout --force >/dev/null 2>&1 || true
  tok="$(_pat)"; PROTON_PASS_PERSONAL_ACCESS_TOKEN="$tok" exec pass-cli login
fi

ensure_login || exit 1
exec pass-cli "$@"
