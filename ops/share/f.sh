#!/usr/bin/env bash
# f - find a file the way the owner refers to it, hand back a path a terminal can use.
#
# The point of this command: the owner says a name ("the quote pdf") or pastes a
# Windows path ("C:\Users\Dan\Downloads\quote.pdf") and any hq terminal turns it
# into a real local path, with no thought about which machine the file lives on.
#
# Resolution order for a query:
#   1. an existing local path, used as-is
#   2. a Windows path, UNC path, or %USERPROFILE% path, translated onto the mount
#   3. a profile-relative path (Downloads/quote.pdf)
#   4. a name or fragment, searched and ranked across the desktop and hq
#
# Search is served from a cached index when one is fresh, because walking a whole
# Windows user profile over SMB takes seconds, and an agent that stalls on every
# lookup will not get used. A stale or missing index falls back to a live,
# depth-bounded, pruned find, and refreshes the cache in the background.
#
# Usage:
#   f <query>              resolve to one path and print it (the common case)
#   f find <query>         list ranked matches with size and age
#   f recent [n]           the n most recent files in Downloads, Desktop, Documents
#   f ls [subpath]         list a directory on the desktop
#   f cat <query>          print the resolved file
#   f get <query> [dest]   copy it into hq (a stable local copy) and print the path
#   f send <path> [dest]   send a file from hq to the desktop
#   f status               mount and index health
#   f reindex              rebuild the name index now
set -uo pipefail

HQ="${HQ_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
CONF="$HQ/ops/.desktop-share"

HOST="100.64.0.2"
TSNAME="your-pc"
SHARE="HQ"
MOUNT="/mnt/desktop"
CRED="/etc/hq/desktop.cred"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

INBOX="$HQ/share/inbox"
STATE="$HQ/state/share"
INDEX="$STATE/index.tsv"
INDEX_MAX_AGE=600          # seconds before the cache is considered stale
FIND_TIMEOUT=25            # hard cap on a live SMB walk
MAXDEPTH=7

# Directories that are never worth walking: Windows internals, app state, and
# build output. Without these prunes a profile walk drowns in AppData.
PRUNE_NAMES=(AppData "Application Data" "\$Recycle.Bin" .git node_modules
             .cache .npm .nvm .venv __pycache__ "Local Settings" IntelHaxm
             "My Documents" SendTo NetHood PrintHood Recent Templates
             .obsidian .trash dist build .next target vendor)

mounted() { mountpoint -q "$MOUNT"; }
warn() { echo "f: $*" >&2; }
die()  { echo "f: $*" >&2; exit 1; }

# The soft mount fails fast rather than hanging, so a cheap probe tells us
# whether the desktop is actually answering right now.
live() { mounted && timeout 5 ls "$MOUNT" >/dev/null 2>&1; }

require_mount() {
  if ! mounted; then
    warn "the desktop is not mounted at $MOUNT. Run: ops/share/desktop-share.sh up"
    return 1
  fi
  if ! live; then
    warn "the mount at $MOUNT is not responding (desktop asleep or off the tailnet)."
    warn "searching the hq side only. To fix: ops/share/desktop-share.sh remount"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------- path shapes

# Translate any way the owner might write a desktop path into a local one.
# The share root IS the user profile, so C:\Users\<anyone>\rest maps to $MOUNT/rest.
translate() {
  local q="$1" p
  p="${q//\\//}"                                   # backslashes to slashes

  case "$p" in
    //"$TSNAME"/"$SHARE"/*) printf '%s\n' "$MOUNT/${p#//"$TSNAME"/"$SHARE"/}"; return 0 ;;
    //*/"$SHARE"/*)         printf '%s\n' "$MOUNT/${p#*/"$SHARE"/}"; return 0 ;;
  esac

  # C:/Users/<name>/rest  and  c:/users/<name>/rest
  if [[ "$p" =~ ^[A-Za-z]:/[Uu]sers/[^/]+/(.*)$ ]]; then
    printf '%s\n' "$MOUNT/${BASH_REMATCH[1]}"; return 0
  fi
  # any other drive-letter path cannot be reached: only the profile is shared
  if [[ "$p" =~ ^[A-Za-z]:/ ]]; then
    warn "only the user profile is shared, so '$q' is outside the share"
    return 1
  fi

  # %USERPROFILE%\x, $env:USERPROFILE/x, ~/x written Windows-style
  p="${p#%USERPROFILE%/}"; p="${p#\$env:USERPROFILE/}"; p="${p#~/}"
  case "$1" in %USERPROFILE%*|\$env:USERPROFILE*) printf '%s\n' "$MOUNT/$p"; return 0 ;; esac

  return 1
}

# Profile-relative shorthand: "Downloads/quote.pdf", "Desktop/notes.txt"
profile_relative() {
  local p="${1//\\//}"
  [ -e "$MOUNT/$p" ] && { printf '%s\n' "$MOUNT/$p"; return 0; }
  return 1
}

# ---------------------------------------------------------------- index

