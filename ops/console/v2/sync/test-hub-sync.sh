#!/usr/bin/env bash
# Local end-to-end test for hub-sync.sh with three temp repos: origin (bare, stands in for GitHub),
# the mirror (managed by hub-sync), and a owner-side clone whose remote is the mirror.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d /tmp/hubsync.XXXXXX)"
export HUB_MIRRORS="$T/mirrors" HUB_REPOS_CONF="$T/repos.conf" HUB_CRED_FILE="$T/cred" HUB_LOCK="$T/lock" HUB_HEARTBEAT="$T/hb" HUB_STATUS="$T/status.json"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
pass=0; fail=0
ok(){ echo "PASS $1"; pass=$((pass+1)); }
ko(){ echo "FAIL $1"; fail=$((fail+1)); }
q(){ "$@" >/dev/null 2>&1; }

# origin with one commit on main
q git init --bare -b main "$T/origin.git"
q git clone -q "$T/origin.git" "$T/seed"; q git -C "$T/seed" commit --allow-empty -m init; q git -C "$T/seed" push -q origin main
: >"$HUB_CRED_FILE"; : >"$HUB_LOCK"

# 1. init mirror
"$HERE/hub-sync.sh" --init demo "$T/origin.git" main >"$T/init.log" 2>&1 && [ -d "$HUB_MIRRORS/demo.git" ] && ok "init mirror" || ko "init mirror"

# 2. owner-side clone from the mirror, commit, push to the mirror, hub-sync forwards to origin
q git clone -q "$HUB_MIRRORS/demo.git" "$T/owner"; q git -C "$T/owner" commit --allow-empty -m "from owner"; q git -C "$T/owner" push -q origin main
"$HERE/hub-sync.sh" >"$T/c1.log" 2>&1
[ "$(git -C "$T/origin.git" rev-parse main)" = "$(git -C "$T/owner" rev-parse HEAD)" ] && ok "forward owner commit to origin" || ko "forward owner commit to origin"

# 3. commit on origin (another box), hub-sync fetches into mirror, owner fast-forwards
q git -C "$T/seed" pull -q --ff-only; q git -C "$T/seed" commit --allow-empty -m "from laptop"; q git -C "$T/seed" push -q origin main
"$HERE/hub-sync.sh" >"$T/c2.log" 2>&1
[ "$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)" = "$(git -C "$T/seed" rev-parse HEAD)" ] && ok "mirror follows origin" || ko "mirror follows origin"
q git -C "$T/owner" pull -q --ff-only && ok "owner fast-forwards from mirror" || ko "owner fast-forwards from mirror"
grep -q '"demo":"ok"' "$HUB_STATUS" && ! grep -q 'PUSH FAILED' "$T/c2.log" && ok "origin-ahead cycle is clean (no push rejection)" || ko "origin-ahead cycle reported a failure"

# 4. divergence with a clean replay: owner pushes to mirror while origin moved separately;
#    hub-sync merges origin's tip into the mirror branch and forwards the result
echo d1 > "$T/owner/d1"; q git -C "$T/owner" add d1; q git -C "$T/owner" commit -m "owner side"; q git -C "$T/owner" push -q origin main
echo l1 > "$T/seed/l1"; q git -C "$T/seed" add l1; q git -C "$T/seed" commit -m "laptop side"; q git -C "$T/seed" push -q origin main
"$HERE/hub-sync.sh" >"$T/c3.log" 2>&1
grep -q 'merged origin into demo/main' "$T/c3.log" && ok "diverged (clean): origin merged into mirror" || ko "diverged (clean): not merged"
git -C "$T/origin.git" log --format=%s -3 main | grep -q "owner side" && ok "diverged (clean): owner commit forwarded to origin" || ko "diverged (clean): not forwarded"
[ "$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)" = "$(git -C "$T/origin.git" rev-parse main)" ] && ok "diverged (clean): mirror equals origin afterwards" || ko "diverged (clean): mirror differs from origin"
grep -q '"demo":"ok"' "$HUB_STATUS" && ok "diverged (clean): status ok" || ko "diverged (clean): status not ok"
# 4b. divergence with a conflicting replay stays diverged and is reported
q git -C "$T/owner" fetch -q origin; q git -C "$T/owner" reset -q --hard origin/main
echo A > "$T/owner/same"; q git -C "$T/owner" add same; q git -C "$T/owner" commit -m "owner conflict"; q git -C "$T/owner" push -q origin main
q git -C "$T/seed" pull -q --ff-only 2>/dev/null || q git -C "$T/seed" reset -q --hard origin/main
echo B > "$T/seed/same"; q git -C "$T/seed" add same; q git -C "$T/seed" commit -m "laptop conflict"; q git -C "$T/seed" push -q origin main
"$HERE/hub-sync.sh" >"$T/c3b.log" 2>&1
grep -qE 'DIVERGED' "$T/c3b.log" && grep -q '"demo":"diverged"' "$HUB_STATUS" && ok "diverged (conflict): reported and left alone" || ko "diverged (conflict): not reported"
[ "$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)" = "$(git -C "$T/owner" rev-parse HEAD)" ] && ok "diverged (conflict): mirror keeps owner's tip" || ko "diverged (conflict): mirror clobbered"
# resolve for the later cases: take origin
q git -C "$HUB_MIRRORS/demo.git" update-ref refs/heads/main "$(git -C "$T/origin.git" rev-parse main)"
q git -C "$T/owner" fetch -q origin; q git -C "$T/owner" reset -q --hard origin/main

