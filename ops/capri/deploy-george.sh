#!/usr/bin/env bash
# deploy-george.sh: copy Capri (hands, listener, voice) from this repo to George and keep it running (hq-95wuo).
# Source lives in tools/capri-hands, tools/capri, tools/capri-voice; George holds the copies under C:\Users\owner.
# Only git-tracked files are copied, and only when they changed; an ignored or untracked local file (capri.json,
# venv, models, logs) never leaves hqbox. Nothing on George is ever deleted (venvs, models, logs, .bak-* stay).
#
# usage: deploy-george.sh [--check | --scan | --bootstrap] [--allow-no-gitleaks] [--part hands|listener|voice]...
#   (no flag)    scan for secrets, copy changed files, re-register a changed task XML, restart a changed
#                daemon, then verify: hands answers (george.sh windows), the listener task is Running, no drift.
#                A part whose last activation did not finish (marker <part dir>\.deploy-pending on George) is
#                re-registered, restarted and verified even when every file matches.
#   --check      compare George with the repo only; prints one 'drift: <part> <file>' line per difference.
#   --scan       secret scan of every tracked file in the three trees; George is not touched.
#   --bootstrap  new PC: scan, then copy files only (no ssh, no token, no tasks); leaves each part pending.
#   --allow-no-gitleaks  run the regex sweep alone when gitleaks is not installed (default: refuse, exit 7).
# Exit: 0 ok, 1 drift (--check) or a failed copy, register, restart or verify, 2 usage or source not a git
#       checkout, 3 George unreachable, 4 hands token file missing, 5 secret-shaped string in a tracked file,
#       6 pending marker cannot be read, written or cleared, 7 gitleaks not installed.
# Env (tests override): CAPRI_SRC (repo root), CAPRI_GEORGE_ROOT (George C:\Users\owner as mounted, default
#   /mnt/george/Users/owner), CAPRI_WIN_HOME (default C:\Users\owner), CAPRI_TOKEN_FILE, GEORGE_SSH,
#   CAPRI_GEORGE_SH (default ops/scripts/george.sh), CAPRI_GITLEAKS (default gitleaks),
#   CAPRI_VERIFY_TRIES (30), CAPRI_VERIFY_SLEEP (5).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${CAPRI_SRC:-$(cd "$HERE/../.." && pwd)}"
ROOT="${CAPRI_GEORGE_ROOT:-/mnt/george/Users/owner}"
WIN_HOME="${CAPRI_WIN_HOME:-C:\\Users\\owner}"
TOKEN_FILE="${CAPRI_TOKEN_FILE:-$ROOT/AppData/Local/capri-hands/token}"
SSH="${GEORGE_SSH:-ssh -o ConnectTimeout=8 -o BatchMode=yes george}"
GEORGE_SH="${CAPRI_GEORGE_SH:-$SRC/ops/scripts/george.sh}"
GITLEAKS="${CAPRI_GITLEAKS:-gitleaks}"
TRIES="${CAPRI_VERIFY_TRIES:-30}"
NAP="${CAPRI_VERIFY_SLEEP:-5}"
MARK=.deploy-pending

# part -> repo dir, George dir, task xml, scheduled task name (empty: no daemon)
declare -A REPO_DIR=([hands]=tools/capri-hands [listener]=tools/capri [voice]=tools/capri-voice)
declare -A GEORGE_DIR=([hands]=capri-hands [listener]=capri [voice]=capri-voice)
declare -A XML=([hands]=hands-task.xml [listener]=capri-task.xml [voice]=)
declare -A TASK=([hands]=capri-hands [listener]=capri [voice]=)
ORDER=(hands listener voice)   # hands first: listener and voice call it

die(){ echo "deploy-george: $2" >&2; exit "$1"; }
log(){ echo "deploy-george: $*"; }

mode=deploy; parts=(); allow_no_gitleaks=0
setmode(){ [ "$mode" = deploy ] || die 2 "use only one of --check, --scan, --bootstrap"; mode=$1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --check) setmode check ;;
    --scan) setmode scan ;;
    --bootstrap) setmode bootstrap ;;
    --allow-no-gitleaks) allow_no_gitleaks=1 ;;
    --part) [ -n "${2:-}" ] && [ -n "${REPO_DIR[$2]:-}" ] || die 2 "--part needs one of: ${ORDER[*]}"; parts+=("$2"); shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) die 2 "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[ ${#parts[@]} -gt 0 ] || parts=("${ORDER[@]}")
