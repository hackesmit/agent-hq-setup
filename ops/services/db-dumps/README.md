# Nightly Supabase dumps

`hq-db-dump.timer` (user unit, 09:10 UTC) runs `~/.local/bin/hq-db-dump`,
which takes a read-only `pg_dump --format=custom` of every production database
in `targets.tsv` and writes `~/backups/supabase/<name>/<name>-<UTC stamp>.dump`
(files 0600, dirs 0700, outside git). Passwords come from Proton Pass at run
time; `targets.tsv` holds item names only. Dumps older than 14 days are deleted
after a good dump. pg_dump is the PGDG `postgresql-client-17` build because the
Supabase servers run Postgres 17.

Fail-closed: a failed password lookup, a pg_dump error, an empty file or an
archive with no table data leaves no file, the run exits 1, and OnFailure=
pages through failure-notify.

`~/backups` is under `/home/owner`, which the hqbox restic backup includes
(`ops/services/restic-backup/required.txt`), so each dump is in a George
snapshot within a day (the backup runs once a day when George is awake).

acme-avance is about 7.7 GB live (fact_ventas and staging_fact), so its dump
is the long one; the unit allows two hours.

## Install or update (from the main checkout, after merge)

```
~/hq/ops/services/db-dumps/install.sh
~/hq/ops/services/failure-notify/install.sh      # wires OnFailure=
```

## Use

```
systemctl --user start hq-db-dump.service        # dump now
journalctl --user -u hq-db-dump -n 30
bash ops/services/db-dumps/tests/hq-db-dump.test.sh          # fixtures
HQ_DB_DUMP_LIVE=1 bash ops/services/db-dumps/tests/hq-db-dump.test.sh   # plus one real bad-password login
```

## Restore drill

`sudo ops/services/db-dumps/restore-drill.sh <name>` restores the newest dump
of one database from the restic repository into a throwaway `postgres:17`
container and compares each table's row count with the rows in the dump. It
never connects to production. `--local <file>` drills a file on disk instead.
To restore for real, use `pg_restore --no-owner` against a new database, never
over production without the owner.
