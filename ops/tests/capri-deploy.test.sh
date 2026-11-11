#!/usr/bin/env bash
# Fixture tests for ops/capri/deploy-george.sh (hq-95wuo). Stubbed ssh and george.sh, temp George; no George needed.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$DIR/../.." && pwd)"; D="$REPO/ops/capri/deploy-george.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

bash -n "$D" && ok "bash -n deploy-george.sh" || no "bash -n deploy-george.sh"

# Sweep: no secret-shaped string in the real source (regex, the live token if readable, gitleaks if installed).
"$D" --scan >/dev/null 2>"$T/scan.err"; eq "real source scan clean" $? 0
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks dir "$REPO/ops/capri" --no-banner >/dev/null 2>&1; eq "gitleaks ops/capri clean" $? 0
fi
PYTHONPYCACHEPREFIX="$T/pyc" python3 -m compileall -q "$REPO/tools/capri" "$REPO/tools/capri-hands" "$REPO/tools/capri-voice" >/dev/null
eq "compileall tools/capri*" $? 0

# Fixture repo: a copy of the real Capri trees (so the deployable set is the real one), a temp George.
SRC="$T/src"; G="$T/george"; mkdir -p "$SRC/tools" "$G/AppData/Local/capri-hands"
for d in capri capri-hands capri-voice; do cp -r "$REPO/tools/$d" "$SRC/tools/"; done
find "$SRC" -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null
# The fixture is a git checkout: the deploy copies tracked files only. It keeps the real tree's one pinned
# regex hit (a stale per-boot console key in tools/capri/tests/test_core.py, SCAN_ALLOW in the script).
gitc(){ git -C "$1" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "${@:2}"; }
git -C "$SRC" init -q && gitc "$SRC" add tools && gitc "$SRC" commit -qm fixture || no "fixture git init"
echo "fixturetoken0123456789abcdef" >"$G/AppData/Local/capri-hands/token"
cat >"$T/ssh" <<'S'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG"
[ "$STUB_MODE" = down ] && { echo "ssh: connect timed out" >&2; exit 255; }
[ -n "${STUB_FAIL:-}" ] && case "$*" in *"$STUB_FAIL"*) echo "ERROR: stub failure" ; exit 1 ;; esac
case "$*" in
  *"echo ok"*) printf 'ok\r\n' ;;
  *"schtasks /Query"*) [ "$STUB_LISTENER" = running ] && printf 'TaskName:  \\capri\r\nStatus:    Running\r\n' || printf 'Status:    Ready\r\n' ;;
  *) echo "SUCCESS" ;;
esac
S
cat >"$T/george.sh" <<'S'
#!/usr/bin/env bash
[ "$STUB_HANDS" = up ] && echo '{"ok":true,"windows":[]}' || exit 3
S
chmod +x "$T/ssh" "$T/george.sh"
export CAPRI_SRC="$SRC" CAPRI_GEORGE_ROOT="$G" GEORGE_SSH="$T/ssh" CAPRI_GEORGE_SH="$T/george.sh" \
  CAPRI_VERIFY_TRIES=2 CAPRI_VERIFY_SLEEP=0 STUB_LOG="$T/log" STUB_MODE=up STUB_LISTENER=running STUB_HANDS=up STUB_FAIL=
unset CAPRI_TOKEN_FILE CAPRI_WIN_HOME
: >"$T/log"

"$D" --part bogus >/dev/null 2>&1; eq "unknown part exit 2" $? 2
"$D" --bogus >/dev/null 2>&1; eq "unknown flag exit 2" $? 2
"$D" --check --scan >/dev/null 2>&1; eq "two modes exit 2" $? 2
mkdir -p "$T/nogit/tools"; cp -r "$SRC/tools/." "$T/nogit/tools/"
CAPRI_SRC="$T/nogit" "$D" --scan >/dev/null 2>&1; eq "source not a git checkout exit 2" $? 2

# Fail closed: gitleaks missing refuses the scan unless --allow-no-gitleaks.
CAPRI_GITLEAKS="$T/no-gitleaks" "$D" --scan >/dev/null 2>"$T/err"; eq "gitleaks absent scan exit 7" $? 7
grep -qx 'gitleaks: not installed, regex sweep only' "$T/err" && ok "gitleaks absent says regex only" || no "gitleaks absent message" "$(cat "$T/err")"
CAPRI_GITLEAKS="$T/no-gitleaks" "$D" >/dev/null 2>&1; eq "gitleaks absent deploy exit 7" $? 7
[ -e "$G/capri-hands" ] && no "gitleaks absent copied nothing" || ok "gitleaks absent copied nothing"
CAPRI_GITLEAKS="$T/no-gitleaks" "$D" --scan --allow-no-gitleaks >/dev/null 2>&1; eq "gitleaks absent with allow flag exit 0" $? 0
"$D" --scan >"$T/out" 2>&1; eq "fixture scan clean" $? 0
grep -q 'scan clean: [0-9]* tracked files' "$T/out" && ok "scan names the tracked count" || no "scan count" "$(cat "$T/out")"

