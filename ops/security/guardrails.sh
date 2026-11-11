#!/usr/bin/env bash
# guardrails.sh (hq-8cry.4): npm, uv and pip supply-chain guardrails for hqbox.
#
# The August 2026 npm worm ran from a postinstall script and planted Claude
# Code and VS Code hooks. Two npm settings close that door for every npm on
# this box (they live in the user config, so nvm and /usr/bin npm share them):
#   ignore-scripts=true   no dependency lifecycle script runs on install
#   min-release-age=7     npm only resolves versions published 7+ days ago,
#                         so a hijacked release is usually yanked before we see it
# hq-pgbpq.3 gives Python the same 7-day cooldown (LiteLLM 1.107.0 was live on
# PyPI for under two hours on 2026-10-21), in the user configs every uv and
# every pip (venv pips too) reads:
#   ~/.config/uv/uv.toml    exclude-newer = "7 days"   (uv 0.9.17+)
#   ~/.config/pip/pip.conf  [global] uploaded-prior-to = P7D   (pip 26.1+)
#
# usage:
#   guardrails.sh apply          write the managed blocks into ~/.npmrc, uv.toml
#                                and pip.conf (idempotent)
#   guardrails.sh check          every npm on PATH honors both settings, every uv
#                                on PATH resolves with a 7-day exclude-newer and
#                                every pip on PATH (and under ~/hq) is 26.1+ and
#                                sees only P7D, and no .npmrc, uv.toml,
#                                pyproject.toml or pip.conf anywhere in ~/hq
#                                (rigs, ops, tools; hq worktrees and
#                                node_modules skipped) turns them back off;
#                                exit 1 names the gap
#   guardrails.sh scripts [dir]  run install scripts in dir (default .) for the
#                                allowlisted packages present there, nothing else
#   guardrails.sh allowlist      print the allowlist with the reason for each entry
#
# Allowlist: a package that truly needs its install script (a native build with
# no prebuilt binary) goes in ALLOW below with a reason, then `guardrails.sh
# scripts <rig>` after `npm install`. The root project's own name counts too,
# which runs its prepare/install/postinstall. Fresh fix for a release younger
# than 7 days (a security patch): `npm install <pkg>@<ver> --min-release-age=0`
# for that one command (uv: `--exclude-newer-package <pkg>=false`, pip:
# `--uploaded-prior-to=P0D`), and say so on the bead.
#
# Env (tests): GUARD_NPMRC (default ~/.npmrc), GUARD_ROOT (default ~/hq; the
# older GUARD_RIGS is still read), GUARD_ALLOWLIST (space separated names, replaces ALLOW),
# GUARD_CONFIG_HOME (default $XDG_CONFIG_HOME or ~/.config; set, uv and pip run
# with it as XDG_CONFIG_HOME so a fixture pins their user config).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(dirname "$(git -C "$DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$DIR/../../.git")")}"
NPMRC="${GUARD_NPMRC:-$HOME/.npmrc}"
# check asks npm with the caller's real environment, so an exported
# npm_config_userconfig that points elsewhere shows up as a GAP. Only a test
# fixture (GUARD_NPMRC set) pins the user config.
if [ -n "${GUARD_NPMRC:-}" ]; then UC=(env npm_config_userconfig="$NPMRC"); else UC=(env); fi
ROOT="${GUARD_ROOT:-${GUARD_RIGS:-$HQ}}"
AGE=7
CFG="${GUARD_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}"
UVTOML="$CFG/uv/uv.toml"
PIPCONF="$CFG/pip/pip.conf"
if [ -n "${GUARD_CONFIG_HOME:-}" ]; then XC=(env XDG_CONFIG_HOME="$CFG"); else XC=(env); fi
UV_AGE="$AGE days"; PIP_AGE="P${AGE}D"
# uv --show-settings, whitespace stripped: a relative 7-day window and no
# per-package exemption. Anything else (an absolute date from UV_EXCLUDE_NEWER,
# a project override, no value, a uv too old to parse the config) is a gap.
UV_WANT="exclude_newer:ExcludeNewer{global:Some(Relative(ExcludeNewerSpan(${AGE}d,),),),package:ExcludeNewerPackage({}"
BEGIN='# >>> hq guardrails (ops/security/guardrails.sh, hq-8cry.4) >>>'
END='# <<< hq guardrails <<<'

# name|reason. Empty on purpose: on 2026-10-27 every rig installed and built
# with scripts off (esbuild, sharp and unrs-resolver ship prebuilt binaries as
# optional deps; core-js only prints a banner; fsevents is macOS only).
ALLOW=(
)

allow_names() {
  if [ -n "${GUARD_ALLOWLIST+x}" ]; then printf '%s\n' $GUARD_ALLOWLIST; return; fi
  local e; for e in "${ALLOW[@]}"; do printf '%s\n' "${e%%|*}"; done
}

