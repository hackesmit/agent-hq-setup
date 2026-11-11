#!/usr/bin/env bash
# restore-drill.sh <name> [snapshot] | --local <file>: restore the newest dump of one database
# from the hqbox restic repository into a throwaway local Postgres 17 (docker)
# and compare row counts table by table (hq-pgbpq.2). Never touches prod.
# Run as root (the restic password file and docker need it):
#   sudo ops/services/db-dumps/restore-drill.sh lodgeco-system
# Expected counts come from the dump itself (lines of each COPY block), so a
# match proves the file in restic restores whole. Prints counts, never rows.
# --local skips restic and drills a dump file already on disk.
# Exit 0 when every table with data restored with the same count.
set -uo pipefail
NAME="${1:?usage: restore-drill.sh <name> [snapshot]}"; SNAP="${2:-latest}"
DUMPS="${HQ_DB_DUMP_DIR:-/home/owner/backups/supabase}"
PGBIN=/usr/lib/postgresql/17/bin
PORT="${HQ_DRILL_PORT:-55433}"; CTR="hq-restore-drill-$$"
KEY=/home/owner/.ssh/id_ed25519_george
export RESTIC_REPOSITORY="sftp:owner@george:/C:/Users/owner/Backups/hqbox-restic"
export RESTIC_PASSWORD_FILE=/etc/restic/hqbox.pass
export RESTIC_CACHE_DIR=/var/cache/restic
RESTIC=(restic -o "sftp.command=ssh -i $KEY -o UserKnownHostsFile=/home/owner/.ssh/known_hosts -o BatchMode=yes -o ConnectTimeout=8 owner@george -s sftp")
T="$(mktemp -d)"
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT

if [ "$NAME" = --local ]; then
  dump="$SNAP"; [ -s "$dump" ] || { echo "no such dump: $dump"; exit 1; }
else
  # Resolve the snapshot once, so listing and restoring use the same one even
  # if a backup lands meanwhile.
  snapid=$("${RESTIC[@]}" snapshots --json "$SNAP" 2>/dev/null | jq -r '.[-1].id // empty')
  [ -n "$snapid" ] || { echo "no snapshot $SNAP"; exit 1; }
  file=$("${RESTIC[@]}" ls --json "$snapid" "$DUMPS/$NAME" 2>/dev/null \
    | jq -r 'select(.struct_type=="node" and .type=="file") | .path' | grep -E '\.dump$' | sort | tail -1)
  [ -n "$file" ] || { echo "no dump of $NAME in snapshot $snapid"; exit 1; }
  echo "snapshot ${snapid:0:8}: $file"
  "${RESTIC[@]}" restore "$snapid" --target "$T/r" --include "$file" >/dev/null || { echo "restic restore failed"; exit 1; }
  dump="$T/r$file"; [ -s "$dump" ] || { echo "restored file missing or empty"; exit 1; }
  echo "restored $(stat -c %s "$dump") bytes"
fi

# Expected: rows in each COPY block of the archive. The table name is the
# COPY header up to the column list, read quote-aware (pg_dump already quotes
# names that need it, so the name is used as is in the count query).
"$PGBIN/pg_restore" --data-only -f - "$dump" | python3 -I -c '
import sys
t = None; n = 0
def name(h):
    q = False
    for i, ch in enumerate(h):
        if ch == "\"": q = not q
        elif not q and (h.startswith(" (", i) or h.startswith(" FROM stdin;", i)): return h[:i]
    sys.exit("cannot parse COPY header: " + h[:80])
for line in sys.stdin.buffer:
    line = line.decode("utf-8", "replace").rstrip("\n")
    if t is None:
        if line.startswith("COPY "): t = name(line[5:]); n = 0
    elif line == "\\.": print(f"{t}\t{n}"); t = None
    else: n += 1
if t is not None: sys.exit("archive ends inside the COPY block of " + t)
' | sort >"$T/expected.tsv"
st=("${PIPESTATUS[@]}")
[ "${st[0]}" = 0 ] && [ "${st[1]}" = 0 ] || { echo "reading the dump data failed (pg_restore ${st[0]}, parser ${st[1]})"; exit 1; }
# Every TABLE DATA entry in the archive's table of contents must be counted.
toc=$("$PGBIN/pg_restore" --list "$dump" | grep -c ' TABLE DATA ')
got_n=$(wc -l <"$T/expected.tsv")
[ "$toc" = "$got_n" ] || { echo "dump lists $toc tables with data but $got_n COPY blocks were read"; exit 1; }

docker run -d --rm --name "$CTR" -e POSTGRES_PASSWORD=drill -p "127.0.0.1:$PORT:5432" postgres:17 >/dev/null || exit 1
export PGPASSWORD=drill
for _ in $(seq 60); do "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
# Supabase roles, so owner and grant statements do not hide real errors.
for r in anon authenticated service_role authenticator supabase_admin supabase_auth_admin \
         supabase_storage_admin supabase_realtime_admin dashboard_user pgbouncer; do
  "$PGBIN/psql" -q -h 127.0.0.1 -p "$PORT" -U postgres -c "create role $r" >/dev/null 2>&1
done
# Supabase-only extensions, functions and policies do not exist in stock
# Postgres, so pg_restore errors are reported but do not decide the drill: the
# row count of every TABLE DATA entry in the archive does. A table that failed
# to create or load shows as missing or a mismatch below.
"$PGBIN/pg_restore" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres --no-owner --no-privileges "$dump" \
  >"$T/restore.log" 2>&1
echo "pg_restore reported $(grep -c '^pg_restore: error' "$T/restore.log") errors (first 5):"
grep '^pg_restore: error' "$T/restore.log" | cut -c1-160 | head -5

# A table the stock image cannot create (it needs a Supabase-only extension,
# such as vault.secrets from supabase_vault) is not a failure when the dump
# holds 0 rows for it: no data is lost. With rows in it, it fails the drill.
bad=0; n=0; skipped=0
printf '%-55s %10s %10s\n' table dump restored
while IFS=$'\t' read -r t want; do
  got=$("$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -Atc "select count(*) from only $t" 2>/dev/null) || got=missing
  n=$((n+1)); mark=""
  if [ "$got" = missing ] && [ "$want" = 0 ]; then mark="  empty, not created"; skipped=$((skipped+1))
  elif [ "$got" != "$want" ]; then mark="  MISMATCH"; bad=$((bad+1)); fi
  printf '%-55s %10s %10s%s\n' "$t" "$want" "$got" "$mark"
done <"$T/expected.tsv"
echo "tables $n, mismatches $bad, empty and not created $skipped"
[ "$n" -gt "$skipped" ] && [ "$bad" -eq 0 ]
