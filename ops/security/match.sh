#!/usr/bin/env bash
# usage: match.sh [--inventory FILE] [--out-dir DIR] [--date YYYY-MM-DD] [--kev FILE] [--images]
#
# Advisory matcher (hq-8cry.2). Runs the pinned osv-scanner over every lockfile
# and requirements file in the security inventory (inventory.sh), joins the
# CISA KEV catalog (kev.py) and writes $OUT_DIR/findings-YYYY-MM-DD.json with
# id, rig, package, installed, fixed, severity, kev and malicious per finding;
# a finding seen in an earlier findings file keeps its first-seen date.
# Structured feeds only: OSV (through osv-scanner, which also carries the
# OpenSSF malicious-package MAL- records) and the KEV JSON. Never parses prose.
#
# Coverage the scanner cannot match is listed, never dropped: a rig with no
# lockfile lists its unlocked manifests (pyproject.toml, *.csproj, package.json)
# or says it has none; docker-compose image lines, Dockerfile base images and
# hqbox's docker images (dangling <none> images ignored) go under .images.
# --images also scans each local hqbox image with osv-scanner (about 10 s each).
#
# Env: HQ (default ~/hq), OSV_SCANNER (binary, default ~/.local/bin/osv-scanner),
# OSV_SHA256 (expected binary hash; the pin), HQ_SEC_KEV_URL. Exit 0 written,
# 2 usage or the pin does not match, 3 no inventory, 4 written but incomplete
# (a scan failed or the KEV catalog was unavailable). No secret is read or written.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ:-$HOME/hq}"
INV="$HQ/state/security/inventory.json"
OUT_DIR="$HQ/state/security"
DATE="$(date +%F)"
KEV=""
IMAGES=0
# osv-scanner v2.7.0 linux_amd64, checked against the release's SHA256SUMS (hq-wjfzm).
OSV_PIN_VERSION=2.7.0
OSV_SHA256="${OSV_SHA256:-160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b}"
OSV_SCANNER="${OSV_SCANNER:-$HOME/.local/bin/osv-scanner}"
KEV_URL="${HQ_SEC_KEV_URL:-https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json}"

while [ $# -gt 0 ]; do
  case "$1" in
    --inventory) INV="${2:?}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
    --date) DATE="${2:?}"; shift 2 ;;
    --kev) KEV="${2:?}"; shift 2 ;;
    --images) IMAGES=1; shift ;;
    *) sed -n '2p' "$0" >&2; exit 2 ;;
  esac
done
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "match: bad --date $DATE" >&2; exit 2; }
[ -s "$INV" ] || { echo "match: no inventory at $INV (run inventory.sh)" >&2; exit 3; }
[ -x "$OSV_SCANNER" ] || { echo "match: no osv-scanner at $OSV_SCANNER" >&2; exit 2; }
got="$(sha256sum "$OSV_SCANNER" | cut -d' ' -f1)"
if [ "$got" != "$OSV_SHA256" ]; then
  echo "match: $OSV_SCANNER sha256 $got is not the pinned $OSV_SHA256; refusing" >&2; exit 2
fi
mkdir -p "$OUT_DIR"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

# KEV catalog: the given file, else a cache refreshed when older than 20 hours.
# A failed fetch falls back to the stale cache; no catalog at all means kev=false.
if [ -z "$KEV" ]; then
  KEV="$HQ/state/security/kev.json"
  if [ -z "$(find "$KEV" -mmin -1200 2>/dev/null)" ]; then
    if curl -fsS -m 60 -o "$W/kev.json" "$KEV_URL" && jq -e '.vulnerabilities|length>0' "$W/kev.json" >/dev/null 2>&1; then
      mkdir -p "$(dirname "$KEV")"; mv "$W/kev.json" "$KEV"
    else
      echo "match: KEV fetch failed; using $( [ -s "$KEV" ] && echo 'the cached catalog' || echo 'no catalog')" >&2
    fi
  fi
fi

: >"$W/manifest.tsv"
n=0
# scan <rig> <target label> <osv-scanner args...>: exit 0 clean, 1 vulns found,
# 128 no packages in the file; anything else is a scan error on the report.
scan() {
  local rig="$1" target="$2"; shift 2
  n=$((n + 1))
  "$OSV_SCANNER" "$@" --format json >"$W/raw$n.json" 2>"$W/err$n"
  local rc=$?
  case $rc in
    0|1) printf '%s\t%s\t%s\n' "$rig" "$target" "$W/raw$n.json" >>"$W/manifest.tsv" ;;
    128) ;;
    *) jq -n --arg r "$rig" --arg t "$target" --arg d "osv-scanner exit $rc: $(grep -v '^Starting\|^End status\|^Scanned' "$W/err$n" | tail -1 | cut -c1-200)" \
         '{rig:$r, kind:"scan-error", target:$t, detail:$d}' >>"$W/coverage.jsonl" ;;
  esac
}

while IFS=$'\t' read -r rig path file; do
  [ -f "$path/$file" ] || continue
  scan "$rig" "$file" scan source -L "$path/$file"
done < <(jq -r '.rigs[] | .name as $n | .path as $p | (.lockfiles + .requirements)[] | [$n, $p, .] | @tsv' "$INV")