find_expr() {
  local root="$1" depth="$2"
  local -a args=("$root" -maxdepth "$depth" "(")
  local first=1 n
  for n in "${PRUNE_NAMES[@]}"; do
    [ $first -eq 1 ] && first=0 || args+=(-o)
    args+=(-iname "$n")
  done
  args+=(")" -prune -o -type f -print)
  printf '%s\0' "${args[@]}"
}

walk() {  # walk <root> <depth>
  local root="$1" depth="$2"
  [ -d "$root" ] || return 0
  local -a a=()
  while IFS= read -r -d '' x; do a+=("$x"); done < <(find_expr "$root" "$depth")
  timeout "$FIND_TIMEOUT" find "${a[@]}" 2>/dev/null
}

search_roots() {
  # Priority order matters: files the owner means are almost always in these three.
  if live; then
    printf '%s\n' "$MOUNT/Downloads" "$MOUNT/Desktop" "$MOUNT/Documents" \
                  "$MOUNT/Pictures" "$MOUNT/Videos" "$MOUNT/Music" "$MOUNT/OneDrive"
  fi
  printf '%s\n' "$INBOX" "$HQ/outbox" "$HQ/docs" "$HQ/bunkers"
}

build_index() {
  mkdir -p "$STATE"
  local tmp="$INDEX.$$"
  : >"$tmp"
  local root
  while IFS= read -r root; do
    walk "$root" "$MAXDEPTH" >>"$tmp" 2>/dev/null
  done < <(search_roots)
  # the profile root itself, shallow, catches loose files not in a known folder
  live && walk "$MOUNT" 1 >>"$tmp" 2>/dev/null
  sort -u "$tmp" -o "$tmp"
  mv "$tmp" "$INDEX"
}

index_age() {
  [ -f "$INDEX" ] || { echo 999999; return; }
  echo $(( $(date +%s) - $(stat -c %Y "$INDEX") ))
}

candidates() {
  local age; age="$(index_age)"
  if [ -f "$INDEX" ] && [ "$age" -lt "$INDEX_MAX_AGE" ]; then
    cat "$INDEX"
  else
    # live walk now, refresh the cache behind us so the next call is instant
    local root
    while IFS= read -r root; do walk "$root" "$MAXDEPTH"; done < <(search_roots)
    ( build_index >/dev/null 2>&1 & )
  fi
}

# ---------------------------------------------------------------- ranking

