#!/usr/bin/env bash
# session-archive.sh (hq-0yagv.1): append-only, compressed copy of every Claude
# session transcript, kept forever as the record of the owner's decisions.
#
#   session-archive.sh            archive (idempotent; a rerun adds nothing)
#   session-archive.sh --verify   decompress every archived current file and compare
#                                 its sha256 with the source; exit 0 only if all match
#
# Sources under $SA_SRC (~/.claude): projects/ (every file: transcripts, subagents,
# tool-results), todos/, history.jsonl. Archive: $SA_DEST/<relpath>.zst plus
# manifest.tsv (path, size, sha256, first_seen, last_seen). Never writes to or
# deletes from the source; never deletes from the archive.
#
# A transcript that grew replaces its archived copy only when the new bytes start
# with the old bytes. Otherwise (diverged or shrank) both copies are kept, the new
# one as <relpath>@<mtime>.zst.
#
# Exit: 0 ok, 1 source error or verify mismatch, 2 archive dir missing/unwritable
# or disk low, 3 archive over the size cap (stop and ask the owner).
# Env (fixtures): SA_SRC, SA_DEST, SA_MIN_FREE_GB (5), SA_MAX_GB (20).
set -uo pipefail
umask 077

SRC="${SA_SRC:-$HOME/.claude}"
DEST="${SA_DEST:-/srv/session-archive/claude}"
MIN_FREE_GB="${SA_MIN_FREE_GB:-5}"
MAX_GB="${SA_MAX_GB:-20}"
MODE=archive
[ "${1:-}" = "--verify" ] && MODE=verify
MAN="$DEST/manifest.tsv"
NOW="$(date -u +%FT%TZ)"

sha_of() { sha256sum | cut -d' ' -f1; }

list_sources() {
  local d
  for d in projects todos; do
    [ -d "$SRC/$d" ] && find "$SRC/$d" -type f -printf '%P\0' | sed -z "s|^|$d/|"
  done
  [ -f "$SRC/history.jsonl" ] && printf 'history.jsonl\0'
  return 0
}

# manifest in memory: M[key]="size<TAB>sha<TAB>first<TAB>last"
declare -A M
load_manifest() {
  [ -f "$MAN" ] || return 0
  local k s h f l
  while IFS=$'\t' read -r k s h f l; do
    [ -n "$k" ] && [ "$k" != "path" ] && M["$k"]="$s"$'\t'"$h"$'\t'"$f"$'\t'"$l"
  done < "$MAN"
}
write_manifest() {
  local tmp="$MAN.tmp.$$" k
  { printf 'path\tsize\tsha256\tfirst_seen\tlast_seen\n'
    for k in "${!M[@]}"; do printf '%s\t%s\n' "$k" "${M[$k]}"; done | sort
  } > "$tmp" && mv -f "$tmp" "$MAN"
}

dir_ok() {
  [ -d "$DEST" ] && [ -w "$DEST" ] || { echo "FAIL archive dir missing or not writable: $DEST" >&2; exit 2; }
}

if [ "$MODE" = verify ]; then
  dir_ok; load_manifest
  bad=0 n=0
  while IFS= read -r -d '' r; do
    n=$((n+1))
    z="$DEST/$r.zst"
    if [ ! -f "$z" ]; then echo "MISSING $r" >&2; bad=$((bad+1)); continue; fi
    a="$(zstd -dc -- "$z" 2>/dev/null | sha_of)"
    s="$(sha_of < "$SRC/$r" 2>/dev/null)"
    ok=0
    if [ -n "$s" ] && [ "$a" = "$s" ]; then ok=1
    elif [ -n "$s" ]; then # a shrunk or diverged source lives in a kept-both copy, $r@<mtime>[-sha8]
      for k in "${!M[@]}"; do
        [[ "$k" == "$r@"* ]] || continue
        [ "$(cut -f2 <<< "${M[$k]}")" = "$s" ] || continue
        [ "$(zstd -dc -- "$DEST/$k.zst" 2>/dev/null | sha_of)" = "$s" ] && { ok=1; break; }
      done
    fi
    [ "$ok" -eq 1 ] || { echo "MISMATCH $r" >&2; bad=$((bad+1)); }
  done < <(list_sources)
  echo "verify: $n sources, $bad bad"
  [ "$bad" -eq 0 ]; exit $?
fi

dir_ok
if [ ! -d "$SRC/projects" ] || [ -L "$SRC/projects" ]; then
  echo "FAIL source projects dir missing or a symlink: $SRC/projects" >&2; exit 1
fi
exec 9> "$DEST/.lock"
flock -n 9 || { echo "FAIL another session-archive run holds $DEST/.lock" >&2; exit 2; }
avail_kb="$(df -Pk "$DEST" | awk 'NR==2{print $4}')"
case "$avail_kb" in ''|*[!0-9]*) echo "FAIL cannot read free disk space for $DEST" >&2; exit 2;; esac
if [ "$avail_kb" -lt $((MIN_FREE_GB * 1024 * 1024)) ]; then
  echo "FAIL disk free $((avail_kb/1024/1024)) GB under $MIN_FREE_GB GB" >&2; exit 2
fi
load_manifest