# Rigs without any lockfile: name the manifests that are there, unlocked.
while IFS=$'\t' read -r rig path; do
  mans="$(find "$path" -maxdepth 5 \( -name node_modules -o -name .git -o -name graphify-out -o -name bin -o -name obj \) -prune \
    -o -type f \( -name pyproject.toml -o -name '*.csproj' -o -name package.json -o -name Pipfile -o -name go.mod -o -name Cargo.toml \) -print 2>/dev/null \
    | sed "s|^$path/||" | sort | jq -R . | jq -s .)"
  jq -n --arg r "$rig" --argjson m "$mans" \
    'if ($m|length)>0 then {rig:$r, kind:"unlocked-manifest", manifests:$m, detail:"dependencies declared without a lockfile; versions are not pinned so they cannot be matched"}
     else {rig:$r, kind:"no-manifest", detail:"no lockfile and no dependency manifest"} end' >>"$W/coverage.jsonl"
done < <(jq -r '.rigs[] | select((.lockfiles|length)==0 and (.requirements|length)==0) | [.name, .path] | @tsv' "$INV")

# Images: compose image lines and Dockerfile bases per rig, then hqbox's images.
while IFS=$'\t' read -r rig path; do
  find "$path" -maxdepth 4 \( -name node_modules -o -name .git \) -prune -o -type f \
    \( -name 'docker-compose*.y*ml' -o -name 'compose*.y*ml' \) -print 2>/dev/null | sort | while read -r f; do
    sed -nE 's/^[[:space:]]*image:[[:space:]]*["'\'']?([^"'\''#[:space:]]+).*/\1/p' "$f" \
      | jq -R --arg r "$rig" --arg f "${f#"$path"/}" '{ref:., origin:"compose", rig:$r, file:$f, scanned:false}'
  done
done < <(jq -r '.rigs[] | [.name, .path] | @tsv' "$INV") >>"$W/images.jsonl"
jq -c '.rigs[] | .name as $r | .dockerfiles[] | .dockerfile as $f | .base_images[]
  | {ref:., origin:"dockerfile", rig:$r, file:$f, scanned:false}' "$INV" >>"$W/images.jsonl"
jq -c '.docker_images[] | select(.repository != "<none>" and .tag != "<none>")
  | {ref:(.repository + ":" + .tag), origin:"hqbox", rig:"hqbox", id:.id, scanned:false}' "$INV" >>"$W/images.jsonl"

if [ "$IMAGES" = 1 ]; then
  dk=docker; docker info >/dev/null 2>&1 || dk="sudo -n docker"
  jq -r 'select(.origin=="hqbox") | .ref' "$W/images.jsonl" | sort -u >"$W/host-images"
  while read -r ref; do
    if $dk save "$ref" -o "$W/img.tar" 2>/dev/null; then
      [ -r "$W/img.tar" ] || sudo -n chown "$USER" "$W/img.tar"
      scan hqbox "image $ref" scan image --archive "$W/img.tar"
      echo "$ref" >>"$W/scanned"
    else
      jq -n --arg t "image $ref" '{rig:"hqbox", kind:"scan-error", target:$t, detail:"docker save failed"}' >>"$W/coverage.jsonl"
    fi
    rm -f "$W/img.tar"
  done <"$W/host-images"
fi
touch "$W/scanned"

ver="$("$OSV_SCANNER" --version 2>/dev/null | sed -n 's/^osv-scanner version: //p')"
jq -s --slurpfile c <(cat "$W/coverage.jsonl" 2>/dev/null) --rawfile s "$W/scanned" \
  --arg v "$ver" --arg pin "$OSV_PIN_VERSION" --arg sha "$OSV_SHA256" '{
    scanner:{name:"osv-scanner", version:$v, pinned:$pin, sha256:$sha},
    coverage:$c,
    images:(unique_by([.origin, .rig, .file, .ref]) | map(.ref as $r | if .origin=="hqbox" and ($s|split("\n")|index($r)) != null then .scanned=true else . end))
  }' "$W/images.jsonl" >"$W/extra.json"

OUT="$OUT_DIR/findings-$DATE.json"
python3 "$HERE/kev.py" --manifest "$W/manifest.tsv" --kev "$KEV" --extra "$W/extra.json" \
  --prev-dir "$OUT_DIR" --date "$DATE" --out "$OUT" || { echo "match: join failed" >&2; exit 1; }
jq -r --arg o "$OUT" '"match: \(.summary.findings) findings (\(.summary.by_severity.CRITICAL) critical, \(.summary.by_severity.HIGH) high, \(.summary.kev) kev, \(.summary.malicious) malicious), \(.coverage|length) coverage notes, \(.images|length) images -> \($o)"' "$OUT"
if [ "$(jq -r '.summary.scan_errors > 0 or (.summary.kev_available | not)' "$OUT")" = true ]; then
  echo "match: INCOMPLETE ($(jq -r '"\(.summary.scan_errors) scan errors, kev catalog \(if .summary.kev_available then "ok" else "unavailable" end)"' "$OUT"))" >&2
  exit 4
fi
