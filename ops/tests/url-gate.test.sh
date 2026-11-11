#!/usr/bin/env bash
# Fixture tests for hook-url-verification-gate.sh.
#
# Ships WITH proposal 36. Move to ops/tests/url-gate.test.sh when the patch is
# applied; it fails on the unpatched hook, which is the point.
#
# The hook is a Stop gate: a turn that calls a controlled url live/ready without
# fetching it must not end. Between 2026-07-17 and 2026-09-01 it never fired for
# localhost, 127.0.0.1, 0.0.0.0 or any RFC1918 address, because its url pattern
# required at least one character between the scheme and the host token. These
# cases are exactly the ones that regressed, so they are the ones pinned here.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
GATE="$HQ/ops/scripts/hook-url-verification-gate.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

fail=0
ok() { printf 'ok   %s\n' "$1"; }
no() { printf 'FAIL %s (%s)\n' "$1" "${2:-}"; fail=1; }

# transcript <file> <claim-text> [fetch-command]
transcript() {
  TP="$1" CLAIM="$2" FETCH="${3:-}" python3 - <<'PY'
import json, os
rows = [{"type": "user", "message": {"role": "user", "content": "ship it"}}]
if os.environ.get("FETCH"):
    rows.append({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": os.environ["FETCH"]}}]}})
    rows.append({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "content": "200"}]}})
rows.append({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "text", "text": os.environ["CLAIM"]}]}})
with open(os.environ["TP"], "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

verdict() { # <transcript> -> prints the exit code
  printf '{"session_id":"t","cwd":"%s","transcript_path":"%s"}' "$HQ" "$1" \
    | bash "$GATE" >/dev/null 2>&1
  echo $?
}

GET="c""url -sS -o /dev/null -w '%{http_code}'"

# ---------- a bare claim about a controlled url must be blocked ----------
n=0
for u in "http://localhost:8787" "http://127.0.0.1:3000" "https://0.0.0.0:8080" \
         "http://192.168.1.50:5173" "http://10.0.0.4:9000" "http://172.16.3.2:80" \
         "http://localhost:8787/console" "https://demo.vercel.app"; do
  n=$((n + 1)); tp="$T/claim$n.jsonl"
  transcript "$tp" "Done. $u is live and ready."
  [ "$(verdict "$tp")" = 2 ] && ok "blocks an unverified claim about $u" \
    || no "blocks an unverified claim about $u" "gate let it through"
done

# ---------- the same claim with a real fetch behind it must pass ----------
n=0
for u in "http://localhost:8787" "http://127.0.0.1:3000" "https://demo.vercel.app"; do
  n=$((n + 1)); tp="$T/fetched$n.jsonl"
  transcript "$tp" "Done. $u is live and ready." "$GET $u"
  [ "$(verdict "$tp")" = 0 ] && ok "passes a fetched claim about $u" \
    || no "passes a fetched claim about $u" "gate blocked verified work"
done

# ---------- third-party urls are never gated ----------
tp="$T/thirdparty.jsonl"
transcript "$tp" "Done. https://github.com/your-gh-user/hq is live and ready."
[ "$(verdict "$tp")" = 0 ] && ok "third-party urls are not gated" \
  || no "third-party urls are not gated"

# ---------- a url with no live-claim phrasing is not gated ----------
tp="$T/mention.jsonl"
transcript "$tp" "The server config points at http://localhost:8787 by default."
[ "$(verdict "$tp")" = 0 ] && ok "a bare mention is not a claim" \
  || no "a bare mention is not a claim"

exit "$fail"
