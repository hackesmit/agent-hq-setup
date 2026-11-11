#!/usr/bin/env bash
# lucy.sh: entrypoint for the `lucy` command, a true alias of `review`.
# The implementation is ops/scripts/review.sh, which keeps its endpoint and credential item fixed because
# it handles the owner's Proton Pass credential.
#
# Path resolution: readlink -f first, so a symlink installation
# (ln -s .../ops/scripts/lucy.sh ~/.local/bin/lucy) resolves to the real
# location instead of ~/.local/ops/scripts/review.sh. HQ_ROOT still wins when
# set, which is what the test harnesses use.
set -uo pipefail
self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "$0")"
HQ="${HQ_ROOT:-$(cd "$(dirname "$self")/../.." && pwd)}"
target="$HQ/ops/scripts/review.sh"
[ -x "$target" ] || { echo "lucy: cannot find $target" >&2; exit 1; }
exec "$target" "$@"