# Fail closed: George unreachable.
CAPRI_GEORGE_ROOT="$T/nope" "$D" --check >/dev/null 2>&1; eq "check, George mount missing exit 3" $? 3
CAPRI_GEORGE_ROOT="$T/nope" "$D" >/dev/null 2>&1; eq "deploy, George mount missing exit 3" $? 3
STUB_MODE=down "$D" >/dev/null 2>&1; eq "deploy, ssh down exit 3" $? 3
[ -e "$G/capri-hands" ] && no "ssh down copied nothing" || ok "ssh down copied nothing"

# Fail closed: token file missing.
CAPRI_TOKEN_FILE="$T/none" "$D" --check >/dev/null 2>&1; eq "check, token missing exit 4" $? 4
CAPRI_TOKEN_FILE="$T/none" "$D" >/dev/null 2>&1; eq "deploy, token missing exit 4" $? 4
[ -e "$G/capri-hands" ] && no "token missing copied nothing" || ok "token missing copied nothing"

# Bootstrap (new PC): copies files only, no ssh, no token, no task; leaves every part pending.
G0="$G"; G="$T/george-boot"; mkdir -p "$G"
: >"$T/log"; CAPRI_GEORGE_ROOT="$G" CAPRI_TOKEN_FILE="$T/none" "$D" --bootstrap >"$T/out" 2>&1; eq "bootstrap exit 0 without a token" $? 0
[ -s "$T/log" ] && no "bootstrap makes no ssh call" "$(head -3 "$T/log")" || ok "bootstrap makes no ssh call"
cmp -s "$SRC/tools/capri-hands/hands/core.py" "$G/capri-hands/hands/core.py" && [ -f "$G/capri-voice/live.bat" ] && ok "bootstrap copied all three trees" || no "bootstrap copy"
[ -e "$G/capri-hands/hands-task.xml" ] && no "bootstrap writes no task xml" || ok "bootstrap writes no task xml"
[ -f "$G/capri-hands/.deploy-pending" ] && [ -f "$G/capri/.deploy-pending" ] && ok "bootstrap leaves parts pending" || no "bootstrap marker"
cmp -s "$SRC/tools/capri/capri.json.example" "$G/capri/capri.json" && ok "bootstrap seeds capri.json" || no "bootstrap capri.json"
echo "fixturetoken0123456789abcdef" >"$T/boot-token"
CAPRI_GEORGE_ROOT="$G" CAPRI_TOKEN_FILE="$T/boot-token" "$D" --check >"$T/out" 2>&1; eq "check after bootstrap exit 1" $? 1
grep -qx 'drift: hands .deploy-pending (last activation did not finish)' "$T/out" && ok "check names the pending marker" || no "check pending" "$(head -5 "$T/out")"
: >"$T/log"; CAPRI_GEORGE_ROOT="$G" CAPRI_TOKEN_FILE="$T/boot-token" "$D" >"$T/out" 2>&1; eq "deploy after bootstrap exit 0" $? 0
grep -q 'schtasks /Create /TN capri-hands' "$T/log" && grep -q 'schtasks /Create /TN capri /' "$T/log" && ok "deploy after bootstrap registers both tasks" || no "post-bootstrap register"
[ -e "$G/capri-hands/.deploy-pending" ] || [ -e "$G/capri/.deploy-pending" ] || [ -e "$G/capri-voice/.deploy-pending" ] && no "markers cleared after deploy" || ok "markers cleared after deploy"
G="$G0"