errs=0 added=0 grown=0 kept=0 same=0
tmpz="$DEST/.tmp.$$.zst"
trap 'rm -f "$tmpz"' EXIT

# compress $1 into $tmpz; sets CSIZE/CSHA from the stored stream so the manifest
# always describes the archive, even if the source grows during the copy
compress() {
  zstd -q -T1 -6 -f -c -- "$1" > "$tmpz" 2>/dev/null || return 1
  CSHA="$(zstd -dc -- "$tmpz" | sha_of)"
  CSIZE="$(zstd -dc -- "$tmpz" | wc -c)"
}
place() { # $1 key
  mkdir -p -m 0700 "$(dirname "$DEST/$1.zst")" && mv -f "$tmpz" "$DEST/$1.zst" && chmod 0600 "$DEST/$1.zst"
}

while IFS= read -r -d '' r; do
  f="$SRC/$r"
  if ! ssha="$(sha_of < "$f" 2>/dev/null)" || [ ${#ssha} -ne 64 ]; then
    echo "ERROR unreadable source: $r" >&2; errs=$((errs+1)); continue
  fi
  ssize="$(stat -c %s "$f")"
  row="${M[$r]:-}"
  if [ -n "$row" ] && [ ! -f "$DEST/$r.zst" ]; then
    echo "ERROR manifest lists $r but the archive file is gone" >&2; errs=$((errs+1)); continue
  fi
  if [ -z "$row" ] && [ -f "$DEST/$r.zst" ]; then # archive file without a manifest row (interrupted run)
    osha="$(zstd -dc -- "$DEST/$r.zst" | sha_of)"; osize="$(zstd -dc -- "$DEST/$r.zst" | wc -c)"
    row="$osize"$'\t'"$osha"$'\t'"$NOW"$'\t'"$NOW"
  fi
  if [ -z "$row" ]; then
    compress "$f" || { echo "ERROR compress failed: $r" >&2; errs=$((errs+1)); continue; }
    place "$r" || { echo "ERROR cannot write archive: $r" >&2; errs=$((errs+1)); continue; }
    M[$r]="$CSIZE"$'\t'"$CSHA"$'\t'"$NOW"$'\t'"$NOW"; added=$((added+1)); continue
  fi
  IFS=$'\t' read -r osize osha first _ <<< "$row"
  if [ "$osha" = "$ssha" ]; then
    M[$r]="$osize"$'\t'"$osha"$'\t'"$first"$'\t'"$NOW"; same=$((same+1)); continue
  fi
  if [ "$ssize" -gt "$osize" ] && [ "$(head -c "$osize" -- "$f" | sha_of)" = "$osha" ]; then
    compress "$f" || { echo "ERROR compress failed: $r" >&2; errs=$((errs+1)); continue; }
    place "$r" || { echo "ERROR cannot write archive: $r" >&2; errs=$((errs+1)); continue; }
    M[$r]="$CSIZE"$'\t'"$CSHA"$'\t'"$first"$'\t'"$NOW"; grown=$((grown+1)); continue
  fi
  # shrank or diverged: keep the archived copy and add this one beside it
  [ "$ssize" -lt "$osize" ] && echo "WARN source shrank, keeping both copies: $r" >&2 \
                            || echo "WARN source diverged, keeping both copies: $r" >&2
  vk="$r@$(stat -c %Y "$f")"
  vrow="${M[$vk]:-}"
  if [ -n "$vrow" ] && [ "$(cut -f2 <<< "$vrow")" = "$ssha" ]; then
    IFS=$'\t' read -r vs vh vf _ <<< "$vrow"; M[$vk]="$vs"$'\t'"$vh"$'\t'"$vf"$'\t'"$NOW"; same=$((same+1)); continue
  fi
  [ -n "$vrow" ] && vk="$vk-${ssha:0:8}"
  if [ -n "${M[$vk]:-}" ]; then # same name and hash prefix already stored
    IFS=$'\t' read -r vs vh vf _ <<< "${M[$vk]}"; M[$vk]="$vs"$'\t'"$vh"$'\t'"$vf"$'\t'"$NOW"; same=$((same+1)); continue
  fi
  compress "$f" || { echo "ERROR compress failed: $r" >&2; errs=$((errs+1)); continue; }
  place "$vk" || { echo "ERROR cannot write archive: $vk" >&2; errs=$((errs+1)); continue; }
  M[$vk]="$CSIZE"$'\t'"$CSHA"$'\t'"$NOW"$'\t'"$NOW"; kept=$((kept+1))
done < <(list_sources)

write_manifest || { rm -f "$MAN.tmp.$$"; echo "FAIL manifest write failed: $MAN" >&2; exit 2; }
chmod 0600 "$MAN"
chmod 0700 "$DEST"
used_kb="$(du -sk "$DEST" | cut -f1)"
echo "session-archive: added=$added grown=$grown kept_both=$kept unchanged=$same errors=$errs"
echo "disk use: archive $((used_kb/1024)) MB, free $(( $(df -Pk "$DEST" | awk 'NR==2{print $4}') /1024/1024 )) GB"
if [ "$used_kb" -gt $((MAX_GB * 1024 * 1024)) ]; then
  echo "STOP archive over $MAX_GB GB: ask the owner" >&2; exit 3
fi
[ "$errs" -eq 0 ]
