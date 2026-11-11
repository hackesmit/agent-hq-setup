#!/usr/bin/env bash
# drift-check.test.sh (hq-fgg3.1): fixture test for ops/scripts/drift-check.sh.
#
# Builds a throwaway HQ (manifest, registries, CLAUDE.md, hooks, MCP profile,
# hq.sh, rigs/) and PATH shims for systemctl, tmux and crontab that answer from
# fixture files. The clean fixture must exit 0 with nothing to report; each
# injected drift (units, switches, heartbeats, tmux, hooks, MCP, cron, claims)
# must exit 1 and name the item; a broken tool must give "could not check" and
# exit 0 (fail open); --notify must send one notify and exit 0.
#
# Run: bash ops/scripts/tests/drift-check.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DC="$HERE/../drift-check.sh"
REAL_MAIL="$HERE/../../mail/hq_mail"
[ -x "$DC" ] || { echo "FAIL cannot find drift-check.sh at $DC"; exit 1; }

# the caller's environment must not leak in (HQ_ROOT is set globally on hqbox)
unset HQ_ROOT HQ_DIR HQ_STATE_DIR DRIFT_RIG_OVERRIDE DRIFT_TODAY DRIFT_NOW DRIFT_BD
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R="$T/hq"; BIN="$T/bin"; FX="$T/fx"
mkdir -p "$R/ops/config" "$R/ops/mail" "$R/ops/scripts" "$R/ops/mcp" "$R/ops/services/demo" \
         "$R/.claude" "$R/rigs/alpha/.git" "$R/state/heartbeat" "$BIN" "$FX/tmux" "$T/vault"
ln -s "$REAL_MAIL" "$R/ops/mail/hq_mail"

fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }

# --- fixture HQ ---------------------------------------------------------------
cat > "$R/ops/config/runtime.json" <<'EOF'
{
  "units": [
    {"unit": "demo-d.service", "scope": "user", "run": "daemon", "source": "ops/services/demo/demo-d.service", "on_failure": "required", "owner": "demo"},
    {"unit": "demo-t.service", "scope": "user", "run": "timer", "source": "ops/services/demo/demo-t.service", "on_failure": "required", "owner": "demo"},
    {"unit": "demo-s.service", "scope": "system", "run": "daemon", "source": null, "on_failure": "exempt:fixture", "owner": "demo"}
  ],
  "undeclared_unit_pattern": "^(demo-|hq-)",
  "repo_unit_dirs": ["ops/services"],
  "tmux": {"session": "hq", "servers": ["default", "hqterm"], "launcher": "ops/scripts/hq.sh",
           "windows": ["monitor", "sync"], "optional": ["work"], "launcher_conditional": {}},
  "installed_files": [],
  "hooks_unwired": {"hook-retired.sh": "kept for reference"},
  "cron": [{"match": "tools/thing.sh", "owner": "demo", "what": "thing"}],
  "switches": {"ops/mail/LOG_ONLY": {"what": "log only", "owner": "hq-mail", "on": null}},
  "switch_scan": {"roots": ["ops", "state"], "max_depth": 3, "name_regex": "^[A-Z][A-Z0-9_]{2,}$",
                  "ignore_names": ["README"], "skip_dirs": ["hq_mail"]},
  "claims": [
    {"id": "vault-path", "file": "CLAUDE.md", "regex": "vault is at `([^`]+)`", "cmd": ["ops/scripts/vault-path.sh"], "compare": "path", "owner": "claude-md"},
    {"id": "rigs-table", "type": "rigs_table", "file": "CLAUDE.md", "owner": "claude-md"}
  ]
}
EOF
printf '[Unit]\nDescription=d\n[Service]\nExecStart=/bin/true\n' > "$R/ops/services/demo/demo-d.service"
printf '[Unit]\nDescription=t\n[Service]\nType=oneshot\nExecStart=/bin/true\n' > "$R/ops/services/demo/demo-t.service"
printf '[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n' > "$R/ops/services/demo/demo-t.timer"
mkdir -p "$FX/installed"
# installed copies: same content, different comments (comments never count)
{ echo "# installed copy"; cat "$R/ops/services/demo/demo-d.service"; } > "$FX/installed/demo-d.service"
cp "$R/ops/services/demo/demo-t.service" "$FX/installed/demo-t.service"
cp "$R/ops/services/demo/demo-t.timer" "$FX/installed/demo-t.timer"