# Fresh George: check reports drift, deploy copies everything, registers both tasks, verifies.
"$D" --check >"$T/out" 2>&1; eq "check on empty George exit 1" $? 1
grep -q '^drift: hands hands/core.py (missing on George)' "$T/out" && ok "missing file named" || no "missing file named"
mkdir -p "$G/capri/venv" && echo keep >"$G/capri/venv/keep" && echo old >"$G/capri/core.py.bak-1"
: >"$T/log"; "$D" >"$T/out" 2>&1; eq "first deploy exit 0" $? 0
cmp -s "$SRC/tools/capri/capri/core.py" "$G/capri/capri/core.py" && ok "listener source copied" || no "listener source copied"
cmp -s "$SRC/tools/capri-voice/live.bat" "$G/capri-voice/live.bat" && ok "voice CRLF launcher copied byte for byte" || no "voice launcher bytes"
[ -e "$G/capri/tests" ] || [ -e "$G/capri/README.md" ] || [ -e "$G/capri-hands/probe.sh" ] && no "repo-only files stay off George" || ok "repo-only files stay off George"
[ "$(head -c2 "$G/capri-hands/hands-task.xml" | xxd -p)" = fffe ] && ok "task xml written UTF-16LE with BOM" || no "xml BOM"
iconv -f UTF-16 -t UTF-8 "$G/capri/capri-task.xml" | cmp -s - "$SRC/tools/capri/capri-task.xml" && ok "task xml round-trips" || no "xml round trip"
cmp -s "$SRC/tools/capri/capri.json.example" "$G/capri/capri.json" && ok "capri.json installed from example" || no "capri.json example"
grep -q 'schtasks /Create /TN capri-hands /XML C:\\Users\\owner\\capri-hands\\hands-task.xml /F' "$T/log" && ok "hands task registered" || no "hands task registered" "$(grep Create "$T/log")"
grep -q 'schtasks /Create /TN capri /XML' "$T/log" && ok "listener task registered" || no "listener task registered"
eq "two restarts on first deploy" "$(grep -c 'schtasks /End' "$T/log")" 2
[ -f "$G/capri/venv/keep" ] && [ -f "$G/capri/core.py.bak-1" ] && ok "George-only files kept" || no "George-only files kept"

"$D" --check >"$T/out" 2>&1; eq "check after deploy exit 0" $? 0

# Idempotent: nothing changed, nothing restarted, still verified.
: >"$T/log"; "$D" >"$T/out" 2>&1; eq "second deploy exit 0" $? 0
grep -q 'schtasks /End\|schtasks /Create' "$T/log" && no "no restart when unchanged" || ok "no restart when unchanged"
grep -q 'schtasks /Query' "$T/log" && ok "listener still verified" || no "listener still verified"

# Planted drift: check catches it and exits non-zero; deploy fixes it and restarts only that part.
echo "# drift" >>"$G/capri/capri/core.py"
"$D" --check >"$T/out" 2>&1; eq "planted drift check exit 1" $? 1
grep -qx 'drift: listener capri/core.py (differs)' "$T/out" && ok "drift line names the file" || no "drift line" "$(cat "$T/out")"
printf 'x' >>"$G/capri-hands/hands-task.xml"
"$D" --check --part hands >"$T/out" 2>&1; eq "xml drift check exit 1" $? 1
: >"$T/log"; "$D" >"$T/out" 2>&1; eq "deploy over drift exit 0" $? 0
grep -q 'schtasks /End /TN capri & ' "$T/log" && ok "listener restarted" || no "listener restarted"
grep -q 'schtasks /Create /TN capri-hands' "$T/log" && ok "hands task re-registered after xml drift" || no "hands re-register"
grep -q 'schtasks /Create /TN capri /' "$T/log" && no "listener xml untouched" || ok "listener xml untouched"
"$D" --check >/dev/null 2>&1; eq "check clean after fix" $? 0
grep -q 'drift' "$G/capri/capri/core.py" && no "drift overwritten" || ok "drift overwritten"

# Tracked files only: an ignored capri.json, venv, model dir and log, and an untracked file, stay on hqbox;
# George's real capri.json is never overwritten.
echo '{"device":"george-real"}' >"$G/capri/capri.json"
echo '{"device":"hqbox-local"}' >"$SRC/tools/capri/capri.json"
mkdir -p "$SRC/tools/capri/venv" "$SRC/tools/capri/sherpa-onnx-x" "$SRC/tools/capri-voice/models"
echo v >"$SRC/tools/capri/venv/pyvenv.cfg"; echo m >"$SRC/tools/capri/sherpa-onnx-x/m.onnx"
echo m >"$SRC/tools/capri-voice/models/big.onnx"; echo l >"$SRC/tools/capri/run.log"; echo u >"$SRC/tools/capri/capri/untracked.py"
echo "# t" >>"$SRC/tools/capri/capri/core.py"   # a real change so the listener copies
: >"$T/log"; "$D" >"$T/out" 2>&1; eq "deploy with ignored local files exit 0" $? 0
grep -qx '{"device":"george-real"}' "$G/capri/capri.json" && ok "George capri.json unchanged" || no "George capri.json" "$(cat "$G/capri/capri.json")"
[ -e "$G/capri/venv/pyvenv.cfg" ] || [ -e "$G/capri/sherpa-onnx-x" ] || [ -e "$G/capri-voice/models/big.onnx" ] || [ -e "$G/capri/run.log" ] \
  && no "ignored files not copied" || ok "ignored files not copied"
