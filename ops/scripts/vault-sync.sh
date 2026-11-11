#!/usr/bin/env bash
# vault-sync - run by the git-sync daemon every 45 s (ops/scripts/git-sync.sh).
# Merges ~/hq/outbox/vault/ into the real vault: appends to existing files
# (daily notes, hub notes), copies new ones, then clears the outbox.
set -euo pipefail
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
OUTBOX="${VAULT_SYNC_OUTBOX:-$HQ/outbox/vault}"
VAULT="${VAULT_SYNC_VAULT:-$("$HQ/ops/scripts/vault-path.sh")}"
STAMPS="${VAULT_SYNC_STATE:-$HQ/state/vault-sync}"   # root-graph stamp + pending flag
# The vault root graph is the expensive one (~60s over /mnt/c): refresh it at
# most this often, and only when something has landed since the last refresh.
ROOT_GRAPH_MIN_S="${ROOT_GRAPH_MIN_S:-1800}"

[ -d "$OUTBOX" ] || { echo "nothing to sync ($OUTBOX missing)"; exit 0; }
[ -d "$VAULT" ] || { echo "ERROR: vault not found at $VAULT" >&2; exit 1; }

# --- pre-sync structure lint (warn-only) ---
"$(dirname "$0")/vault-lint.sh" "$OUTBOX" || true

# The merge prints one "created/appended -> <rel>" line per file plus the total;
# the graph step below reads those lines to learn WHICH workspaces changed.
SYNC_OUT="$(python3 - "$OUTBOX" "$VAULT" <<'PY'
import os, shutil, sys

outbox, vault = sys.argv[1], sys.argv[2]

def new_content(src_text, dst_text):
    """Drop a leading header block the destination already opens with.

    vault.sh and friends stamp a fresh header (title, blurb, first '## '
    section) whenever the outbox copy is absent, which it is after every sync.
    Appending that verbatim re-stamped the header on each run: Knowledge.md
    accumulated eight identical banners around one bullet each. Only strip when
    the destination STARTS with the same prefix, so a heading appearing
    mid-note is never treated as a duplicate banner.
    """
    head, sep, rest = src_text.partition("\n## ")
    if not sep:
        return src_text
    prefix = head + sep + rest.split("\n", 1)[0] + "\n"
    if dst_text.startswith(prefix):
        return src_text[len(prefix):]
    return src_text

moved = 0
for root, _dirs, files in os.walk(outbox):
    for name in files:
        src = os.path.join(root, name)
        rel = os.path.relpath(src, outbox)
        dst = os.path.join(vault, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            with open(src, encoding="utf-8") as f:
                content = f.read()
            with open(dst, encoding="utf-8") as f:
                content = new_content(content, f.read())
            with open(dst, "a", encoding="utf-8") as f:
                f.write("\n" + content)
            os.remove(src)
            print(f"appended -> {rel}")
        else:
            shutil.move(src, dst)
            print(f"created  -> {rel}")
        moved += 1

# remove now-empty outbox subdirectories, keep the root
for root, dirs, files in os.walk(outbox, topdown=False):
    if root != outbox and not os.listdir(root):
        os.rmdir(root)
print(f"{moved} file(s) synced")
PY
)"
printf '%s\n' "$SYNC_OUT"
MOVED="$(printf '%s\n' "$SYNC_OUT" | sed -n 's/^\([0-9][0-9]*\) file(s) synced$/\1/p' | tail -1)"
MOVED="${MOVED:-0}"
mkdir -p "$STAMPS"
if [ "$MOVED" -gt 0 ]; then touch "$STAMPS/root-graph.pending"; fi

