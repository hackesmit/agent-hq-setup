#!/usr/bin/env bash
# Fixture test for coverage-check.sh: restic itself decides what the excludes
# drop, so glob, relative and bare excludes that skip any file fail; so do
# missing paths, symlinks, nested mounts and missing or empty lists.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; CC="$HERE/../coverage-check.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
rc() { bash "$CC" "$@" >"$T/out" 2>&1; echo $?; }

H="$T/home"; mkdir -p "$H/a/backups/supabase/x" "$H/a/state/node_modules" "$H/a/.cache" "$H/b"
echo d >"$H/a/backups/supabase/x/x-1.dump"; echo s >"$H/a/state/s.json"; echo n >"$H/a/state/node_modules/m.js"
echo "$H" >"$T/inc"; printf '%s\n%s\n' "$H/a/backups/supabase" "$H/a/state" >"$T/req"
ex() { printf '%s\n' "$@" >"$T/exc"; }

ex "$H/a/.cache" "node_modules";                 check "covered paths pass" "$(rc "$T/inc" "$T/exc" "$T/req")" 0
check "pass says all files saved" "$(grep -c 'restic saves all' "$T/out")" 2
mkdir -p "$H/a/state/venv"; echo v >"$H/a/state/venv/lib.py"
printf 'Signature: 8a477f597d28d172789f06886806bc55\n' >"$H/a/state/venv/CACHEDIR.TAG"
ex "$H/a/.cache";                                check "cache-tagged dir is a note, not a gap" "$(rc "$T/inc" "$T/exc" "$T/req")" 0
check "cache-tagged dir is reported" "$(grep -c 'cache-tagged' "$T/out")" 1
rm -rf "$H/a/state/venv"
ex "$H/**/*.dump";                               check "absolute glob exclude fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "$H/a/backups/*/*/*.dump";                    check "glob before the files fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "supabase/*/*.dump";                          check "relative pattern with a slash fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "*.dump";                                     check "bare pattern on files inside fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "$H/a/backups/supabase/x";                    check "absolute child exclude fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "$H/a";                                       check "excluded parent fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "state";                                      check "excluded component fails" "$(rc "$T/inc" "$T/exc" "$T/req")" 1
ex "# none"
echo "/elsewhere/x" >"$T/req2";                  check "path outside includes fails" "$(rc "$T/inc" "$T/exc" "$T/req2")" 1
echo "${H}2/a" >"$T/req2";                       check "prefix is not a parent" "$(rc "$T/inc" "$T/exc" "$T/req2")" 1
echo "$H/a/nope" >"$T/req2";                     check "missing required path fails" "$(rc "$T/inc" "$T/exc" "$T/req2")" 1
ln -s "$T/home/b" "$H/a/linked"; echo "$H/a/linked" >"$T/req2"
check "symlinked required path fails" "$(rc "$T/inc" "$T/exc" "$T/req2")" 1
mkdir -p "$H/b/sub"; ln -s "$H/b" "$H/blink"; echo "$H/blink/sub" >"$T/req2"
check "symlinked parent fails" "$(rc "$T/inc" "$T/exc" "$T/req2")" 1
mkdir -p "$T/real/state"; echo r >"$T/real/state/data"; ln -s "$T/real" "$T/rlink"
echo "$T/rlink" >"$T/inc4"; echo "$T/rlink/state" >"$T/req2"
check "symlinked include root fails" "$(rc "$T/inc4" "$T/exc" "$T/req2")" 1
echo "$T/rlink/state" >"$T/inc4"
check "symlink above the include root fails" "$(rc "$T/inc4" "$T/exc" "$T/req2")" 1
# A real mount point inside a required path: the first mount whose parent
# directory sits on the root filesystem (/boot, /snap/..., /home if separate).
m=""; rootdev=$(stat -c %d /)
while read -r t; do
  par="${t%/*}"; [ -n "$par" ] && [ "$(stat -c %d "$par" 2>/dev/null)" = "$rootdev" ] && { m="$t"; break; }
done < <(findmnt -rn -o TARGET | grep -v '^/$')
if [ -n "$m" ]; then
  echo "/" >"$T/inc2"; echo "${m%/*}" >"$T/req2"
  bash "$CC" "$T/inc2" "$T/exc" "$T/req2" >"$T/out" 2>&1
  check "mount point inside fails" "$(grep -c 'mounted inside it' "$T/out")" 1
fi
check "missing required file fails" "$(rc "$T/inc" "$T/exc" "$T/nope")" 1
check "missing exclude file fails" "$(rc "$T/inc" "$T/nope" "$T/req")" 1
printf '# only a comment\n' >"$T/empty"
check "empty required list fails" "$(rc "$T/inc" "$T/exc" "$T/empty")" 1
check "empty include list fails" "$(rc "$T/empty" "$T/exc" "$T/req")" 1
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
