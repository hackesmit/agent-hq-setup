#!/usr/bin/env bash
# match.sh + kev.py (hq-8cry.2): a hermetic run with a fake scanner and a
# fixture KEV catalog checks the join, dedupe, first-seen, pin, compose images,
# dangling images and unlocked manifests; then one live run of the pinned
# osv-scanner on a fixture lockfile with a known vulnerable lodash.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
eq()  { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (want '$1', got '$2')"; fi; }

R="$T/rigs"; mkdir -p "$R/alpha/web" "$R/peel/engine" "$R/bare" "$T/out"
echo '{}' >"$R/alpha/package-lock.json"
echo '{}' >"$R/alpha/web/package-lock.json"
printf 'services:\n  db:\n    image: postgres:17\n  cache:\n    image: "redis:7-alpine" # pinned\n' >"$R/alpha/docker-compose.yml"
echo '[project]' >"$R/peel/engine/pyproject.toml"
echo '<Project/>' >"$R/peel/engine/App.csproj"

cat >"$T/inv.json" <<EOF
{"rigs":[
 {"name":"alpha","path":"$R/alpha","lockfiles":["package-lock.json","web/package-lock.json"],"requirements":[],
  "dockerfiles":[{"dockerfile":"Dockerfile","base_images":["node:20-alpine"]}]},
 {"name":"peel","path":"$R/peel","lockfiles":[],"requirements":[],"dockerfiles":[]},
 {"name":"bare","path":"$R/bare","lockfiles":[],"requirements":[],"dockerfiles":[]}],
 "docker_images":[{"repository":"nginx","tag":"1.27","id":"sha256:a","digest":""},
                  {"repository":"<none>","tag":"<none>","id":"sha256:b","digest":""}],
 "findings":[]}
EOF

# Fake scanner: both alpha lockfiles hold the same vulnerable next (one finding,
# two sources) plus a MAL- record; the CVE alias is in the fixture KEV.
cat >"$T/osv" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "osv-scanner version: 2.7.0"; exit 0; }
cat <<'J'
{"results":[{"source":{"path":"x","type":"lockfile"},"packages":[
 {"package":{"name":"next","version":"14.2.5","ecosystem":"npm"},
  "vulnerabilities":[{"id":"GHSA-aaaa-bbbb-cccc","aliases":["CVE-2099-0001"],
    "database_specific":{"severity":"CRITICAL"},
    "affected":[{"package":{"ecosystem":"npm","name":"next"},
      "ranges":[{"type":"SEMVER","events":[{"introduced":"13.0.0"},{"fixed":"14.2.10"}]},
                {"type":"SEMVER","events":[{"introduced":"15.0.0"},{"fixed":"15.1.2"}]}]}]}],
  "groups":[{"ids":["GHSA-aaaa-bbbb-cccc"],"aliases":["CVE-2099-0001","GHSA-aaaa-bbbb-cccc"],"max_severity":"9.8"}]},
 {"package":{"name":"evil-pkg","version":"1.0.0","ecosystem":"npm"},
  "vulnerabilities":[{"id":"MAL-2099-1","affected":[{"package":{"ecosystem":"npm","name":"evil-pkg"},"versions":["1.0.0"]}]}],
  "groups":[{"ids":["MAL-2099-1"],"aliases":["MAL-2099-1"],"max_severity":""}]}]}]}
J
exit 1
EOF
chmod +x "$T/osv"
echo '{"catalogVersion":"t","dateReleased":"t","vulnerabilities":[{"cveID":"CVE-2099-0001","dateAdded":"2099-01-02"}]}' >"$T/kev.json"
# An earlier day saw next under the same advisory at another version.
echo '{"findings":[{"id":"GHSA-aaaa-bbbb-cccc","rig":"alpha","ecosystem":"npm","package":"next","installed":"14.2.3","first_seen":"2026-10-01"}]}' \
  >"$T/out/findings-2026-10-01.json"

SHA="$(sha256sum "$T/osv" | cut -d' ' -f1)"
run() { HQ="$T" OSV_SCANNER="$T/osv" OSV_SHA256="$SHA" bash "$REPO/ops/security/match.sh" \
  --inventory "$T/inv.json" --out-dir "$T/out" --kev "$T/kev.json" "$@"; }
run --date 2026-10-28 >/dev/null 2>"$T/err"; eq 0 "$?" "exit 0"
F="$T/out/findings-2026-10-28.json"
jq empty "$F" 2>/dev/null; eq 0 "$?" "valid json"
nx='.findings[]|select(.package=="next")'
eq 1 "$(jq "[$nx]|length" "$F")" "same advisory in two lockfiles of one rig is one finding"
eq '["package-lock.json","web/package-lock.json"]' "$(jq -c "$nx|.sources" "$F")" "both lockfiles kept as sources"
eq 'GHSA-aaaa-bbbb-cccc|alpha|next|14.2.5|14.2.10|CRITICAL|true|false' \
  "$(jq -r "$nx|[.id,.rig,.package,.installed,.fixed,.severity,.kev,.malicious]|map(tostring)|join(\"|\")" "$F")" \
  "fields: id rig package installed fixed severity kev malicious"