for p in "${ORDER[@]}"; do [ -d "$SRC/${REPO_DIR[$p]}" ] || die 2 "missing source dir $SRC/${REPO_DIR[$p]}"; done
git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 2 "source is not a git checkout: $SRC"
# keep dependency order whatever order --part came in
sel=(); for p in "${ORDER[@]}"; do for q in "${parts[@]}"; do [ "$p" = "$q" ] && { sel+=("$p"); break; }; done; done

tracked(){ # part -> git-tracked regular files of the part's repo dir, relative to it, one per line
  local d="$SRC/${REPO_DIR[$1]}" f list
  list=$(git -C "$d" ls-files -z -- . | tr '\0' '\n') || die 2 "git ls-files failed in $d"
  while IFS= read -r f; do [ -n "$f" ] && [ -f "$d/$f" ] && [ ! -L "$d/$f" ] && printf '%s\n' "$f"; done <<<"$list" | LC_ALL=C sort
}

# Files that run on George: the part's tracked files except repo-only docs, tests, probes run from hqbox,
# the task XML (written as UTF-16 separately) and the config example.
deployable(){ # part -> relative paths, one per line
  tracked "$1" \
    | grep -vE '(^|/)(tests|spike|__pycache__|\.pytest_cache)/' \
    | grep -vE '(^|/)(README\.md|\.gitignore|\.gitattributes)$|\.sh$|\.example$|\.pyc$' \
    | grep -vxF "${XML[$1]:-//none//}"
}

