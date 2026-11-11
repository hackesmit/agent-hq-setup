#!/usr/bin/env bash
# Fixture tests for S5 compact hooks — precompact snapshot + postcompact reinject.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PRE="$DIR/../scripts/hook-precompact-snapshot.sh"
POST="$DIR/../scripts/hook-postcompact-reinject.sh"
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

export HQ_ROOT="$(mktemp -d)"
export HQ_STATE_DIR="$HQ_ROOT/state"
export CLAUDE_PROJECT_DIR="$HQ_ROOT"
trap 'rm -rf "$HQ_ROOT"' EXIT
mkdir -p "$HQ_ROOT/ops/scripts" "$HQ_ROOT/state/objectives"
# the hooks resolve session-registry.sh from their OWN dir; point CLAUDE_PROJECT_DIR at temp HQ
cp "$REGSH" "$HQ_ROOT/ops/scripts/session-registry.sh"
PRE_T="$HQ_ROOT/ops/scripts/hook-precompact-snapshot.sh"; cp "$PRE" "$PRE_T"
POST_T="$HQ_ROOT/ops/scripts/hook-postcompact-reinject.sh"; cp "$POST" "$POST_T"
chmod +x "$HQ_ROOT/ops/scripts/"*.sh
FAKE="$HQ_ROOT/fakebin"; mkdir -p "$FAKE"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE/bd"; chmod +x "$FAKE/bd"
export HQ_BD="$FAKE/bd"

# a session with a real objectives file
"$REGSH" register --id s-c1 --window hq:c1 --objectives state/objectives/s-c1.md >/dev/null
printf '# Objectives s-c1\n\n**Task:** ship the thing\n' > "$HQ_STATE_DIR/objectives/s-c1.md"

# precompact: flushes a snapshot copy
printf '{"session_id":"s-c1"}' | "$PRE_T" >/dev/null
[ -f "$HQ_STATE_DIR/snapshots/s-c1.md" ] && ok "precompact writes snapshot" || no "precompact writes snapshot"

# precompact on a session with NO objectives_file records one (deferred field path)
"$REGSH" register --id s-c2 --window hq:c2 >/dev/null
printf '{"session_id":"s-c2"}' | "$PRE_T" >/dev/null
of=$("$REGSH" get s-c2 | python3 -c 'import json,sys; print(json.load(sys.stdin)["objectives_file"])')
eq "precompact records objectives_file" "$of" "state/objectives/s-c2.md"

# postcompact reinject: source=compact prints the objectives; other sources are silent
out="$(printf '{"source":"compact","session_id":"s-c1"}' | "$POST_T")"
echo "$out" | grep -q "ship the thing" && ok "reinject emits objectives on compact" || no "reinject emits objectives on compact" "$out"
out2="$(printf '{"source":"startup","session_id":"s-c1"}' | "$POST_T")"
eq "reinject silent on startup" "$out2" ""

[ "$fail" = 0 ] && echo "COMPACT TESTS: PASS" || { echo "COMPACT TESTS: FAIL"; exit 1; }
