#!/usr/bin/env bash
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../../.." && pwd)"
LINT="$HQ/ops/scripts/vault-lint.sh"
R="$(mktemp -d)"; trap 'rm -rf "$R"' EXIT
mkdir -p "$R/01 Projects/good/01 Notes" "$R/02 Bunkers/bad/01 X" "$R/01 Projects/nohub"
# good workspace: valid hub + a linked note in a category
printf -- '---\nupdated: 2026-07-17\n---\n# good - Hub\n## Map\n- [[note]]\n## Decisions\n' > "$R/01 Projects/good/_index.md"
printf -- '[[good hub]]\n' > "$R/01 Projects/good/01 Notes/note.md"
# bad workspace: hub missing ## Map, an orphan note, a loose root file
printf -- '---\nupdated: 2026-07-17\n---\n# bad - Hub\n## Decisions\n' > "$R/02 Bunkers/bad/_index.md"
printf -- 'no links here\n' > "$R/02 Bunkers/bad/01 X/orphan.md"
printf -- 'loose\n' > "$R/02 Bunkers/bad/loose.md"
# nohub workspace: no _index.md at all
printf -- 'x\n' > "$R/01 Projects/nohub/whatever.md"
out="$(bash "$LINT" "$R" 2>&1)"; echo "$out"
fail=0
grep -q "nohub.*_index.md" <<<"$out" || { echo "FAIL missing-hub not caught"; fail=1; }
grep -qi "bad.*Map"        <<<"$out" || { echo "FAIL missing ## Map not caught"; fail=1; }
grep -qi "orphan"          <<<"$out" || { echo "FAIL orphan not caught"; fail=1; }
grep -qi "loose"           <<<"$out" || { echo "FAIL loose root file not caught"; fail=1; }
grep -qi "WARN 01 Projects/good" <<<"$out" && { echo "FAIL good workspace wrongly flagged"; fail=1; }
[ "$fail" = 0 ] && echo "LINT TEST OK" || exit 1
