#!/usr/bin/env bash
# usage: inventory.sh [--out FILE]
#
# Security inventory (hq-8cry.1): one JSON listing every dependency manifest
# osv-scanner and the advisory matcher need. Covers each rig's main checkout
# (a directory whose .git is a directory; never -xxxx worktrees, never the
# wr-vs-db symlink), its lockfiles, requirements files and Dockerfile base
# images, plus the docker images pinned on hqbox and the dpkg packages.
# A rig with no lockfile at all is recorded under .findings, never invented.
# Reads versions and paths only; no secret is read or written.
# Env: HQ (default ~/hq), HQ_INV_NO_HOST=1 skips the docker and dpkg sections.
set -uo pipefail
HQ="${HQ:-$HOME/hq}"
OUT="$HQ/state/security/inventory.json"
[ "${1:-}" = "--out" ] && OUT="${2:?--out needs a file}"
mkdir -p "$(dirname "$OUT")"

LOCKS='package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb poetry.lock Pipfile.lock uv.lock go.sum Cargo.lock composer.lock Gemfile.lock'

# rig_files <dir> <find -name args...>: relative paths, skipping vendored trees.
rig_files() {
  local d="$1"; shift
  find "$d" -maxdepth 5 \( -name node_modules -o -name .git -o -name graphify-out \
    -o -name .venv -o -name venv -o -name vendor -o -name dist -o -name .claude \) -prune \
    -o -type f \( "$@" \) -print 2>/dev/null | sed "s|^$d/||" | sort
}

lock_args() {
  local first=1 n
  for n in $LOCKS; do
    [ $first = 1 ] || printf '%s\n' -o
    printf '%s\n' -name "$n"; first=0
  done
}

rigs_json='[]'
for d in "$HQ"/rigs/*/; do
  d="${d%/}"; name="$(basename "$d")"
  [ -L "$d" ] && continue
  [ -d "$d/.git" ] || continue
  mapfile -t largs < <(lock_args)
  locks="$(rig_files "$d" "${largs[@]}" | jq -R . | jq -s .)"
  reqs="$(rig_files "$d" -name 'requirements*.txt' | jq -R . | jq -s .)"
  dfs="$(rig_files "$d" -name 'Dockerfile*' -o -name '*.Dockerfile')"
  images='[]'
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # FROM [--platform=x] image [AS stage]; drop scratch and earlier stage aliases.
    imgs="$(awk '
      toupper($1)=="FROM" {
        i=2; while ($i ~ /^--/) i++
        img=$i; if (tolower($(i+1))=="as") stage[tolower($(i+2))]=1
        if (img!="scratch" && !(tolower(img) in stage)) print img
        if (tolower($(i+1))=="as") stage[tolower($(i+2))]=1
      }' "$d/$f" | jq -R . | jq -s .)"
    images="$(jq -n --argjson a "$images" --arg f "$f" --argjson i "$imgs" '$a + [{dockerfile:$f, base_images:$i}]')"
  done <<<"$dfs"
  rigs_json="$(jq -n --argjson r "$rigs_json" --arg n "$name" --arg p "$d" \
    --argjson l "$locks" --argjson q "$reqs" --argjson i "$images" \
    '$r + [{name:$n, path:$p, lockfiles:$l, requirements:$q, dockerfiles:$i}]')"
done

docker_json='[]'; dpkg_json='[]'
if [ "${HQ_INV_NO_HOST:-0}" != 1 ]; then
  dk=docker; docker info >/dev/null 2>&1 || dk="sudo -n docker"
  docker_json="$($dk images --no-trunc --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Digest}}' 2>/dev/null \
    | jq -R -s 'split("\n") | map(select(length>0) | split("\t")
        | {repository:.[0], tag:.[1], id:.[2], digest:.[3]})' 2>/dev/null)"
  [ -n "$docker_json" ] || docker_json='[]'
  dpkg_json="$(dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' 2>/dev/null \
    | jq -R -s 'split("\n") | map(select(length>0) | split("\t")
        | {name:.[0], version:.[1], arch:.[2]})' 2>/dev/null)"
  [ -n "$dpkg_json" ] || dpkg_json='[]'
fi

tmp="$(mktemp "$OUT.XXXXXX")"
jq -n --argjson rigs "$rigs_json" --argjson docker "$docker_json" --argjson dpkg "$dpkg_json" \
  --arg at "$(date -u +%FT%TZ)" '{
    generated_at:$at,
    rigs:$rigs,
    docker_images:$docker,
    dpkg_packages:$dpkg,
    findings:[ $rigs[] | select((.lockfiles|length)==0 and (.requirements|length)==0)
      | {rig:.name, kind:"no-lockfile", detail:"no lockfile or requirements file found"} ]
  }' >"$tmp" && mv "$tmp" "$OUT"
echo "inventory: $(jq '.rigs|length' "$OUT") rigs, $(jq '.docker_images|length' "$OUT") images, $(jq '.dpkg_packages|length' "$OUT") dpkg, $(jq '.findings|length' "$OUT") findings -> $OUT"