# 5. dolt refs forward
q git -C "$T/owner" update-ref refs/dolt/data "$(git -C "$T/owner" rev-parse HEAD)"; q git -C "$T/owner" push -q origin refs/dolt/data:refs/dolt/data
q git -C "$T/seed" reset -q --hard "$(git -C "$T/origin.git" rev-parse main)"
# resolve the divergence first: rebase owner onto origin main via the mirror route is out of scope; just check dolt push happens
"$HERE/hub-sync.sh" >"$T/c4.log" 2>&1
git -C "$T/origin.git" rev-parse -q --verify refs/dolt/data >/dev/null 2>&1 && ok "refs/dolt forwarded" || ko "refs/dolt forwarded"

# 6. heartbeat + lock file used
[ -s "$HUB_HEARTBEAT" ] && ok "heartbeat written" || ko "heartbeat written"
grep -q '"demo":"' "$HUB_STATUS" && ok "status.json written" || ko "status.json written"
# 7. credential self-heal and one-alert auth outage
export HUB_CRED_BACKUP="$T/cred.bak" HUB_AUTH_STATE="$T/auth" HUB_NOTIFY="$T/notify.sh" HUB_AUTH_ALERT_AFTER=3 HUB_AUTH_ALERT_STATE="$T/alert-state"
printf '#!/bin/bash\necho "$@" >>"%s/alerts"\n' "$T" >"$T/notify.sh"; chmod +x "$T/notify.sh"
echo "https://u:p@example.invalid" >"$HUB_CRED_FILE"; "$HERE/hub-sync.sh" >/dev/null 2>&1
cmp -s "$HUB_CRED_FILE" "$HUB_CRED_BACKUP" && ok "good store backed up" || ko "good store backed up"
: >"$HUB_CRED_FILE"; "$HERE/hub-sync.sh" >"$T/h.log" 2>&1
[ -s "$HUB_CRED_FILE" ] && grep -q HEALED "$T/h.log" && ok "empty store re-seeded within one cycle" || ko "empty store re-seeded"
rm -f "$HUB_CRED_FILE"; "$HERE/hub-sync.sh" >/dev/null 2>&1
[ -s "$HUB_CRED_FILE" ] && ok "missing store re-seeded" || ko "missing store re-seeded"
# a remote that rejects the stored credential: it challenges, git sends the store's credential for
# this exact host, the server logs the Authorization header and answers 401 anyway
cat >"$T/h401.py" <<'PY'
import http.server,sys
LOG=sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        a=s.headers.get("Authorization")
        if a: open(LOG,"a").write(a+"\n")
        s.send_response(401); s.send_header("WWW-Authenticate",'Basic realm="x"'); s.end_headers()
    do_POST=do_GET
    def log_message(*a): pass