# Rank matches so the obvious answer wins: exact basename, then prefix, then
# substring of the basename, then anywhere in the path. Newer files break ties,
# which is right for a Downloads folder holding three versions of one report.
rank() {
  local q="$1"
  awk -v q="$q" '
    function lower(s) { return tolower(s) }
    {
      path = $0
      n = split(path, parts, "/")
      base = parts[n]
      lb = lower(base); lq = lower(q); lp = lower(path)
      score = 0
      if (lb == lq)                 score = 100
      else if (index(lb, lq) == 1)  score = 80
      else if (index(lb, lq) > 0)   score = 60
      else if (index(lp, lq) > 0)   score = 30
      else next
      # prefer the desktop-facing folders over deep hq copies
      if (lp ~ /\/downloads\//) score += 6
      if (lp ~ /\/desktop\//)   score += 5
      if (lp ~ /\/documents\//) score += 4
      print score "\t" path
    }' | sort -k1,1nr | cut -f2- | while IFS= read -r p; do
      printf '%s\t%s\n' "$(stat -c %Y "$p" 2>/dev/null || echo 0)" "$p"
    done | sort -k1,1nr -s | cut -f2-
}

matches() { candidates | rank "$1"; }

human() {  # human <path> -> "size  age  path"
  local p="$1" sz age
  sz="$(stat -c %s "$p" 2>/dev/null || echo 0)"
  age="$(stat -c %Y "$p" 2>/dev/null || echo 0)"
  printf '%8s  %10s  %s\n' \
    "$(numfmt --to=iec --suffix=B "$sz" 2>/dev/null || echo "${sz}B")" \
    "$(date -d "@$age" '+%b %d %H:%M' 2>/dev/null || echo '?')" "$p"
}

# ---------------------------------------------------------------- resolve

resolve() {  # prints one path on stdout, or explains on stderr and returns 1
  local q="$1" p

  [ -e "$q" ] && { readlink -f "$q"; return 0; }

  if p="$(translate "$q")"; then
    if [ -e "$p" ]; then printf '%s\n' "$p"; return 0; fi
    warn "translated '$q' to '$p' but nothing is there"
    # fall through to a name search on the basename, which often still finds it
    q="$(basename "${q//\\//}")"
  fi

  if p="$(profile_relative "$q")"; then printf '%s\n' "$p"; return 0; fi

  require_mount || true
  local -a hits=()
  while IFS= read -r line; do hits+=("$line"); done < <(matches "$q" | head -20)

  case "${#hits[@]}" in
    0) warn "no match for '$q'. Try: f find '<fragment>' or f reindex"; return 1 ;;
    1) printf '%s\n' "${hits[0]}"; return 0 ;;
  esac

  # One clear winner, or genuinely ambiguous. Exact basename match wins outright.
  local exact=() h
  for h in "${hits[@]}"; do
    [ "$(basename "$h" | tr '[:upper:]' '[:lower:]')" = "$(echo "$q" | tr '[:upper:]' '[:lower:]')" ] && exact+=("$h")
  done
  if [ "${#exact[@]}" -eq 1 ]; then printf '%s\n' "${exact[0]}"; return 0; fi

  warn "'$q' is ambiguous, ${#hits[@]} matches. Best first:"
  for h in "${hits[@]:0:8}"; do human "$h" >&2; done
  printf '%s\n' "${hits[0]}"
  warn "resolved to the top match above. Pass a fuller name or path to pick another."
  return 0
}

# ---------------------------------------------------------------- commands

cmd_find() {
  [ $# -ge 1 ] || die "usage: f find <fragment>"
  require_mount || true
  local n=0 h
  while IFS= read -r h; do human "$h"; n=$((n+1)); [ $n -ge 25 ] && break; done < <(matches "$1")
  [ $n -eq 0 ] && { echo "no match for '$1'"; return 1; }
  return 0
}

cmd_recent() {
  local n="${1:-10}"
  require_mount || true
  local -a roots=()
  live && roots+=("$MOUNT/Downloads" "$MOUNT/Desktop" "$MOUNT/Documents")
  roots+=("$INBOX")
  local f
  for f in "${roots[@]}"; do walk "$f" 2; done \
    | while IFS= read -r p; do printf '%s\t%s\n' "$(stat -c %Y "$p" 2>/dev/null || echo 0)" "$p"; done \
    | sort -k1,1nr | cut -f2- | head -n "$n" \
    | while IFS= read -r p; do human "$p"; done
}

cmd_ls() {
  require_mount || die "cannot list the desktop while it is unmounted"
  local sub="${1:-}"
  local target="$MOUNT/${sub//\\//}"
  [ -d "$target" ] || { local r; r="$(resolve "${sub:-.}")" && target="$r"; }
  timeout 15 ls -lh --time-style=+'%b %d %H:%M' "$target" | head -60
}

cmd_get() {
  [ $# -ge 1 ] || die "usage: f get <query> [dest]"
  local src dest
  src="$(resolve "$1")" || exit 1
  dest="${2:-$INBOX}"
  mkdir -p "$INBOX"
  [ -d "$dest" ] && dest="$dest/$(basename "$src")"
  cp -p "$src" "$dest" || die "copy failed from $src"
  readlink -f "$dest"
}

cmd_cat() {
  [ $# -ge 1 ] || die "usage: f cat <query>"
  local p; p="$(resolve "$1")" || exit 1
  timeout 20 cat "$p"
}

# hq to desktop. Two routes, and it says which one it used.
#
# The direct write was blocked in the cage era by the write-containment guard (see
# ops/proposals/2026-08-17-desktop-write-access); that guard is gone since proposal 58
# and hq-fgg3.11, but this route was never switched over, so Taildrop still carries
# the file. It lands in the desktop's Tailscale inbox
# rather than a chosen folder, which is the one rough edge in this direction.
cmd_send() {
  [ $# -ge 1 ] || die "usage: f send <local-path> [dest-subpath]"
  local src="$1" dest="${2:-Desktop/from-hq}"
  [ -f "$src" ] || die "no such file: $src"

  if mounted && live && [ -w "$MOUNT" ]; then
    local target="$MOUNT/${dest//\\//}"
    if mkdir -p "$target" 2>/dev/null && cp -p "$src" "$target/" 2>/dev/null; then
      echo "sent by SMB to $target/$(basename "$src")"
      return 0
    fi
  fi

  if command -v tailscale >/dev/null; then
    if tailscale file cp "$src" "$TSNAME:" 2>&1; then
      echo "sent by Taildrop to $TSNAME. Accept it on the desktop, or it lands in the Tailscale inbox."
      return 0
    fi
  fi
  die "could not send. Mount is read-only or down, and Taildrop failed."
}

cmd_status() {
  "$HQ/ops/share/desktop-share.sh" status
  local age; age="$(index_age)"
  if [ -f "$INDEX" ]; then
    echo "index: $(wc -l <"$INDEX") files, ${age}s old ($INDEX)"
  else
    echo "index: none yet (run: f reindex)"
  fi
  echo "inbox: $INBOX ($(find "$INBOX" -type f 2>/dev/null | wc -l) files)"
}

cmd_reindex() {
  echo "indexing..."
  build_index
  echo "index: $(wc -l <"$INDEX") files at $INDEX"
}

case "${1:-}" in
  "")        sed -n '/^# Usage:/,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//;$d' ;;
  find)      shift; cmd_find "$@" ;;
  recent)    shift; cmd_recent "$@" ;;
  ls)        shift; cmd_ls "$@" ;;
  get)       shift; cmd_get "$@" ;;
  cat)       shift; cmd_cat "$@" ;;
  send)      shift; cmd_send "$@" ;;
  status)    cmd_status ;;
  reindex)   cmd_reindex ;;
  -h|--help|help) sed -n '/^# Usage:/,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//;$d' ;;
  *)         resolve "$1" ;;
esac