# --- post-sync graph refresh (discovery layer) ---
# Refresh only what changed (2026-09-01). This step used to run graphify over
# EVERY workspace plus the vault root on EVERY pass of git-sync --watch (45s),
# whether or not a single file had synced: measured at ~62s per pass for the
# root alone over /mnt/c (9p), back to back, plus vault-bridge re-shipping the
# rewritten graphify-out to hqbox every minute (9.8 GB sent). That was the
# desktop's idle "WSL CPU" load. Now:
#   * a workspace refreshes right after it receives files (cheap, ~0.5s each);
#   * the vault root refreshes at most every ROOT_GRAPH_MIN_S, and only when
#     something landed since its last refresh (the pending flag);
#   * nothing synced = nothing walked;
#   * --graph forces the old full refresh (manual runs, after bulk edits).
NOGRAPH=0; FORCE=0
for a in "$@"; do
  [ "$a" = "--no-graph" ] && NOGRAPH=1
  [ "$a" = "--graph" ] && FORCE=1
done
REFRESHED=0
if [ "$NOGRAPH" = 0 ] && command -v graphify >/dev/null 2>&1; then
  if [ "$FORCE" = 1 ]; then
    for tree in "01 Projects" "02 Bunkers"; do
      for ws in "$VAULT/$tree"/*/; do
        [ -d "$ws" ] || continue
        ( cd "$ws" && graphify update . >/dev/null 2>&1 ) || true
        REFRESHED=$((REFRESHED+1))
      done
    done
  elif [ "$MOVED" -gt 0 ]; then
    # "created  -> 01 Projects/<ws>/Knowledge.md" names the workspace on the way in
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      ws="$VAULT/$rel"
      [ -d "$ws" ] || continue
      ( cd "$ws" && graphify update . >/dev/null 2>&1 ) || true
      echo "graph refreshed: $rel"
      REFRESHED=$((REFRESHED+1))
    done < <(printf '%s\n' "$SYNC_OUT" | sed -n 's#^\(created \|appended\) *-> \(0[12] [A-Za-z]*/[^/]*\)/.*#\2#p' | sort -u)
  fi
  # vault root: pending and old enough, or forced
  root_due=0
  if [ "$FORCE" = 1 ]; then root_due=1
  elif [ -f "$STAMPS/root-graph.pending" ]; then
    if [ ! -f "$STAMPS/root-graph.stamp" ]; then root_due=1
    else
      age=$(( $(date +%s) - $(stat -c %Y "$STAMPS/root-graph.stamp" 2>/dev/null || echo 0) ))
      if [ "$age" -ge "$ROOT_GRAPH_MIN_S" ]; then root_due=1; fi
    fi
  fi
  if [ "$root_due" = 1 ]; then
    ( cd "$VAULT" && graphify update . >/dev/null 2>&1 ) || true
    touch "$STAMPS/root-graph.stamp"; rm -f "$STAMPS/root-graph.pending"
    REFRESHED=$((REFRESHED+1))
    echo "graph refreshed (vault root)"
  fi
  # (plain if, not [ ] &&: a failing test as the last command of this block
  #  would make the whole if return 1 and set -e would end the script here)
  if [ "$REFRESHED" = 0 ]; then echo "graph refresh skipped (nothing changed)"; fi
else
  echo "graph refresh skipped (--no-graph or graphify absent)"
fi

# --- prune dated graphify snapshots (keep the newest KEEP per graphify-out) ---
# graphify update leaves a YYYY-MM-DD snapshot dir per run day; unpruned they
# accumulate forever (48 dirs / ~10MB by 2026-07-28). Current GRAPH_REPORT.md
# and graph.json at each graphify-out root are never touched. Only after a
# refresh: the old unconditional `find` walked the whole vault over 9p each pass.
KEEP=1
if [ "$REFRESHED" -gt 0 ]; then
  for g in "$VAULT/graphify-out" "$VAULT/01 Projects"/*/graphify-out "$VAULT/02 Bunkers"/*/graphify-out; do
    [ -d "$g" ] || continue
    # `|| true`: a graphify-out with no dated snapshot makes ls exit 2, and under
    # pipefail + errexit that ended the script before the prune (the old form
    # never logged its "pruned" line for that reason)
    ( ls -1d "$g"/2[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] 2>/dev/null || true ) | sort | head -n "-$KEEP" \
    | while IFS= read -r d; do rm -rf "$d"; done
  done
  echo "pruned dated graph snapshots (kept newest $KEEP per workspace)"
fi
exit 0