eq "2026-10-01" "$(jq -r "$nx|.first_seen" "$F")" "first-seen kept from an earlier findings file"
eq "true" "$(jq -r '.findings[]|select(.package=="evil-pkg")|.malicious' "$F")" "MAL- record flagged malicious"
eq "2026-10-28" "$(jq -r '.findings[]|select(.package=="evil-pkg")|.first_seen' "$F")" "new finding first seen today"
eq "evil-pkg" "$(jq -r '.findings[0].package' "$F")" "malicious sorts first"
eq '["postgres:17","redis:7-alpine"]' "$(jq -c '[.images[]|select(.origin=="compose")|.ref]|sort' "$F")" "compose image lines read"
eq '["node:20-alpine"]' "$(jq -c '[.images[]|select(.origin=="dockerfile")|.ref]' "$F")" "Dockerfile base images listed"
eq '["nginx:1.27"]' "$(jq -c '[.images[]|select(.origin=="hqbox")|.ref]' "$F")" "dangling hqbox image ignored"
eq '["engine/App.csproj","engine/pyproject.toml"]' \
  "$(jq -c '.coverage[]|select(.rig=="peel")|.manifests' "$F")" "no-lockfile rig lists unlocked pyproject and csproj"
eq "unlocked-manifest no-manifest" "$(jq -r '[.coverage[]|select(.rig=="peel" or .rig=="bare")|.kind]|join(" ")' "$F")" "coverage kinds"

# A rerun the next day keeps the date; a scanner that is not the pinned one is refused.
run --date 2026-10-29 >/dev/null 2>&1
eq "2026-10-28" "$(jq -r '.findings[]|select(.package=="evil-pkg")|.first_seen' "$T/out/findings-2026-10-29.json")" "first-seen survives the next run"
HQ="$T" OSV_SCANNER="$T/osv" OSV_SHA256=0000 bash "$REPO/ops/security/match.sh" --inventory "$T/inv.json" \
  --out-dir "$T/out" --kev "$T/kev.json" --date 2026-10-30 >/dev/null 2>&1
eq 2 "$?" "unpinned scanner refused"
[ -e "$T/out/findings-2026-10-30.json" ] && bad "refused run wrote nothing" || ok "refused run wrote nothing"

# An incomplete run must never read as all clear: a failed scan or a missing
# KEV catalog exits 4 and says so in the summary.
printf '#!/usr/bin/env bash\n[ "$1" = "--version" ] && { echo "osv-scanner version: 2.7.0"; exit 0; }\necho "lookup api.osv.dev: no such host" >&2; exit 127\n' >"$T/osv-down"; chmod +x "$T/osv-down"
HQ="$T" OSV_SCANNER="$T/osv-down" OSV_SHA256="$(sha256sum "$T/osv-down" | cut -d' ' -f1)" bash "$REPO/ops/security/match.sh" \
  --inventory "$T/inv.json" --out-dir "$T/out" --kev "$T/kev.json" --date 2026-10-31 >/dev/null 2>&1
eq 4 "$?" "network down exits 4"
eq true "$(jq '.summary.scan_errors > 0' "$T/out/findings-2026-10-31.json")" "network down counts scan errors"
run --kev "$T/no-such-kev.json" --date 2026-11-01 >/dev/null 2>&1
eq 4 "$?" "missing KEV catalog exits 4"
eq '[false,[null]]' "$(jq -c '[.summary.kev_available, ([.findings[].kev]|unique)]' "$T/out/findings-2026-11-01.json")" "missing KEV catalog marks kev unknown"

# Live: the pinned osv-scanner against a lockfile with lodash 4.17.20 (CVE-2021-23337).
if [ -x "$HOME/.local/bin/osv-scanner" ]; then
  L="$T/live"; mkdir -p "$L/rig" "$L/out"
  cat >"$L/rig/package-lock.json" <<'EOF'
{"name":"f","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{
 "":{"name":"f","version":"1.0.0","dependencies":{"lodash":"4.17.20"}},
 "node_modules/lodash":{"version":"4.17.20","resolved":"https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"}}}
EOF
  echo "{\"rigs\":[{\"name\":\"fixture\",\"path\":\"$L/rig\",\"lockfiles\":[\"package-lock.json\"],\"requirements\":[],\"dockerfiles\":[]}],\"docker_images\":[],\"findings\":[]}" >"$L/inv.json"
  HQ="$T" bash "$REPO/ops/security/match.sh" --inventory "$L/inv.json" --out-dir "$L/out" --kev "$T/kev.json" --date 2026-10-28 >/dev/null 2>"$L/err"
  eq 0 "$?" "live: pinned osv-scanner run exits 0"
  jq -e '.findings[]|select(.package=="lodash" and .installed=="4.17.20" and (.aliases+[.id]|index("CVE-2021-23337")))' \
    "$L/out/findings-2026-10-28.json" >/dev/null && ok "live: lodash CVE-2021-23337 found" || bad "live: lodash CVE-2021-23337 found ($(tail -2 "$L/err"))"
else
  bad "live: pinned osv-scanner missing at ~/.local/bin/osv-scanner"
fi

k="$(jq -r '.. | strings' "$F" | grep -ciE 'password|secret|token|api[_-]?key')"; eq 0 "$k" "no secret-looking strings"
if grep -q $'\xe2\x80\x94' "$REPO/ops/security/match.sh" "$REPO/ops/security/kev.py" "$0"; then bad "no em dash"; else ok "no em dash"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