# Secret-shaped strings: private keys, vendor key prefixes, a quoted literal assigned to a secret-named field,
# long hex runs, and the live hands token itself when the token file is readable. Swept over every tracked
# file of all three trees (scripts, tests and docs included), whatever --part says; gitleaks over the same set.
SECRET_RE='-----BEGIN [A-Z ]*PRIVATE KEY|(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|(password|passwd|secret|token|api[_-]?key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'[:space:]]{12,}["'"'"']|[0-9a-fA-F]{40,}'
# Known non-secret hits, pinned by file and the sha256 of the exact match (never the value itself): any other
# match in the same file, or this one moved to another file, still refuses.
#   tools/capri/tests/test_core.py: a stale per-boot console key used as a parser fixture (on main since ce99190).
SCAN_ALLOW=(
  "tools/capri/tests/test_core.py a277fca98cb3a7d2ab3ad86bffacdb4b09a8213b67fe3e16b38f33f170b9c94c"
)
allowed(){ # file match -> 0 when pinned in SCAN_ALLOW
  local h a; h=$(printf '%s' "$2" | sha256sum | cut -d' ' -f1)
  for a in "${SCAN_ALLOW[@]}"; do [ "$a" = "$1 $h" ] && return 0; done; return 1
}
SCANNED=0
scan(){ # -> exit 5 on any hit (file and line printed, never the match), 7 when gitleaks is missing
  local p f hits=0 files=() out tmp
  for p in "${ORDER[@]}"; do
    while IFS= read -r f; do files+=("${REPO_DIR[$p]}/$f"); done < <(tracked "$p")
  done
  SCANNED=${#files[@]}
  [ "$SCANNED" -gt 0 ] || die 2 "no tracked Capri files under $SRC (nothing to scan)"
  local file line match
  out=$(cd "$SRC" && grep -noEiI -- "$SECRET_RE" "${files[@]}" 2>/dev/null \
    | while IFS=: read -r file line match; do allowed "$file" "$match" || printf '%s:%s\n' "$file" "$line"; done | uniq)
  [ -n "$out" ] && { echo "$out" | sed 's|^|secret-shaped: |' >&2; hits=1; }
  if [ -s "$TOKEN_FILE" ] 2>/dev/null; then
    out=$(cd "$SRC" && grep -lF -f <(tr -d '\r' <"$TOKEN_FILE" | grep -v '^[[:space:]]*$') -- "${files[@]}" 2>/dev/null)
    [ -n "$out" ] && { echo "$out" | sed 's|^|hands token found in: |' >&2; hits=1; }
  fi
  if command -v "$GITLEAKS" >/dev/null 2>&1; then
    tmp=$(mktemp -d) || die 1 "mktemp failed"
    (cd "$SRC" && cp --parents -- "${files[@]}" "$tmp/") || { rm -rf "${tmp:?}"; die 1 "could not stage files for gitleaks"; }
    "$GITLEAKS" dir "$tmp" --no-banner --redact >/dev/null 2>&1 || { echo "gitleaks: leak in tracked Capri files" >&2; hits=1; }
    rm -rf "${tmp:?}"
  else
    echo "gitleaks: not installed, regex sweep only" >&2
    [ "$hits" = 0 ] && [ "$allow_no_gitleaks" = 0 ] && die 7 "refused: gitleaks not installed (install it, or pass --allow-no-gitleaks)"
  fi
  [ "$hits" = 0 ] || die 5 "refused: secret-shaped string in a tracked file (see above)"
}

reach(){ # mount answers within 20 s; deploy also needs ssh
  timeout 20 test -d "$ROOT" 2>/dev/null || die 3 "George unreachable: $ROOT does not answer (George off or asleep?)"
  [ "$mode" = deploy ] || return 0
  $SSH "echo ok" </dev/null 2>/dev/null | tr -d '\r' | grep -qx ok || die 3 "George unreachable over ssh ($SSH)"
}

xml_same(){ # repo utf-8 xml, george utf-16 xml
  [ -f "$2" ] && iconv -f UTF-16 -t UTF-8 "$2" 2>/dev/null | tr -d '\r' | cmp -s - <(tr -d '\r' <"$1")
}

# Pending marker <George part dir>/.deploy-pending: set before the first byte is copied, cleared only after
# register, restart and verify all pass, so a failed activation is retried by the next run.
pending(){ # part -> 0 when the marker is present; exit 6 when the part dir exists but cannot be read
  local g="$ROOT/${GEORGE_DIR[$1]}"
  [ -e "$g" ] || return 1
  [ -d "$g" ] && [ -r "$g" ] && [ -x "$g" ] || die 6 "cannot read the pending marker dir $g"
  [ -e "$g/$MARK" ]
}
mark_set(){
  local g="$ROOT/${GEORGE_DIR[$1]}"
  { mkdir -p "$g" && date -u +%FT%TZ >"$g/$MARK"; } 2>/dev/null || die 6 "cannot write the pending marker $g/$MARK"
}
mark_clear(){
  local g="$ROOT/${GEORGE_DIR[$1]}"
  [ -e "$g/$MARK" ] || return 0
  rm -f -- "${g:?}/${MARK:?}" 2>/dev/null; [ ! -e "$g/$MARK" ] || die 6 "cannot clear the pending marker $g/$MARK"
}

drift(){ # part -> prints drift lines, returns 1 when any
  local p=$1 f n=0 r="$SRC/${REPO_DIR[$1]}" g="$ROOT/${GEORGE_DIR[$1]}"
  pending "$p" && { echo "drift: $p $MARK (last activation did not finish)"; n=1; }
  while IFS= read -r f; do
    if [ ! -f "$g/$f" ]; then echo "drift: $p $f (missing on George)"; n=1
    elif ! cmp -s "$r/$f" "$g/$f"; then echo "drift: $p $f (differs)"; n=1; fi
  done < <(deployable "$p")
  if [ -n "${XML[$p]}" ] && ! xml_same "$r/${XML[$p]}" "$g/${XML[$p]}"; then echo "drift: $p ${XML[$p]} (differs)"; n=1; fi
  if [ -f "$r/capri.json.example" ] && [ ! -f "$g/capri.json" ]; then echo "drift: $p capri.json (missing on George)"; n=1; fi
  return $n
}

copy(){ # part [noxml] -> sets CHANGED and XML_CHANGED
  local p=$1 f r="$SRC/${REPO_DIR[$1]}" g="$ROOT/${GEORGE_DIR[$1]}"
  CHANGED=0; XML_CHANGED=0
  while IFS= read -r f; do
    cmp -s "$r/$f" "$g/$f" 2>/dev/null && continue
    mkdir -p "$(dirname "$g/$f")" && cp "$r/$f" "$g/$f" || die 1 "copy failed: $p $f"
    log "copied $p $f"; CHANGED=1
  done < <(deployable "$p")
  if [ "${2:-}" != noxml ] && [ -n "${XML[$p]}" ] && ! xml_same "$r/${XML[$p]}" "$g/${XML[$p]}"; then
    { printf '\xff\xfe'; iconv -f UTF-8 -t UTF-16LE "$r/${XML[$p]}"; } >"$g/${XML[$p]}" || die 1 "xml write failed: $p"
    log "wrote $p ${XML[$p]} (UTF-16)"; XML_CHANGED=1; CHANGED=1
  fi
  # the real config is George's: install the example only when George has none, never overwrite
  if [ -f "$r/capri.json.example" ] && [ ! -e "$g/capri.json" ]; then
    cp "$r/capri.json.example" "$g/capri.json" || die 1 "capri.json install failed: $p"
    log "installed $p capri.json from the example (edit device and threshold)"
  fi
}

remote(){ $SSH "$1" </dev/null 2>&1 | tr -d '\r'; return "${PIPESTATUS[0]}"; }

restart(){ # part, register (1: XML changed or a pending activation)
  local p=$1 t=${TASK[$1]}
  [ -n "$t" ] || return 0
  if [ "$2" = 1 ]; then
    remote "schtasks /Create /TN $t /XML $WIN_HOME\\${GEORGE_DIR[$p]}\\${XML[$p]} /F" >/dev/null || die 1 "schtasks /Create $t failed (marker left: next run retries)"
    log "registered task $t"
  fi
  remote "schtasks /End /TN $t & schtasks /Run /TN $t" >/dev/null || die 1 "schtasks restart $t failed (marker left: next run retries)"
  log "restarted task $t"
}

verify(){ # part -> 0 when healthy, retried
  local p=$1 i
  for ((i = 1; i <= TRIES; i++)); do
    case "$p" in
      hands) "$GEORGE_SH" windows >/dev/null 2>&1 && return 0 ;;
      listener) remote "schtasks /Query /TN capri /FO LIST" | grep -qE '^Status:[[:space:]]+Running' && return 0 ;;
      voice) return 0 ;;
    esac
    [ "$i" -lt "$TRIES" ] && sleep "$NAP"
  done
  return 1
}

