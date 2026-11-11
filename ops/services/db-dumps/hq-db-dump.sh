#!/usr/bin/env bash
# hq-db-dump.sh: nightly pg_dump of every production Supabase database (hq-pgbpq.2).
# Runs as owner from hq-db-dump.timer. Read-only against prod: pg_dump only.
# Each database in targets.tsv becomes <dir>/<name>/<name>-<UTC stamp>.dump
# (custom format, mode 0600, dir 0700). The dump dir sits under /home/owner,
# which the hqbox restic backup includes, so every dump reaches George within
# a day. Dumps older than KEEP_DAYS are deleted, the newest one never.
# Fail-closed: a target whose password lookup, pg_dump or archive check fails,
# or whose archive holds no table data, leaves no file and makes the run exit
# 1 after the other targets are tried, so OnFailure= pages.
# Canonical copy: ops/services/db-dumps/ in the hq repo; installed copy:
# ~/.local/bin/hq-db-dump. Revert: systemctl --user disable --now hq-db-dump.timer
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${HQ_DB_DUMP_DIR:-$HOME/backups/supabase}"
TARGETS="${HQ_DB_DUMP_TARGETS:-$HOME/hq/ops/services/db-dumps/targets.tsv}"
[ -f "$TARGETS" ] || TARGETS="$HERE/targets.tsv"
KEEP_DAYS="${HQ_DB_DUMP_KEEP_DAYS:-14}"
PG_DUMP="${HQ_PG_DUMP:-/usr/lib/postgresql/17/bin/pg_dump}"
PG_RESTORE="${HQ_PG_RESTORE:-/usr/lib/postgresql/17/bin/pg_restore}"
PP="${HQ_PP:-$HOME/.local/bin/pp}"
export PROTON_PASS_AGENT_REASON="hq-db-dump: nightly read-only pg_dump of production Supabase"

umask 077
[ -f "$TARGETS" ] || { echo "no targets file: $TARGETS"; exit 1; }
mkdir -p "$DIR" && chmod 700 "$DIR" || { echo "cannot create $DIR"; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
failed=0; done_n=0

dump_one() {
  local name="$1" host="$2" user="$3" vault="$4" item="$5" field="$6"
  local tdir="$DIR/$name" out part pw rc tables
  mkdir -p "$tdir" && chmod 700 "$tdir" || return 1
  out="$tdir/$name-$stamp.dump"; part="$out.partial"
  pw=$("$PP" item view --vault-name "$vault" --item-title "$item" --field "$field" 2>/dev/null) || pw=""
  if [ -z "$pw" ]; then echo "$name: password lookup failed"; return 1; fi
  PGPASSWORD="$pw" PGCONNECT_TIMEOUT=20 "$PG_DUMP" --format=custom --no-password --file="$part" \
    "host=$host port=5432 dbname=postgres user=$user sslmode=require"
  rc=$?; unset pw
  if [ "$rc" -ne 0 ]; then echo "$name: pg_dump exit $rc"; rm -f "$part"; return 1; fi
  if [ ! -s "$part" ]; then echo "$name: empty dump"; rm -f "$part"; return 1; fi
  tables=$("$PG_RESTORE" --list "$part" 2>/dev/null | grep -c ' TABLE DATA ')
  if [ "${tables:-0}" -eq 0 ]; then echo "$name: archive unreadable or holds no table data"; rm -f "$part"; return 1; fi
  chmod 600 "$part" && mv "$part" "$out" || { rm -f "$part"; return 1; }
  echo "$name: ok $(stat -c %s "$out") bytes, $tables tables with data, $(basename "$out")"
  # Retention runs only after a good dump, and never removes the one just written.
  find "$tdir" -maxdepth 1 -type f -name "$name-*.dump" ! -newermt "$KEEP_DAYS days ago" ! -path "$out" -print -delete \
    | sed "s|^|$name: pruned |"
  find "$tdir" -maxdepth 1 -type f -name '*.partial' ! -path "$part" -mmin +1440 -delete
  return 0
}

while IFS= read -r -u 3 line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  # Exactly six non-empty tab-separated columns; read alone would merge empty ones.
  if ! awk -F'\t' 'NF != 6 { exit 1 } { for (i = 1; i <= 6; i++) if ($i == "") exit 1 }' <<<"$line"; then
    echo "bad targets line: ${line%%$'\t'*}"; failed=$((failed+1)); continue
  fi
  IFS=$'\t' read -r name host user vault item field <<<"$line"
  if dump_one "$name" "$host" "$user" "$vault" "$item" "$field" </dev/null; then done_n=$((done_n+1)); else failed=$((failed+1)); fi
done 3< "$TARGETS"

echo "dumped $done_n, failed $failed"
[ "$done_n" -gt 0 ] && [ "$failed" -eq 0 ] || exit 1
exit 0
