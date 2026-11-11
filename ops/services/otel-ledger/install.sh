#!/usr/bin/env bash
# Install the Claude usage ledger. Idempotent; run on hqbox as owner:
#
#   bash ~/hq/ops/services/otel-ledger/install.sh [--dry-run]
#
# 1. the otel-ledger user service (127.0.0.1:4318, db state/usage/claude-api.sqlite)
# 2. the OTel export env in ~/.claude/settings.json, so every Claude session on
#    this box (workers, console terminals, rig terminals) sends its api_request
#    events there. Only the keys in ENV are touched; the rest of the file stays.
# Revert: systemctl --user disable --now otel-ledger.service and
#   jq 'del(.env.CLAUDE_CODE_ENABLE_TELEMETRY, .env.OTEL_LOGS_EXPORTER, .env.OTEL_METRICS_EXPORTER,
#   .env.OTEL_EXPORTER_OTLP_PROTOCOL, .env.OTEL_EXPORTER_OTLP_ENDPOINT)' on the settings file.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="${HQ_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
ENV='{"CLAUDE_CODE_ENABLE_TELEMETRY":"1","OTEL_LOGS_EXPORTER":"otlp","OTEL_METRICS_EXPORTER":"none",
      "OTEL_EXPORTER_OTLP_PROTOCOL":"http/json","OTEL_EXPORTER_OTLP_ENDPOINT":"http://127.0.0.1:4318"}'
DRY=0; [ "${1:-}" = --dry-run ] && DRY=1

merge_env() {   # $1 = settings file; writes atomically, refuses a file that is not JSON
  local f="$1" tmp
  [ -f "$f" ] || echo '{}' > "$f"
  tmp="$(mktemp "$f.XXXXXX")"
  if ! jq --argjson e "$ENV" '.env = ((.env // {}) + $e)' "$f" > "$tmp"; then
    rm -f "$tmp"; echo "install: $f is not valid JSON, left alone" >&2; return 1
  fi
  chmod --reference="$f" "$tmp" 2>/dev/null || true
  mv "$tmp" "$f"
}

if [ "$DRY" = 1 ]; then
  echo "+ install $HERE/otel-ledger.service -> ~/.config/systemd/user/"
  echo "+ merge env into $SETTINGS: $(jq -c . <<<"$ENV")"
  exit 0
fi
[ "${HQ_OTEL_ENV_ONLY:-0}" = 1 ] && { merge_env "$SETTINGS"; exit 0; }   # the tests use this

install -D -m 644 "$HERE/otel-ledger.service" "$HOME/.config/systemd/user/otel-ledger.service"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user daemon-reload
systemctl --user enable --now otel-ledger.service
systemctl --user restart otel-ledger.service
merge_env "$SETTINGS"

systemctl --user is-active otel-ledger.service
jq -c '.env | with_entries(select(.key|test("OTEL|TELEMETRY")))' "$SETTINGS"