http.server.HTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
PY
PORT=$((20000 + RANDOM % 20000)); python3 "$T/h401.py" "$PORT" "$T/authlog" & SRV=$!; sleep 1
printf 'http://hubuser:hubtoken@127.0.0.1:%s\n' "$PORT" >"$HUB_CRED_FILE"; cp "$HUB_CRED_FILE" "$T/cred.orig"
GOODURL="$(git -C "$HUB_MIRRORS/demo.git" config remote.origin.url)"
git -C "$HUB_MIRRORS/demo.git" config remote.origin.url "http://127.0.0.1:$PORT/x.git"
auth_n(){ jq -r '.auth.failing_cycles' "$HUB_STATUS" 2>/dev/null; }
auth_since(){ jq -r '.auth.since' "$HUB_STATUS" 2>/dev/null; }
alerts(){ [ -f "$T/alerts" ] && wc -l <"$T/alerts" || echo 0; }
cycle(){ "$HERE/hub-sync.sh" >/dev/null 2>&1; "$HERE/hub-auth-alert.sh" >/dev/null 2>&1; }
rm -f "$T/alerts"
for i in 1 2; do "$HERE/hub-sync.sh" >/dev/null 2>&1; done
"$HERE/hub-auth-alert.sh" >/dev/null 2>&1
[ "$(alerts)" -eq 0 ] && ok "no alert below the threshold (2 cycles)" || ko "alerted before 3 cycles"
for i in 3 4 5; do "$HERE/hub-sync.sh" >/dev/null 2>&1; done
[ "$(alerts)" -eq 0 ] && ok "hub-sync itself never runs the notifier (hqsync cannot reach owner's notify.sh)" || ko "hub-sync called the notifier"
for i in 1 2; do "$HERE/hub-auth-alert.sh" >/dev/null 2>&1; done
[ "$(alerts)" -eq 1 ] && ok "5 failing cycles produce exactly 1 alert (owner side)" || ko "alert count $(alerts) after 5 cycles"
[ "$(auth_n)" = 5 ] && ok "status.json publishes 5 failing cycles" || ko "status.json auth.failing_cycles=$(auth_n)"
grep -q 'GitHub auth failing' "$T/alerts" 2>/dev/null && grep -q 'demo' "$T/alerts" && ok "alert names the repo" || ko "alert text lacks repo"
grep -qx "Basic $(printf 'hubuser:hubtoken' | base64)" "$T/authlog" 2>/dev/null && ok "server received the stored credential for this host" || ko "server saw no authenticated request"
cmp -s "$HUB_CRED_FILE" "$T/cred.orig" && ok "rejected auth leaves the store byte for byte" || ko "store changed by rejected auth"
SINCE1="$(auth_since)"
# a network blip inside the outage (connection refused, not auth) is not a success
git -C "$HUB_MIRRORS/demo.git" config remote.origin.url "http://127.0.0.1:1/x.git"; cycle
[ "$(auth_n)" = 5 ] && [ "$(auth_since)" = "$SINCE1" ] && ok "network blip keeps the outage count and start" || ko "blip changed auth state: $(auth_n) $(auth_since) vs 5 $SINCE1"
git -C "$HUB_MIRRORS/demo.git" config remote.origin.url "http://127.0.0.1:$PORT/x.git"
for i in 1 2 3; do cycle; done
[ "$(alerts)" -eq 1 ] && ok "one outage with a blip still gives 1 alert" || ko "alert count $(alerts) after blip"
[ "$(auth_n)" = 8 ] && ok "count continues across the blip" || ko "count $(auth_n) after blip"
# a real success ends the outage; the next outage alerts once more
git -C "$HUB_MIRRORS/demo.git" config remote.origin.url "$GOODURL"; cycle
[ "$(auth_n)" = 0 ] && [ "$(auth_since)" = "" ] && [ "$(head -1 "$HUB_AUTH_STATE")" = "0 " ] && ok "success resets the auth counter" || ko "counter not reset: $(auth_n) $(auth_since)"
sleep 1; git -C "$HUB_MIRRORS/demo.git" config remote.origin.url "http://127.0.0.1:$PORT/x.git"
for i in 1 2 3 4; do cycle; done
[ "$(alerts)" -eq 2 ] && ok "a new outage after a success alerts once more" || ko "alert count $(alerts) for second outage"
kill "$SRV" 2>/dev/null
git -C "$HUB_MIRRORS/demo.git" config remote.origin.url "$GOODURL"
# a failed notify is retried on the next run, then stays quiet
printf '{"at":"x","repos":{},"auth":{"failing_cycles":4,"since":"2026-01-01T00:00:00Z","error":"r push: e"}}\n' >"$T/st2.json"
printf '#!/bin/bash\nexit 1\n' >"$T/nofail.sh"; chmod +x "$T/nofail.sh"
HUB_STATUS="$T/st2.json" HUB_NOTIFY="$T/nofail.sh" HUB_AUTH_ALERT_STATE="$T/as2" "$HERE/hub-auth-alert.sh" >/dev/null 2>&1
rm -f "$T/alerts"
for i in 1 2; do HUB_STATUS="$T/st2.json" HUB_AUTH_ALERT_STATE="$T/as2" "$HERE/hub-auth-alert.sh" >/dev/null 2>&1; done
[ "$(alerts)" -eq 1 ] && ok "failed notify retried once, then quiet" || ko "retry alert count $(alerts)"
HUB_STATUS="$T/missing.json" "$HERE/hub-auth-alert.sh" >/dev/null 2>&1 && ok "missing status.json is silent" || ko "missing status.json errored"
# 8. auth state, heartbeat and status.json are written before the lock is released (lucy round 1)
body="$(sed -n '/^sync_all() {/,/^}/p' "$HERE/hub-sync.sh")"
ln(){ printf '%s\n' "$body" | grep -n -m1 -F -- "$1" | cut -d: -f1; }
u="$(ln 'flock -u 9')"; a="$(ln 'auth_track')"; s="$(ln 'mv -f "$STATUS.tmp"')"
[ -n "$u" ] && [ -n "$a" ] && [ -n "$s" ] && [ "$a" -lt "$u" ] && [ "$s" -lt "$u" ] && ok "state writes happen under the lock" || ko "state written after unlock (auth=$a status=$s unlock=$u)"
echo "hub-sync tests: $pass passed, $fail failed (workdir $T)"
[ "$fail" -eq 0 ]