cat > "$R/ops/mail/heartbeats.json" <<'EOF'
{"loops": {
  "sync": {"project": "hq-git-sync", "stale_after": 600, "hosts": ["fixturehost"]},
  "old": {"project": "hq-old", "stale_after": 600, "hosts": ["fixturehost"], "enabled": false,
          "owner": "hq-old", "expires": "2026-12-31"}
}}
EOF
echo '{"projects": {"alpha": {"status": "n/a"}}}' > "$R/ops/mail/coverage.json"
touch "$R/state/heartbeat/sync"

printf '#!/bin/sh\nexit 0\n' > "$R/ops/scripts/hook-live.sh"
printf '#!/bin/sh\nexit 0\n' > "$R/ops/scripts/hook-retired.sh"
chmod +x "$R/ops/scripts/hook-live.sh" "$R/ops/scripts/hook-retired.sh"
cat > "$R/.claude/settings.json" <<'EOF'
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "$CLAUDE_PROJECT_DIR/ops/scripts/hook-live.sh"}]}]}}
EOF
echo '{"mcpServers": {"x": {"command": "sh", "args": []}}}' > "$R/ops/mcp/ok.json"
cat > "$R/ops/scripts/hq.sh" <<'EOF'
tmux new-session -d -s hq -n monitor './ops/scripts/monitor.sh'
tmux new-window -t hq -n sync './ops/scripts/git-sync.sh --watch'
EOF
printf '#!/bin/sh\necho %s\n' "$T/vault" > "$R/ops/scripts/vault-path.sh"; chmod +x "$R/ops/scripts/vault-path.sh"
cat > "$R/CLAUDE.md" <<EOF
# fixture
The vault is at \`$T/vault\` on this box.

| Rig | Path | Branch | Notes |
|---|---|---|---|
| example-app | rigs/example-app | main | own ledger; finish.sh deploys by API |
| example-site | rigs/example-site | main | hq ledger; public-facing (redteam) |
| example-pos | rigs/example-pos | main | hq ledger; money surface (redteam); no deploy |
EOF

# --- shims ----------------------------------------------------------------------
cat > "$FX/units.json" <<EOF
{"user": {
   "demo-d.service": {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled", "Result": "success",
                      "OnFailure": "hq-failure-notify@demo-d.service.service", "SuccessExitStatus": "", "FragmentPath": "$FX/installed/demo-d.service"},
   "demo-t.service": {"LoadState": "loaded", "ActiveState": "inactive", "UnitFileState": "static", "Result": "success",
                      "OnFailure": "hq-failure-notify@demo-t.service.service", "SuccessExitStatus": "", "FragmentPath": "$FX/installed/demo-t.service"},
   "demo-t.timer":   {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled", "Result": "success",
                      "OnFailure": "", "SuccessExitStatus": "", "FragmentPath": "$FX/installed/demo-t.timer"}},
 "system": {
   "demo-s.service": {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled", "Result": "success",
                      "OnFailure": "", "SuccessExitStatus": "", "FragmentPath": "/usr/lib/systemd/system/demo-s.service"},
   "unrelated.service": {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled"}}}
EOF
cp "$FX/units.json" "$FX/units.clean.json"
cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env python3
import json, os, sys
if os.environ.get("FAKE_SYSTEMCTL_BROKEN"):
    print("Failed to connect to bus", file=sys.stderr); sys.exit(1)
a = sys.argv[1:]
scope = "system"
if a and a[0] == "--user":
    scope = "user"; a = a[1:]
units = json.load(open(os.environ["FAKE_UNITS"]))[scope]
if a[0] == "list-unit-files":
    for n, p in units.items():
        print("%s %s %s" % (n, p.get("UnitFileState", "static"), "-"))
elif a[0] == "show":
    p = units.get(a[1], {"LoadState": "not-found", "ActiveState": "inactive"})
    want = a[a.index("-p") + 1].split(",") if "-p" in a else list(p)
    for k in want:
        print("%s=%s" % (k, p.get(k, "")))
EOF
cat > "$BIN/tmux" <<'EOF'
#!/usr/bin/env bash
# tmux -L <server> list-panes -s -t =<session>: -F ...
server="$2"; target=""
while [ $# -gt 0 ]; do [ "$1" = "-t" ] && target="$2"; shift; done
sess="${target#=}"; sess="${sess%:}"
f="$FAKE_TMUX/$server"
[ -f "$f" ] || { echo "no server running on /tmp/tmux-0/$server" >&2; exit 1; }
grep -q "^$sess	" "$f" || { echo "can't find session: $sess" >&2; exit 1; }
grep "^$sess	" "$f"
EOF
cat > "$BIN/crontab" <<'EOF'
#!/bin/sh
cat "$FAKE_CRONTAB"
EOF
chmod +x "$BIN/systemctl" "$BIN/tmux" "$BIN/crontab"
printf 'hq\tmonitor\t0\nhq\tsync\t0\nhq\twork\t0\nhq-errors\tfixer-1\t0\n' > "$FX/tmux/hqterm"
printf 'other\tw\t0\n' > "$FX/tmux/default"
printf 'MAILTO=""\n# comment\n*/5 * * * * /home/x/hq/tools/thing.sh\n' > "$FX/crontab"
cp "$FX/crontab" "$FX/crontab.clean"

export PATH="$BIN:$PATH" HQ_ROOT="$R" HQ_STATE_DIR="$R/state" HQ_HOSTNAME=fixturehost \
       DRIFT_TODAY=2026-10-19 DRIFT_BD="" DRIFT_USER_SETTINGS="$T/none.json" \
       FAKE_UNITS="$FX/units.json" FAKE_TMUX="$FX/tmux" FAKE_CRONTAB="$FX/crontab"

reset_fx(){
  cp "$FX/units.clean.json" "$FX/units.json"; cp "$FX/crontab.clean" "$FX/crontab"
  printf 'hq\tmonitor\t0\nhq\tsync\t0\nhq\twork\t0\nhq-errors\tfixer-1\t0\n' > "$FX/tmux/hqterm"
  printf 'other\tw\t0\n' > "$FX/tmux/default"
  rm -f "$R/ops/mail/LOG_ONLY" "$R/ops/mail/PAUSED" "$R/state/heartbeat/ghost"
  touch "$R/state/heartbeat/sync"
  unset FAKE_SYSTEMCTL_BROKEN
}
# expect_drift <name> <id-substring>: exit 1 and the id in --json
expect_drift(){
  local out rc; out="$("$DC" --json 2>&1)"; rc=$?
  if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q -- "\"id\": \"[^\"]*$2"; then ok "$1"
  else no "$1" "rc=$rc out=$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"; fi
  reset_fx
}
setjson(){ python3 - "$FX/units.json" "$@" <<'EOF'
import json, sys
p, scope, unit, key, val = sys.argv[1:6]
d = json.load(open(p)); d[scope].setdefault(unit, {})[key] = val
json.dump(d, open(p, "w"))
EOF
}

# --- clean -----------------------------------------------------------------------
out="$("$DC" 2>&1)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q '0 drift item(s), 0 could not check'; then ok "clean fixture exits 0"
else no "clean fixture exits 0" "rc=$rc $(printf '%s' "$out" | head -8 | tr '\n' ' ')"; fi
out="$("$DC" --json)"; rc=$?
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["clean"] is True and d["items"]==[]' \
  && [ "$rc" = 0 ] && ok "clean --json says clean" || no "clean --json says clean" "rc=$rc"

# --- units -----------------------------------------------------------------------
setjson user demo-d.service ActiveState failed; expect_drift "units: inactive daemon" "units:demo-d.service:inactive"
setjson user demo-t.timer ActiveState inactive; expect_drift "units: timer not active" "units:demo-t.timer:inactive"
setjson user demo-t.service Result exit-code; expect_drift "units: last run failed" "units:demo-t.service:failed"
setjson user demo-d.service OnFailure ""; expect_drift "units: no OnFailure" "units:demo-d.service:no-onfailure"
setjson user demo-d.service SuccessExitStatus "0 1"; expect_drift "units: nonzero SuccessExitStatus" "units:demo-d.service:success-exit"
setjson user hq-ghost.service UnitFileState enabled; expect_drift "units: undeclared HQ unit" "units:hq-ghost.service:undeclared"
setjson user demo-d.service LoadState not-found; expect_drift "units: declared unit not installed" "units:demo-d.service:not-installed"
echo "ExecStartPre=/bin/false" >> "$FX/installed/demo-d.service"
expect_drift "units: installed copy differs" "units:demo-d.service:differs"
sed -i '/ExecStartPre/d' "$FX/installed/demo-d.service"
printf '[Unit]\n' > "$R/ops/services/demo/orphan.service"
expect_drift "units: repo unit file not declared" "units:orphan.service:repo-undeclared"
rm -f "$R/ops/services/demo/orphan.service"

# --- switches --------------------------------------------------------------------
touch "$R/ops/mail/LOG_ONLY"; expect_drift "switches: on with no record" "switches:ops/mail/LOG_ONLY:on-undeclared"
python3 - "$R/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["switches"]["ops/mail/LOG_ONLY"]["on"] = {"since": "2026-08-01", "expires": "2026-09-01", "owner": "hq-mail"}
json.dump(d, open(p, "w"))
EOF
touch "$R/ops/mail/LOG_ONLY"; expect_drift "switches: on past expiry" "switches:ops/mail/LOG_ONLY:expired"
expect_drift "switches: off but still recorded on" "switches:ops/mail/LOG_ONLY:stale-on-record"
python3 - "$R/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["switches"]["ops/mail/LOG_ONLY"]["on"] = {"since": "2026-10-01", "expires": "2026-12-01", "owner": "hq-mail"}
json.dump(d, open(p, "w"))
EOF
touch "$R/ops/mail/LOG_ONLY"
"$DC" >/dev/null 2>&1; rc=$?; [ "$rc" = 0 ] && ok "switches: on inside its expiry is clean" || no "switches: on inside its expiry is clean" "rc=$rc"
rm -f "$R/ops/mail/LOG_ONLY"
python3 - "$R/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["switches"]["ops/mail/LOG_ONLY"]["on"] = None
json.dump(d, open(p, "w"))
EOF
touch "$R/ops/mail/PAUSED"; expect_drift "switches: undeclared flag file" "switches:ops/mail/PAUSED:undeclared"

# --- heartbeats ------------------------------------------------------------------
touch -d '2 hours ago' "$R/state/heartbeat/sync"; expect_drift "heartbeats: stale loop" "heartbeats:sync:dead"
touch "$R/state/heartbeat/ghost"; expect_drift "heartbeats: orphan heartbeat" "heartbeats:ghost:orphan"
DRIFT_TODAY=2027-01-05 expect_drift "heartbeats: parked entry past expiry" "heartbeats:old:parked-expired"

# --- tmux ------------------------------------------------------------------------
printf 'hq\tmonitor\t0\nhq\twork\t0\n' > "$FX/tmux/hqterm"; expect_drift "tmux: declared window missing" "tmux:hq:sync:missing"
printf 'hq\tmonitor\t0\nhq\tsync\t1\n' > "$FX/tmux/hqterm"; expect_drift "tmux: dead window" "tmux:hq:sync:dead"
printf 'hq\tmonitor\t0\nhq\tsync\t0\nhq\tconsole\t0\n' > "$FX/tmux/hqterm"; expect_drift "tmux: undeclared window" "tmux:hq:console:undeclared"
printf 'hq\tmonitor\t0\nhq\tsync\t0\n' > "$FX/tmux/default"; expect_drift "tmux: session on two servers" "tmux:hq:duplicate"
rm -f "$FX/tmux/hqterm"; expect_drift "tmux: no hq session anywhere" "tmux:hq:no-session"

# --- hooks, MCP, cron, claims ----------------------------------------------------
printf '#!/bin/sh\n' > "$R/ops/scripts/hook-new.sh"; expect_drift "hooks: hook file nothing wires" "hooks:hook-new.sh:unwired"
rm -f "$R/ops/scripts/hook-new.sh"
chmod -x "$R/ops/scripts/hook-live.sh"; expect_drift "hooks: wired hook not executable" "hooks:hook-live.sh:missing"
chmod +x "$R/ops/scripts/hook-live.sh"
echo '{"mcpServers": {"y": {"command": "no-such-binary-xyz"}}}' > "$R/ops/mcp/bad.json"
expect_drift "mcp: profile command missing" "mcp:bad/y:command-missing"; rm -f "$R/ops/mcp/bad.json"
printf '' > "$FX/crontab"; expect_drift "cron: declared job missing" "cron:tools/thing.sh:missing"
printf '*/5 * * * * /home/x/hq/tools/thing.sh\n0 1 * * * /home/x/hq/tools/other.sh\n' > "$FX/crontab"
expect_drift "cron: undeclared hq job" "cron:0 1"
mkdir -p "$R/rigs/beta/.git"; expect_drift "claims: rig dir without a table row" "claims:rig:beta:not-in-table"
rm -rf "$R/rigs/beta"
printf '#!/bin/sh\necho /elsewhere\n' > "$R/ops/scripts/vault-path.sh"; expect_drift "claims: CLAUDE.md fact is false" "claims:vault-path:false"
printf '#!/bin/sh\necho %s\n' "$T/vault" > "$R/ops/scripts/vault-path.sh"

# --- stable ids, --new-since, rig override (finish.sh's drift gate) ---------------
ids(){ "$DC" --json 2>/dev/null | python3 -c 'import json,sys; print(" ".join(sorted(i["id"] for i in json.load(sys.stdin)["items"])))'; }
touch -d '2 hours ago' "$R/state/heartbeat/sync"; touch -d '10 minutes ago' "$R/state/heartbeat/ghost"
a="$(ids)"; "$DC" --json > "$T/run1.json"
touch -d '5 hours ago' "$R/state/heartbeat/sync"; touch -d '3 minutes ago' "$R/state/heartbeat/ghost"
b="$(ids)"; "$DC" --json > "$T/run2.json"
if [ -n "$a" ] && [ "$a" = "$b" ]; then ok "ids are identical across runs with different heartbeat ages"
else no "ids are identical across runs with different heartbeat ages" "a=$a b=$b"; fi
grep -Eq '"detail": "loop heartbeat is stale \(72[0-9]{2}s old' "$T/run1.json" && ok "the age lives in detail, not in the id" || no "the age lives in detail, not in the id"
"$DC" --new-since "$T/run1.json" "$T/run2.json" >/dev/null; [ "$?" = 0 ] && ok "--new-since: same items is exit 0" || no "--new-since: same items is exit 0"
reset_fx
"$DC" --json > "$T/clean.json"
setjson user demo-d.service ActiveState inactive; "$DC" --json > "$T/drifted.json"
out="$("$DC" --new-since "$T/clean.json" "$T/drifted.json")"; rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q '^units:demo-d.service:inactive' && ok "--new-since: a new item is exit 1 and listed" || no "--new-since: new item" "rc=$rc $out"
FAKE_SYSTEMCTL_BROKEN=1 "$DC" --json > "$T/hiccup.json"
"$DC" --new-since "$T/hiccup.json" "$T/drifted.json" >/dev/null; rc=$?
[ "$rc" = 0 ] && ok "--new-since: a check that could not run in one run is not compared" || no "--new-since: unknown excluded" "rc=$rc"
"$DC" --new-since "$T/clean.json" "$T/nope.json" >/dev/null 2>&1; [ "$?" = 3 ] && ok "--new-since: unreadable input is exit 3" || no "--new-since: unreadable input is exit 3"
reset_fx
mkdir -p "$R/rigs/alpha/bin"; touch "$R/rigs/alpha/bin/report.sh"
echo '{"projects": {"alpha": {"status": "wired", "evidence": "rigs/alpha/bin/report.sh"}}}' > "$R/ops/mail/coverage.json"
mkdir -p "$T/preview"
DRIFT_RIG_OVERRIDE="alpha=$T/preview" expect_drift "rig override: evidence judged in the preview tree" "coverage:alpha:rotted"
"$DC" --only coverage >/dev/null 2>&1; [ "$?" = 0 ] && ok "rig override: without it the real rig is judged" || no "rig override: without it the real rig is judged"
echo '{"projects": {"alpha": {"status": "n/a"}}}' > "$R/ops/mail/coverage.json"

PY="$HERE/../drift_check.py"
out="$(printf 'docs/x.md\nops/services/demo/demo-d.service\n' | python3 "$PY" --gate-relevant hq)"; rc=$?
[ "$rc" = 0 ] && [ "$out" = "ops/services/demo/demo-d.service" ] && ok "--gate-relevant hq: a declared unit source counts" || no "--gate-relevant hq" "rc=$rc $out"
printf 'docs/x.md\nsrc/app.js\n' | python3 "$PY" --gate-relevant hq >/dev/null; [ "$?" = 1 ] && ok "--gate-relevant hq: unrelated paths do not" || no "--gate-relevant hq: unrelated"
echo '{"projects": {"alpha": {"status": "wired", "evidence": "rigs/alpha/bin/report.sh"}}}' > "$R/ops/mail/coverage.json"
printf 'bin/report.sh\n' | python3 "$PY" --gate-relevant alpha >/dev/null; [ "$?" = 0 ] && ok "--gate-relevant rig: its coverage evidence counts" || no "--gate-relevant rig: evidence"
printf 'src/app.js\n' | python3 "$PY" --gate-relevant alpha >/dev/null; [ "$?" = 1 ] && ok "--gate-relevant rig: other rig files do not" || no "--gate-relevant rig: other"
echo '{"projects": {"alpha": {"status": "n/a"}}}' > "$R/ops/mail/coverage.json"
# hq-fgg3.17 finding 2: switch files are what drift-check reads too
out="$(printf 'ops/mail/LOG_ONLY\n' | python3 "$PY" --gate-relevant hq)"; rc=$?
[ "$rc" = 0 ] && [ "$out" = "ops/mail/LOG_ONLY" ] && ok "--gate-relevant hq: a declared switch file counts" || no "--gate-relevant hq: declared switch" "rc=$rc $out"
out="$(printf 'ops/mail/PAUSED\n' | python3 "$PY" --gate-relevant hq)"; rc=$?
[ "$rc" = 0 ] && [ "$out" = "ops/mail/PAUSED" ] && ok "--gate-relevant hq: an undeclared flag file under a scan root counts" || no "--gate-relevant hq: undeclared flag" "rc=$rc $out"
printf 'ops/scripts/hq_mail/PAUSED\ndocs/PAUSED\nops/a/b/c/d/PAUSED\nops/README\n' | python3 "$PY" --gate-relevant hq >/dev/null; rc=$?
[ "$rc" = 1 ] && ok "--gate-relevant hq: flag names outside the scan rules do not" || no "--gate-relevant hq: scan rules" "rc=$rc"
out="$(printf 'ops/services/demo/demo-t.timer\n' | python3 "$PY" --gate-relevant hq)"; rc=$?
[ "$rc" = 0 ] && ok "--gate-relevant hq: a declared trigger source counts" || no "--gate-relevant hq: trigger" "rc=$rc $out"

# hq-fgg3.17 finding 3: a deleted repo timer file is source-missing, not skipped
mv "$R/ops/services/demo/demo-t.timer" "$T/demo-t.timer.off"
expect_drift "units: deleted repo timer source is source-missing" "units:demo-t.timer:source-missing"
python3 - "$R/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
[u for u in d["units"] if u["unit"] == "demo-t.service"][0]["trigger_source"] = None
json.dump(d, open(p, "w"))
EOF
"$DC" --only units >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "units: trigger_source null declares a source-less trigger" || no "units: trigger_source null" "rc=$rc"
python3 - "$R/ops/config/runtime.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
del [u for u in d["units"] if u["unit"] == "demo-t.service"][0]["trigger_source"]
json.dump(d, open(p, "w"))
EOF
mv "$T/demo-t.timer.off" "$R/ops/services/demo/demo-t.timer"

# hq-fgg3.17 finding 1: a separate repo tree (HQ_ROOT) judged with the live
# box's state (DRIFT_LIVE_ROOT): heartbeats, rigs/ and gitignored files stay live
P="$T/preview-hq"; mkdir -p "$P"
( cd "$R" && tar --exclude=./state --exclude=./rigs -cf - . ) | ( cd "$P" && tar -xf - )
out="$(HQ_ROOT="$P" DRIFT_LIVE_ROOT="$R" HQ_STATE_DIR= "$DC" 2>&1)"; rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q '0 drift item(s), 0 could not check' && ok "live root: a preview tree with live state and rigs is clean" || no "live root: preview clean" "rc=$rc $(printf '%s' "$out" | head -5 | tr '\n' ' ')"
rm -f "$P/ops/scripts/hook-live.sh"
out="$(HQ_ROOT="$P" DRIFT_LIVE_ROOT="$R" HQ_STATE_DIR= "$DC" --json 2>&1)"
printf '%s' "$out" | grep -q '"id": "hooks:hook-live.sh:missing"' && ok "live root: the preview tree's files are the ones judged" || no "live root: preview judged" "$(printf '%s' "$out" | head -c 300)"
touch "$R/ops/mail/PAUSED"
out="$(HQ_ROOT="$P" DRIFT_LIVE_ROOT="$R" HQ_STATE_DIR= "$DC" --json --only switches 2>&1)"
printf '%s' "$out" | grep -q '"id": "switches:ops/mail/PAUSED:undeclared"' && ok "live root: an untracked live flag file is still seen" || no "live root: live flag" "$(printf '%s' "$out" | head -c 300)"
rm -f "$R/ops/mail/PAUSED"; rm -rf "$P"

# --- fail open, boot subset, notify, usage ----------------------------------------
out="$(FAKE_SYSTEMCTL_BROKEN=1 "$DC" 2>&1)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'COULD NOT CHECK\] units'; then ok "broken systemctl is could-not-check, exit 0"
else no "broken systemctl is could-not-check, exit 0" "rc=$rc"; fi
touch "$R/ops/mail/PAUSED"
"$DC" --boot >/dev/null 2>&1; rc=$?; [ "$rc" = 0 ] && ok "--boot runs only units, tmux, heartbeats" || no "--boot subset" "rc=$rc"
rm -f "$R/ops/mail/PAUSED"
printf '#!/bin/sh\necho "$@" >> "%s"\n' "$T/notified" > "$BIN/fake-notify"; chmod +x "$BIN/fake-notify"
setjson user demo-d.service ActiveState inactive
HQ_NOTIFY="$BIN/fake-notify" "$DC" --boot --notify >/dev/null 2>&1; rc=$?
if [ "$rc" = 0 ] && grep -q '^urgent Drift at boot: 1 item' "$T/notified" 2>/dev/null; then ok "--notify sends one urgent notify and exits 0"
else no "--notify sends one urgent notify and exits 0" "rc=$rc $(cat "$T/notified" 2>/dev/null)"; fi
reset_fx
rm -f "$T/notified"; HQ_NOTIFY="$BIN/fake-notify" "$DC" --boot --notify >/dev/null 2>&1
[ ! -e "$T/notified" ] && ok "--notify is silent when clean" || no "--notify is silent when clean"
"$DC" --only nope >/dev/null 2>&1; [ "$?" = 2 ] && ok "unknown check is exit 2" || no "unknown check is exit 2"
mv "$R/ops/config/runtime.json" "$R/ops/config/runtime.json.off"
"$DC" >/dev/null 2>&1; [ "$?" = 3 ] && ok "missing manifest is exit 3" || no "missing manifest is exit 3"
mv "$R/ops/config/runtime.json.off" "$R/ops/config/runtime.json"

[ "$fail" = 0 ] && echo "DRIFT-CHECK TESTS: PASS" || { echo "DRIFT-CHECK TESTS: FAIL"; exit 1; }
