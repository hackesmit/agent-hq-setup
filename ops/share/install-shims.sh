#!/usr/bin/env bash
# install-shims.sh - put `f` and `desktop-share` on your PATH.
#
# RUN THIS YOURSELF (prefix with ! in a Claude terminal). ~/.local/bin sits
# outside the agent write containment, so an agent cannot create these for you.
# They are exec wrappers rather than symlinks because the scripts locate the hq
# root from their own directory, which a symlink would resolve wrongly.
set -euo pipefail

BIN="$HOME/.local/bin"
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$BIN"

shim() {  # shim <name> <target>
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$2" >"$BIN/$1"
  chmod +x "$BIN/$1"
  echo "installed $BIN/$1"
}

shim f "$HQ/ops/share/f.sh"
shim desktop-share "$HQ/ops/share/desktop-share.sh"

echo
echo "check: f status"