[ -e "$G/capri/capri/untracked.py" ] && no "untracked file not copied" || ok "untracked file not copied"
"$D" --check >/dev/null 2>&1; eq "check clean with ignored local files" $? 0
rm -rf "${SRC:?}/tools/capri/capri.json" "$SRC/tools/capri/venv" "$SRC/tools/capri/sherpa-onnx-x" "$SRC/tools/capri-voice/models" "$SRC/tools/capri/run.log" "$SRC/tools/capri/capri/untracked.py"

# Retry-safe activation: a failed restart leaves the marker; the next run with identical files restarts again.
echo "# r" >>"$SRC/tools/capri/capri/core.py"
: >"$T/log"; STUB_FAIL='schtasks /End' "$D" --part listener >"$T/out" 2>&1; eq "failed restart exit 1" $? 1
[ -f "$G/capri/.deploy-pending" ] && ok "failed restart leaves the marker" || no "marker after failed restart"
cmp -s "$SRC/tools/capri/capri/core.py" "$G/capri/capri/core.py" && ok "files already match after the failed run" || no "files match"
"$D" --check --part listener >"$T/out" 2>&1; eq "check reports pending marker exit 1" $? 1
grep -qx 'drift: listener .deploy-pending (last activation did not finish)' "$T/out" && ok "pending marker is drift" || no "pending drift" "$(cat "$T/out")"
: >"$T/log"; "$D" --part listener >"$T/out" 2>&1; eq "retry run exit 0" $? 0
grep -q 'schtasks /End /TN capri & ' "$T/log" && ok "retry run restarts with identical files" || no "retry restart" "$(cat "$T/out")"
grep -q 'schtasks /Create /TN capri /' "$T/log" && ok "retry run re-registers the task" || no "retry register"
[ -e "$G/capri/.deploy-pending" ] && no "marker cleared after success" || ok "marker cleared after success"
printf 'x' >>"$G/capri-hands/hands-task.xml"   # xml drift: the deploy rewrites it, then /Create fails
: >"$T/log"; STUB_FAIL='schtasks /Create' "$D" --part hands >/dev/null 2>&1; eq "failed register exit 1" $? 1
"$D" --check --part hands >"$T/out" 2>/dev/null
[ "$(cat "$T/out")" = 'drift: hands .deploy-pending (last activation did not finish)' ] \
  && ok "xml rewritten, only the marker is drift" || no "after failed register" "$(cat "$T/out")"
: >"$T/log"; "$D" --part hands >/dev/null 2>&1; eq "retry after failed register exit 0" $? 0
grep -q 'schtasks /Create /TN capri-hands' "$T/log" && ok "retry re-registers after a failed register" || no "register retry"
echo "# r3" >>"$SRC/tools/capri/capri/core.py"
STUB_LISTENER=stopped "$D" --part listener >/dev/null 2>&1; eq "failed verify exit 1" $? 1
[ -f "$G/capri/.deploy-pending" ] && ok "failed verify leaves the marker" || no "marker after failed verify"
: >"$T/log"; "$D" --part listener >/dev/null 2>&1; eq "retry after failed verify exit 0" $? 0
grep -q 'schtasks /End /TN capri & ' "$T/log" && ok "retry after failed verify restarts" || no "verify retry restart"

# Fail closed: the marker cannot be written or read.
if [ "$(id -u)" != 0 ]; then
  echo "# m" >>"$SRC/tools/capri-voice/voice/core.py"; chmod 555 "$G/capri-voice"
  "$D" --part voice >/dev/null 2>&1; eq "marker not writable exit 6" $? 6
  chmod 755 "$G/capri-voice"; grep -q '# m' "$G/capri-voice/voice/core.py" && no "unwritable marker copied nothing" || ok "unwritable marker copied nothing"
  chmod 000 "$G/capri-voice"; "$D" --check --part voice >/dev/null 2>&1; eq "marker dir unreadable exit 6" $? 6
  chmod 755 "$G/capri-voice"; "$D" --part voice >/dev/null 2>&1; eq "voice deploy after restore exit 0" $? 0
fi

