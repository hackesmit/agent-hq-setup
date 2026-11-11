#!/usr/bin/env bash
# Fixture test for hq-db-dump.sh: a dump that errors, is empty or holds no
# table data leaves no file and fails the run; good dumps are 0600 in a 0700
# dir; retention keeps 14 days and only prunes after a good dump.
# HQ_DB_DUMP_LIVE=1 adds one real pg_dump against the lodgeco pooler with a
# wrong password (one failed login, nothing read).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../hq-db-dump.sh"
FIX="$HERE/fixtures"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

# pp: item "good" knows the right password, "bad" a wrong one, "missing" fails.
cat >"$T/bin/pp" <<'EOF'
#!/bin/bash
item=""; while [ $# -gt 0 ]; do [ "$1" = --item-title ] && item="$2"; shift; done
case "$item" in good) echo rightpw ;; bad) echo wrongpw ;; *) echo "no such item" >&2; exit 1 ;; esac
EOF
# pg_dump: refuses a wrong password; the user picks what it writes.
cat >"$T/bin/pg_dump" <<EOF
#!/bin/bash
f=""; conn=""; for a in "\$@"; do case "\$a" in --file=*) f="\${a#--file=}" ;; host=*) conn="\$a" ;; esac; done
[ "\$PGPASSWORD" = rightpw ] || { echo "FATAL: password authentication failed" >&2; exit 1; }
case "\$conn" in
  *user=empty*) : >"\$f" ;;
  *user=schema*) cp "$FIX/schema-only.dump" "\$f" ;;
  *user=junk*) echo "not an archive" >"\$f" ;;
  *) cp "$FIX/tiny.dump" "\$f" ;;
esac
EOF
chmod +x "$T/bin/pp" "$T/bin/pg_dump"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
row() { printf '%s\thost.invalid\t%s\tV\t%s\tpassword\n' "$1" "$2" "$3"; }
run() { # run <targets file> -> sets rc, out
  out=$(HQ_DB_DUMP_DIR="$T/dumps" HQ_DB_DUMP_TARGETS="$1" HQ_PP="$T/bin/pp" HQ_PG_DUMP="$T/bin/pg_dump" bash "$SCRIPT" 2>&1); rc=$?
}
count() { find "$T/dumps/$1" -maxdepth 1 -name "$1-*.dump" 2>/dev/null | wc -l; }

# 1: good target
{ echo "# comment"; row alpha u good; } >"$T/t1"
run "$T/t1"
check "good: exit 0" "$rc" 0
check "good: one dump" "$(count alpha)" 1
check "good: file 0600" "$(stat -c %a "$(find "$T/dumps/alpha" -name '*.dump' | head -1)")" 600
check "good: dirs 0700" "$(stat -c %a "$T/dumps")$(stat -c %a "$T/dumps/alpha")" 700700
check "good: no partial" "$(find "$T/dumps" -name '*.partial' | wc -l)" 0
check "good: password never printed" "$(grep -c rightpw <<<"$out")" 0

# 2: bad password fails the run, the good target is still dumped
rm -rf "$T/dumps"; { row alpha u good; row beta u bad; } >"$T/t2"
run "$T/t2"
check "bad password: exit 1" "$rc" 1
check "bad password: no dump for it" "$(count beta)" 0
check "bad password: other target dumped" "$(count alpha)" 1
check "bad password: reported" "$(grep -c 'beta: pg_dump exit' <<<"$out")" 1

# 3: missing Proton Pass item
rm -rf "$T/dumps"; row gamma u missing >"$T/t3"
run "$T/t3"
check "missing item: exit 1" "$rc" 1
check "missing item: reported" "$(grep -c 'gamma: password lookup failed' <<<"$out")" 1

# 4-6: empty file, schema without data, junk
for kind in empty schema junk; do
  rm -rf "$T/dumps"; row "d$kind" "$kind" good >"$T/t4"
  run "$T/t4"
  check "$kind: exit 1" "$rc" 1
  check "$kind: no dump left" "$(find "$T/dumps" -type f | wc -l)" 0
done

# 7: retention keeps 14 days, prunes older, a failed run prunes nothing
rm -rf "$T/dumps"; mkdir -p "$T/dumps/alpha"
touch -d '15 days ago' "$T/dumps/alpha/alpha-old.dump"
touch -d '13 days ago' "$T/dumps/alpha/alpha-recent.dump"
row alpha empty good >"$T/t7"; run "$T/t7"
check "retention: failed run prunes nothing" "$(count alpha)" 2
row alpha u good >"$T/t7"; run "$T/t7"
check "retention: exit 0" "$rc" 0
check "retention: 15-day dump pruned" "$([ -f "$T/dumps/alpha/alpha-old.dump" ] && echo kept || echo gone)" gone
check "retention: 13-day dump kept" "$([ -f "$T/dumps/alpha/alpha-recent.dump" ] && echo kept || echo gone)" kept
check "retention: new dump kept" "$(count alpha)" 2

# 8b: a last line without a newline is still dumped; an empty column fails
rm -rf "$T/dumps"; printf 'alpha\thost.invalid\tu\tV\tgood\tpassword' >"$T/t8b"; run "$T/t8b"
check "no final newline: exit 0" "$rc" 0
check "no final newline: dumped" "$(count alpha)" 1
rm -rf "$T/dumps"; printf 'beta\thost.invalid\t\tV\tgood\tpassword\n' >"$T/t8c"; run "$T/t8c"
check "empty column: exit 1" "$rc" 1
check "empty column: reported" "$(grep -c 'bad targets line: beta' <<<"$out")" 1

# 8: no targets at all is a failure, not a quiet success
rm -rf "$T/dumps"; echo "# nothing" >"$T/t8"; run "$T/t8"
check "no targets: exit 1" "$rc" 1

# 9 (opt-in): real pg_dump, real pooler, wrong password
if [ "${HQ_DB_DUMP_LIVE:-0}" = 1 ]; then
  rm -rf "$T/dumps"
  printf 'live\taws-0-us-east-1.pooler.supabase.com\tpostgres.exampleprojectrefccc\tV\tbad\tpassword\n' >"$T/t9"
  out=$(HQ_DB_DUMP_DIR="$T/dumps" HQ_DB_DUMP_TARGETS="$T/t9" HQ_PP="$T/bin/pp" bash "$SCRIPT" 2>&1); rc=$?
  check "live bad password: exit 1" "$rc" 1
  check "live bad password: no dump" "$(find "$T/dumps" -type f | wc -l)" 0
  check "live bad password: auth refused" "$(grep -ciE 'password authentication failed|authentication' <<<"$out" | head -1 | sed 's/^[1-9][0-9]*$/yes/')" yes
fi

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