cmd_apply() {
  local tmp; tmp="$(mktemp)"
  mkdir -p "$(dirname "$NPMRC")"; touch "$NPMRC"
  # drop the old block and any line outside it that would fight it
  awk -v b="$BEGIN" -v e="$END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip { next }
    /^[[:space:]]*(ignore[-_]scripts|min[-_]release[-_]age|before)[[:space:]]*=/ { next }
    { print }' "$NPMRC" > "$tmp"
  # no trailing blank lines before the block
  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$tmp"
  { [ -s "$tmp" ] && echo; echo "$BEGIN"; echo "ignore-scripts=true"; echo "min-release-age=$AGE"; echo "$END"; } >> "$tmp"
  write_if_changed "$tmp" "$NPMRC" || return 1
  apply_uv || return 1
  apply_pip || return 1
  # trust the effective value, not the write
  cmd_check >/dev/null || { echo "apply: wrote the guardrails but check still fails" >&2; return 1; }
}

# write_if_changed <tmp> <target> [validator...]: replace target with tmp
# unless equal; a validator that rejects tmp leaves the target untouched
write_if_changed() {
  if cmp -s "$1" "$2"; then rm -f "$1"; echo "apply: $2 already current"; return 0; fi
  if [ $# -gt 2 ] && ! "${@:3}" "$1" >/dev/null 2>&1; then
    rm -f "$1"; echo "apply: the new $2 does not parse, left it as it was" >&2; return 1
  fi
  if ! cat "$1" > "$2"; then rm -f "$1"; echo "apply: FAILED to write $2" >&2; return 1; fi
  rm -f "$1"; echo "apply: wrote guardrails block to $2"
}

# uv.toml is TOML: a top-level key must come before the first [table], so the
# block goes first. Any other exclude-newer line (a [pip] one included) goes.
apply_uv() {
  local tmp; tmp="$(mktemp)"
  mkdir -p "$(dirname "$UVTOML")"; touch "$UVTOML"
  { echo "$BEGIN"; echo "exclude-newer = \"$UV_AGE\""; echo "$END"
    awk -v b="$BEGIN" -v e="$END" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      skip { next }
      /^[[:space:]]*["\047]?exclude[-_]newer([-_]package)?["\047]?[[:space:]]*=/ { next }
      { print }' "$UVTOML"; } > "$tmp"
  if command -v uv >/dev/null; then write_if_changed "$tmp" "$UVTOML" uv_parses; else write_if_changed "$tmp" "$UVTOML"; fi
}
uv_parses() { UV_CONFIG_FILE="$1" uv pip install --show-settings guardrails-probe; }

# pip.conf is INI and pip rejects a second [global], so the block goes right
# after the file's first [global] header (one is added at the top when there is
# none). Any other uploaded-prior-to line, an [install] one included, goes.
apply_pip() {
  local tmp; tmp="$(mktemp)"
  mkdir -p "$(dirname "$PIPCONF")"; touch "$PIPCONF"
  awk -v b="$BEGIN" -v e="$END" -v kv="uploaded-prior-to = $PIP_AGE" '
    function block() { print b; print kv; print e; done = 1 }
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip { next }
    /^[[:space:]]*uploaded[-_]prior[-_]to[[:space:]]*[=:]/ { next }
    { lines[++n] = $0; if (!g && $0 ~ /^[[:space:]]*\[global\][[:space:]]*([#;].*)?$/) g = n }
    END {
      if (!g) { print "[global]"; block() }
      for (i = 1; i <= n; i++) { print lines[i]; if (i == g) block() }
    }' "$PIPCONF" > "$tmp"
  write_if_changed "$tmp" "$PIPCONF" pip_parses
}
# pip reads its files with a strict RawConfigParser: a second [global] fails
pip_parses() { python3 -I -c 'import configparser,sys; configparser.RawConfigParser().read(sys.argv[1])' "$1"; }

cmd_check() {
  local bad=0 n seen="" real v
  while IFS= read -r n; do
    real="$(readlink -f "$n")"
    case " $seen " in *" $real "*) continue ;; esac
    seen="$seen $real"
    # an npm older than 11.10 returns min-release-age without honouring it
    v="$("$n" --version 2>/dev/null)"
    printf '%s\n11.10.0\n' "$v" | sort -V -C 2>/dev/null && [ "$v" != 11.10.0 ] && { echo "GAP $n: npm $v is older than 11.10 and ignores min-release-age"; bad=1; }
    v="$("${UC[@]}" "$n" config get ignore-scripts 2>/dev/null)"
    [ "$v" = true ] || { echo "GAP $n: ignore-scripts=$v (want true)"; bad=1; }
    v="$("${UC[@]}" "$n" config get min-release-age 2>/dev/null)"
    [ "$v" = "$AGE" ] || { echo "GAP $n: min-release-age=$v (want $AGE; npm 11.10+ knows it)"; bad=1; }
  done < <(type -ap npm)
  [ -n "$seen" ] || { echo "GAP no npm on PATH"; bad=1; }
  # a project .npmrc beats the user config (hq-8cry.8: all of ~/hq, since an
  # npm install under ops/ or a tool dir reads its .npmrc as much as a rig's)
  if [ -d "$ROOT" ]; then
    while IFS= read -r f; do
      # npm does the parsing, so a quoted "false", 0, no or False cannot slip
      # past; the grep stays as a backstop for a dir npm does not treat as a
      # project root, and it flags a userconfig= or globalconfig= redirect,
      # which a test fixture's pinned userconfig would otherwise hide.
      if grep -Ei '^[[:space:]]*(ignore[-_]scripts|min[-_]release[-_]age|before|userconfig|globalconfig)[[:space:]]*=' "$f" \
         | grep -Evq "^[[:space:]]*(ignore-scripts[[:space:]]*=[[:space:]]*true|min-release-age[[:space:]]*=[[:space:]]*$AGE)[[:space:]]*\$"; then
        echo "GAP $f overrides the guardrails"; bad=1; continue
      fi
      v="$(cd "$(dirname "$f")" && "${UC[@]}" npm config get ignore-scripts 2>/dev/null)"
      [ "$v" = true ] || { echo "GAP $f: ignore-scripts=$v (want true)"; bad=1; }
      v="$(cd "$(dirname "$f")" && "${UC[@]}" npm config get min-release-age 2>/dev/null)"
      [ "$v" = "$AGE" ] || { echo "GAP $f: min-release-age=$v (want $AGE)"; bad=1; }
    done < <(find -L "$ROOT" \( -name node_modules -o -name .git -o -name .next -o -path '*/.claude/worktrees' \) -prune -o -name .npmrc -print 2>/dev/null)
  fi
  check_uv || bad=1
  check_pip || bad=1
  [ "$bad" = 0 ] && echo "check: ok (ignore-scripts=true, min-release-age=$AGE, uv exclude-newer=$UV_AGE, pip uploaded-prior-to=$PIP_AGE)"
  return "$bad"
}

# uv_window <uv> [dir]: the effective exclude-newer, as uv itself resolves it,
# for the pip interface and for the project/tool resolver (uv add, lock, sync,
# tool install), since a [pip] table only covers the first. Two different
# windows print two lines, which never equals UV_WANT.
uv_window() {
  { (cd "${2:-.}" && "${XC[@]}" "$1" pip install --show-settings guardrails-probe 2>/dev/null)
    (cd "${2:-.}" && "${XC[@]}" "$1" add --show-settings guardrails-probe 2>/dev/null); } \
    | tr -d ' \n' | grep -o 'exclude_newer:[A-Za-z]*{global:[^}]*}' | sort -u
}

check_uv() {
  local bad=0 n seen="" real v f d
  while IFS= read -r n; do
    real="$(readlink -f "$n")"
    case " $seen " in *" $real "*) continue ;; esac
    seen="$seen $real"
    v="$(uv_window "$n" /)"
    [ "$v" = "$UV_WANT" ] || { echo "GAP $n: uv exclude-newer is not a plain $UV_AGE window (${v:-unreadable; uv 0.9.17+ knows it}; want exclude-newer = \"$UV_AGE\" in $UVTOML)"; bad=1; }
  done < <(type -ap uv)
  # a project uv.toml or [tool.uv] beats the user config; uv itself reads it
  [ -n "$seen" ] && [ -d "$ROOT" ] && while IFS= read -r f; do
    d="$(dirname "$f")"
    if grep -Eq '^[[:space:]]*["\047]?exclude[-_]newer' "$f"; then
      echo "GAP $f sets its own exclude-newer"; bad=1; continue
    fi
    v="$(uv_window uv "$d")"
    [ "$v" = "$UV_WANT" ] || { echo "GAP $f: uv exclude-newer here is ${v:-unreadable} (want $UV_AGE)"; bad=1; }
  done < <(find -L "$ROOT" \( -name node_modules -o -name .git -o -name .next -o -name .venv -o -path '*/.claude/worktrees' \) -prune -o \( -name uv.toml -o -name pyproject.toml \) -print 2>/dev/null)
  return "$bad"
}

check_pip() {
  local bad=0 n seen="" real v vals d
  # the user file itself, under [global] (an [install] or [download] value only
  # covers that command), so a pip installed later (a venv) inherits it
  awk -v want="$PIP_AGE" '
    /^[[:space:]]*\[/ { g = ($0 ~ /^[[:space:]]*\[global\][[:space:]]*([#;].*)?$/); next }
    g && $0 ~ "^[[:space:]]*uploaded-prior-to[[:space:]]*=[[:space:]]*" want "[[:space:]]*$" { found = 1 }
    END { exit !found }' "$PIPCONF" 2>/dev/null \
    || { echo "GAP $PIPCONF: no [global] uploaded-prior-to = $PIP_AGE"; bad=1; }
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    real="$(readlink -f "$n")"
    case " $seen " in *" $real "*) continue ;; esac
    seen="$seen $real"
    # a pip older than 26.1 ignores or cannot parse a P<n>D duration
    v="$("$n" --version 2>/dev/null | awk '{print $2}')"
    if pip_old "$v"; then echo "GAP $n: pip ${v:-unknown} is older than 26.1 and ignores uploaded-prior-to=$PIP_AGE"; bad=1; continue; fi
    # a global value must be there, and every value pip sees (files and
    # PIP_UPLOADED_PRIOR_TO) must be P7D
    vals="$("${XC[@]}" "$n" config list 2>/dev/null | grep -E '\.uploaded[-_]prior[-_]to=')"
    if ! grep -q "^global\.uploaded-prior-to='$PIP_AGE'\$" <<<"$vals"; then
      echo "GAP $n: pip sees no global uploaded-prior-to=$PIP_AGE${vals:+ (it sees $(printf '%s' "$vals" | tr '\n' ' '))}"; bad=1
    elif grep -vq "='$PIP_AGE'\$" <<<"$vals"; then
      echo "GAP $n: pip sees $(printf '%s' "$vals" | tr '\n' ' ')(want only $PIP_AGE)"; bad=1
    fi
  done < <(type -ap pip pip3)
  # venvs under ~/hq: read the installed pip's version from its dist-info
  # name, never by running a launcher that lives in a checkout (pip3-only
  # venvs from ensurepip count too)
  [ -d "$ROOT" ] && while IFS= read -r d; do
    v="$(basename "$d" .dist-info)"; v="${v#pip-}"
    pip_old "$v" && { echo "GAP ${d%/lib/*}: venv pip $v is older than 26.1 and ignores uploaded-prior-to=$PIP_AGE"; bad=1; }
  done < <(find -L "$ROOT" \( -name node_modules -o -name .git -o -path '*/.claude/worktrees' \) -prune -o -type d -path '*/site-packages/pip-*.dist-info' -print 2>/dev/null)
  # a project or venv pip.conf beats the user file
  [ -d "$ROOT" ] && while IFS= read -r f; do
    grep -Ei '^[[:space:]]*uploaded[-_]prior[-_]to[[:space:]]*[=:]' "$f" | grep -Evq "^[[:space:]]*uploaded-prior-to[[:space:]]*=[[:space:]]*$PIP_AGE[[:space:]]*\$" \
      && { echo "GAP $f overrides uploaded-prior-to"; bad=1; }
  done < <(find -L "$ROOT" \( -name node_modules -o -name .git -o -path '*/.claude/worktrees' \) -prune -o -name pip.conf -print 2>/dev/null)
  return "$bad"
}

# pip_old <version>: true when empty or older than 26.1
pip_old() { [ -z "$1" ] || { printf '%s\n26.1\n' "$1" | sort -V -C && [ "$1" != 26.1 ]; }; }

cmd_scripts() {
  local d="${1:-.}" n root ran=0 pkgs=()
  [ -f "$d/package.json" ] || { echo "scripts: no package.json in $d" >&2; return 2; }
  root="$(jq -r '.name // empty' "$d/package.json")"
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    if [ "$n" = "$root" ]; then
      for s in preinstall install postinstall prepare; do
        jq -e --arg s "$s" '.scripts[$s]' "$d/package.json" >/dev/null 2>&1 || continue
        (cd "$d" && npm run "$s") || return 1; ran=1
      done
    elif [ -f "$d/node_modules/$n/package.json" ]; then
      pkgs+=("$n")
    fi
  done < <(allow_names)
  if [ "${#pkgs[@]}" -gt 0 ]; then
    (cd "$d" && npm rebuild --ignore-scripts=false "${pkgs[@]}") || return 1; ran=1
  fi
  [ "$ran" = 1 ] && echo "scripts: ran for ${pkgs[*]:-} ${root:+(root checked)}" || echo "scripts: nothing allowlisted in $d"
}

cmd_allowlist() {
  if [ -n "${GUARD_ALLOWLIST+x}" ]; then allow_names; return; fi
  [ "${#ALLOW[@]}" -gt 0 ] || { echo "(empty: no package needs its install script)"; return; }
  local e; for e in "${ALLOW[@]}"; do printf '%s\t%s\n' "${e%%|*}" "${e#*|}"; done
}

case "${1:-}" in
  apply) cmd_apply ;;
  check) cmd_check ;;
  scripts) shift; cmd_scripts "$@" ;;
  allowlist) cmd_allowlist ;;
  *) sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