if [ "$mode" = scan ]; then scan; log "scan clean: $SCANNED tracked files in ${REPO_DIR[*]}"; exit 0; fi

reach

if [ "$mode" = bootstrap ]; then
  scan
  for p in "${sel[@]}"; do mark_set "$p"; copy "$p" noxml; log "$p files copied, activation pending"; done
  log "bootstrap done: ${sel[*]}. Next: setup.bat, venv.bat, 'python -m hands init', then deploy-george.sh"
  exit 0
fi

[ -s "$TOKEN_FILE" ] || die 4 "hands token file missing or empty: $TOKEN_FILE (run 'python -m hands init' on George)"

if [ "$mode" = check ]; then
  rc=0; for p in "${sel[@]}"; do drift "$p" || rc=1; done
  [ "$rc" = 0 ] && log "no drift: ${sel[*]}"
  exit $rc
fi

scan
for p in "${sel[@]}"; do
  pend=0; pending "$p" && pend=1
  if [ "$pend" = 0 ] && drift "$p" >/dev/null; then
    log "$p unchanged, not restarted"
  else
    mark_set "$p"
    copy "$p"
    [ "$pend" = 1 ] && log "$p had a pending activation: register and restart again"
    reg=$XML_CHANGED; [ "$pend" = 1 ] && reg=1
    restart "$p" "$reg"
  fi
  verify "$p" || die 1 "verify failed: $p (hands: george.sh windows; listener: task Running)"
  mark_clear "$p"
  log "$p ok"
done
rc=0; for p in "${sel[@]}"; do drift "$p" || rc=1; done
[ "$rc" = 0 ] || die 1 "drift remains after deploy"
log "deployed: ${sel[*]}"