# Verify failures.
echo "# v" >>"$SRC/tools/capri-hands/hands/core.py"
STUB_HANDS=down "$D" --part hands >/dev/null 2>&1; eq "hands not answering exit 1" $? 1
echo "# v" >>"$SRC/tools/capri/capri/core.py"
STUB_LISTENER=stopped "$D" --part listener >/dev/null 2>&1; eq "listener not running exit 1" $? 1

# Fail closed: a secret-shaped string in a source file refuses before anything is copied.
"$D" >/dev/null 2>&1   # settle
cp -r "$SRC" "$T/src2"
echo 'API_''KEY = "abcd1234''efgh5678ijkl"' >>"$T/src2/tools/capri/capri/core.py"
CAPRI_SRC="$T/src2" "$D" >"$T/out" 2>&1; eq "secret in source deploy exit 5" $? 5
grep -q 'abcd1234efgh5678ijkl' "$T/out" && no "secret value not echoed" || ok "secret value not echoed"
grep -q 'API_KEY' "$G/capri/capri/core.py" && no "secret not copied" || ok "secret not copied"
CAPRI_SRC="$T/src2" "$D" --scan >/dev/null 2>&1; eq "secret in source scan exit 5" $? 5
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo '# fixturetoken0123456789abcdef' >>"$T/src2/tools/capri-voice/voice/tools.py"
CAPRI_SRC="$T/src2" "$D" --scan >"$T/out" 2>&1; eq "live hands token in source exit 5" $? 5
grep -q 'hands token found in: .*voice/tools.py' "$T/out" && ok "token hit names the file" || no "token hit" "$(cat "$T/out")"
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'k = "-----BEGIN RSA PRIVATE'' KEY-----"' >>"$T/src2/tools/capri-hands/hands/win.py"
CAPRI_SRC="$T/src2" "$D" --scan >/dev/null 2>&1; eq "private key in source exit 5" $? 5
# The sweep covers every tracked file: a .sh probe, a test, a README (none of them deployed).
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'TOK''EN="ghp''_abcdefghijklmnopqrstuvwxyz0123"' >>"$T/src2/tools/capri-hands/probe.sh"
CAPRI_SRC="$T/src2" "$D" --scan >"$T/out" 2>&1; eq "secret in tracked .sh exit 5" $? 5
grep -q 'secret-shaped: tools/capri-hands/probe.sh:' "$T/out" && ok "sh hit names the file" || no "sh hit" "$(cat "$T/out")"
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'k = "AKIA''ABCDEFGHIJKLMNOP"' >>"$T/src2/tools/capri-voice/tests/test_voice.py"
CAPRI_SRC="$T/src2" "$D" --scan >/dev/null 2>&1; eq "secret in tracked test exit 5" $? 5
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'xoxb''-1234567890-abcdefghij' >>"$T/src2/tools/capri/README.md"
CAPRI_SRC="$T/src2" "$D" --scan >/dev/null 2>&1; eq "secret in tracked README exit 5" $? 5
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'k = "AKIA''ABCDEFGHIJKLMNOP"' >>"$T/src2/tools/capri/capri.json"   # ignored: never scanned, never copied
CAPRI_SRC="$T/src2" "$D" --scan >/dev/null 2>&1; eq "secret in an ignored file does not block" $? 0
# The pinned allowlist is narrow: the known stale key passes in its own file only, and any other hit there refuses.
grep -q 'eb981ae5ab4829b28e6c07402a4a5aef52191efe910b3332' "$SRC/tools/capri/tests/test_core.py" && ok "fixture keeps the pinned hit" || no "pinned hit present"
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'k = "eb981ae5ab4829b28e6c07402a4a5aef52191efe910b3332"' >>"$T/src2/tools/capri-hands/hands/win.py"
CAPRI_SRC="$T/src2" "$D" --scan >"$T/out" 2>&1; eq "pinned value in another file exit 5" $? 5
grep -q 'eb981ae5' "$T/out" && no "pinned value not echoed" || ok "pinned value not echoed"
rm -rf "$T/src2"; cp -r "$SRC" "$T/src2"
echo 'k = "0123456789abcdef0123456789abcdef0123456789abcdef"' >>"$T/src2/tools/capri/tests/test_core.py"
CAPRI_SRC="$T/src2" "$D" --scan >"$T/out" 2>&1; eq "new hex in the allowlisted file exit 5" $? 5
[ "$(grep -c '^secret-shaped: ' "$T/out")" = 1 ] && ok "only the new hit is reported" || no "allowlist report" "$(cat "$T/out")"

exit $fail
