#!/usr/bin/env bash
# plan-usage.py: the token never reaches the cache or stderr, a reply without a
# "limits" list still gives meters, and junk numbers never become Infinity.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$HERE/../services/plan-usage/plan-usage.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0; ok(){ echo "ok - $1"; }; bad(){ echo "not ok - $1"; fail=1; }

# 1. a token that breaks the header: the failure text must not carry it
printf '{"claudeAiOauth":{"accessToken":"sk-ant-SECRET-%s\\n"}}' "$RANDOM" > "$T/creds.json"
tok="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["claudeAiOauth"]["accessToken"].strip())' "$T/creds.json")"
HQ_CLAUDE_CREDS="$T/creds.json" HQ_USAGE_CACHE="$T/cache.json" python3 -I "$PY" 2> "$T/err"
if grep -q "$tok" "$T/cache.json" "$T/err"; then bad "token leaked on a header error"; else ok "no token in cache or stderr on a header error"; fi
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["error"]' "$T/cache.json" && ok "failure is recorded" || bad "failure not recorded"

# 1b. the same bad token while the cache cannot be written either (lucy round 2)
mkdir -p "$T/dircache"
HQ_CLAUDE_CREDS="$T/creds.json" HQ_USAGE_CACHE="$T/dircache" python3 -I "$PY" 2> "$T/err2"; rc=$?
if grep -q "$tok" "$T/err2"; then bad "token leaked when the cache write also failed"; else ok "no token on a double failure (rc $rc)"; fi
grep -q Traceback "$T/err2" && bad "traceback printed on a double failure" || ok "no traceback on a double failure"

# 2. no login at all
HQ_CLAUDE_CREDS="$T/none.json" HQ_USAGE_CACHE="$T/c2.json" python3 -I "$PY" 2>/dev/null
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["error"]=="no Claude login on this box",d' "$T/c2.json" && ok "missing login is a fixed message" || bad "missing login message"

# 3. shape(): named windows only, and hostile numbers
python3 -I - "$PY" <<'PYT' && ok "shape: fallback windows, bounded, finite" || bad "shape checks"
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pu", sys.argv[1]); pu = importlib.util.module_from_spec(spec); spec.loader.exec_module(pu)
out = pu.shape({"five_hour": {"utilization": 42, "resets_at": "2026-10-20T08:30:00Z"},
                "seven_day": {"utilization": 18, "resets_at": "2026-10-27T04:00:00Z"}})
assert [l["label"] for l in out["limits"]] == ["5 h", "Week"], out["limits"]
assert out["limits"][0]["percent"] == 42 and out["pct"] == 42
bad = pu.shape(json.loads('{"five_hour":{"utilization":1e309,"resets_at":"<script>"},"limits":[' + ",".join(['{"kind":"session","percent":1e309}'] * 50) + ']}'))
assert bad["pct"] is None and bad["reset"] is None
assert len(bad["limits"]) == pu.MAX_LIMITS and all(l["percent"] is None for l in bad["limits"])
json.dumps(bad, allow_nan=False)
PYT

# 4. an empty 200 keeps the last good numbers; impossible dates are dropped
python3 -I - "$PY" <<'PYT' && ok "empty reply rejected, impossible dates dropped" || bad "empty reply / dates"
import importlib.util, sys
spec = importlib.util.spec_from_file_location("pu", sys.argv[1]); pu = importlib.util.module_from_spec(spec); spec.loader.exec_module(pu)
for body in ({}, {"error": "temporarily unavailable"}, {"limits": []}):
    try:
        pu.shape(body)
    except ValueError:
        continue
    raise SystemExit(f"accepted {body}")
out = pu.shape({"five_hour": {"utilization": 42, "resets_at": "2026-99-99T99:99:99Z"}})
assert out["reset"] is None and out["limits"][0]["resets_at"] is None
assert pu.stamp("2026-10-20T08:30:00Z") and pu.stamp("2026-10-20T08:30:00.2+00:00") and pu.stamp("2026-10-20T08:30:00") is None
PYT

# 5. corrupt login file names the login, not the reply
printf 'not json' > "$T/corrupt.json"
HQ_CLAUDE_CREDS="$T/corrupt.json" HQ_USAGE_CACHE="$T/c3.json" python3 -I "$PY" 2>/dev/null
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["error"]=="no Claude login on this box",d' "$T/c3.json" && ok "corrupt login is reported as the login" || bad "corrupt login message"

# 5. alert grace: a short failure (token refresh gap) never fails the unit; one
#    that has lasted ALERT_AFTER_S fails it once, then at most once a day.
printf '{}' > "$T/nologin.json"
run(){ HQ_CLAUDE_CREDS="$T/nologin.json" HQ_USAGE_CACHE="$T/g.json" python3 -I "$PY" 2>/dev/null; echo $?; }
rm -f "$T/g.json"
[ "$(run)" = 0 ] && ok "first failure does not fail the unit" || bad "first failure failed the unit"
[ "$(run)" = 0 ] && ok "second failure inside the grace does not fail the unit" || bad "failure inside grace failed the unit"
python3 -c 'import json,sys,time;p=sys.argv[1];d=json.load(open(p));d["error_since"]=time.time()-1900;d["error_last"]=time.time()-120;json.dump(d,open(p,"w"))' "$T/g.json"
[ "$(run)" = 1 ] && ok "failure past the grace fails the unit" || bad "failure past grace did not fail the unit"
[ "$(run)" = 0 ] && ok "next run after the alert stays quiet" || bad "alert repeated on the next run"
python3 -c 'import json,sys,time;p=sys.argv[1];d=json.load(open(p));d["error_since"]=time.time()-90000;d["error_alerted"]=time.time()-87000;d["error_last"]=time.time()-120;json.dump(d,open(p,"w"))' "$T/g.json"
[ "$(run)" = 1 ] && ok "a day later it alerts again" || bad "no daily re-alert"
python3 -c 'import json,sys,time;p=sys.argv[1];d=json.load(open(p));d["error_since"]=time.time()+99999;d.pop("error_alerted",None);json.dump(d,open(p,"w"))' "$T/g.json"
[ "$(run)" = 0 ] && ok "a future error_since restarts the grace" || bad "future error_since paged"
python3 -c 'import json,sys;p=sys.argv[1];d=json.load(open(p));d["error_since"]="junk";json.dump(d,open(p,"w"))' "$T/g.json"
[ "$(run)" = 0 ] && ok "a junk error_since restarts the grace" || bad "junk error_since paged"
for v in true 0 1; do printf '{"error_since": %s, "error_last": %s}' "$v" "$v" > "$T/g.json"
  [ "$(run)" = 0 ] && ok "error_since=$v does not page the first failure" || bad "error_since=$v paged"; done
python3 -c 'import json,sys,time;json.dump({"error_since":time.time()-7200,"error_last":time.time()-3600},open(sys.argv[1],"w"))' "$T/g.json"
[ "$(run)" = 0 ] && ok "a failure after an hour-long gap restarts the streak" || bad "post-gap failure paged"
printf 'not json' > "$T/g.json"
[ "$(run)" = 0 ] && ok "a corrupt cache restarts the grace" || bad "corrupt cache paged"
mkdir -p "$T/gdir"; HQ_CLAUDE_CREDS="$T/nologin.json" HQ_USAGE_CACHE="$T/gdir" python3 -I "$PY" 2>/dev/null; rc=$?
[ "$rc" = 2 ] && ok "an unwritable cache still fails the unit at once" || bad "unwritable cache rc $rc"
exit $fail
