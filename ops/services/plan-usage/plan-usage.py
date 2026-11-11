#!/usr/bin/env python3
"""Plan usage for the console: the same windows Claude Code's /usage shows.

the owner, 2026-10-20: "see my usage in all the windows, 5h, week, etc." on the
Terminals page. The old source (ccusage blocks, scaled to the heaviest block)
was an estimate, and ccusage is not installed, so it had been frozen since
2026-10-09.

Runs as owner because the console user must not read his Claude login. Reads
the OAuth token from ~/.claude/.credentials.json (Claude Code keeps it fresh),
asks the plan usage endpoint, and writes only the numbers to
state/console/usage-cache.json. The token never leaves this process. On any
failure the last good numbers stay and "error" says why, so the page can show
them as stale instead of blank.
"""
import datetime
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

HQ = os.environ.get("HQ_ROOT", os.path.expanduser("~/hq"))
OUT = os.environ.get("HQ_USAGE_CACHE", os.path.join(HQ, "state/console/usage-cache.json"))
CREDS = os.path.expanduser(os.environ.get("HQ_CLAUDE_CREDS", "~/.claude/.credentials.json"))
URL = "https://api.anthropic.com/api/oauth/usage"
# The access token expires every few hours and Claude Code refreshes it on its
# next call, so a 401 for a few minutes is normal. The unit used to fail (and
# page the owner through OnFailure) on every two-minute run of that gap, three
# pages an evening (2026-11-03). Now a failure only fails the unit once it has
# lasted ALERT_AFTER_S, and then at most once per REALERT_S; the cache still
# carries "error" from the first failed run so the page shows the numbers stale.
ALERT_AFTER_S = int(os.environ.get("HQ_USAGE_ALERT_AFTER_S", "1800"))
REALERT_S = 24 * 3600
# Failures further apart than this (five two-minute runs) are not one streak:
# a box that was off for an hour must not page on its first post-boot 401.
STREAK_GAP_S = 600


def _stamp(value, now):
    """A usable epoch seconds value from the cache, or None (bool, junk, future)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value > now:
        return None
    return float(value)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


MAX_LIMITS = 12
# The named windows the endpoint also returns, for a reply that has no "limits" list.
NAMED = [("five_hour", "session", "5 h"), ("seven_day", "weekly_all", "Week"),
         ("seven_day_opus", "weekly_scoped", "Week, Opus"), ("seven_day_sonnet", "weekly_scoped", "Week, Sonnet")]


def pct(value):
    """A finite percentage in 0..1000, or None. Rejects 1e309 (inf), NaN and junk."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if not math.isfinite(value) or value < 0 or value > 1000:
        return None
    return round(value, 2)


def text(value, n):
    return value[:n] if isinstance(value, str) else ""


def stamp(value):
    """A real ISO timestamp with a timezone, or None. Impossible dates are rejected."""
    value = text(value, 40)
    if not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if parsed.tzinfo is not None else None


def label(limit):
    kind = text(limit.get("kind"), 40)
    scope = limit.get("scope")
    model = scope.get("model") if isinstance(scope, dict) else None
    name = text(model.get("display_name"), 24) if isinstance(model, dict) else ""
    base = {"session": "5 h", "weekly_all": "Week", "weekly_scoped": "Week"}.get(kind, kind.replace("_", " ") or "limit")
    return (f"{base}, {name}" if name else base)[:40]


def shape(raw):
    if not isinstance(raw, dict):
        raise ValueError("reply is not an object")
    limits = []
    items = raw.get("limits")
    if isinstance(items, list) and items:
        for item in items[:MAX_LIMITS]:
            if not isinstance(item, dict):
                continue
            limits.append({
                "kind": text(item.get("kind"), 40),
                "label": label(item),
                "percent": pct(item.get("percent")),
                "severity": text(item.get("severity"), 20),
                "resets_at": stamp(item.get("resets_at")),
                "active": item.get("is_active") is True,
            })
    else:
        for key, kind, name in NAMED:
            window = raw.get(key)
            if isinstance(window, dict) and pct(window.get("utilization")) is not None:
                limits.append({"kind": kind, "label": name, "percent": pct(window.get("utilization")),
                               "severity": "", "resets_at": stamp(window.get("resets_at")), "active": False})
    if not limits:
        # A 200 with no usable window ({} or an error body) is a failed read: keep the
        # last good numbers rather than stamping an empty reading as fresh.
        raise ValueError("reply has no usage windows")
    five = raw.get("five_hour") if isinstance(raw.get("five_hour"), dict) else {}
    week = raw.get("seven_day") if isinstance(raw.get("seven_day"), dict) else {}
    extra = raw.get("extra_usage") if isinstance(raw.get("extra_usage"), dict) else {}
    return {
        "updated": now_iso(),
        "source": "oauth-usage",
        # The two keys the console already reads, kept so nothing else changes.
        "pct": pct(five.get("utilization")),
        "reset": stamp(five.get("resets_at")),
        "weekly_pct": pct(week.get("utilization")),
        "weekly_reset": stamp(week.get("resets_at")),
        "limits": limits,
        "extra": {
            "enabled": extra.get("is_enabled") is True,
            "currency": text(extra.get("currency"), 8),
        },
    }


def reason(exc):
    """A fixed message for a failure. Never the exception text: a header error quotes
    the header value, which is the token (lucy, 2026-10-20)."""
    if isinstance(exc, urllib.error.HTTPError):
        return f"http {int(exc.code)}"
    if isinstance(exc, urllib.error.URLError):
        return "network error"
    if isinstance(exc, LookupError):
        return "no Claude login on this box"
    if isinstance(exc, json.JSONDecodeError):
        return "reply is not JSON"
    return f"failed ({type(exc).__name__})"


def write(data):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, allow_nan=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, OUT)


def main():
    failure = None
    try:
        try:
            token = json.load(open(CREDS))["claudeAiOauth"]["accessToken"]
        except Exception:  # noqa: BLE001
            raise LookupError("login") from None
        req = urllib.request.Request(URL, headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "hq-plan-usage",
        })
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = json.load(resp)
        data = shape(raw)
    except Exception as exc:  # noqa: BLE001
        failure = reason(exc)
    # Outside the except block on purpose: anything raised from here on has no
    # chained context, so no traceback can carry the token-bearing first error.
    try:
        if failure is None:
            write(data)
            return 0
        try:
            old = json.load(open(OUT))
        except Exception:  # noqa: BLE001
            old = {}
        if not isinstance(old, dict):
            old = {}
        now = time.time()
        since = _stamp(old.get("error_since"), now)
        last = _stamp(old.get("error_last"), now)
        alerted = _stamp(old.get("error_alerted"), now)
        if since is None or last is None or now - last > STREAK_GAP_S or last < since:
            since, alerted = now, None
        page = now - since >= ALERT_AFTER_S and (alerted is None or now - alerted >= REALERT_S)
        old["error"] = failure
        old["error_at"] = now_iso()
        old["error_since"] = since
        old["error_last"] = now
        if page:
            old["error_alerted"] = now
        elif alerted is None:
            old.pop("error_alerted", None)
        write(old)
    except Exception as exc:  # noqa: BLE001
        print(f"plan-usage: could not write the cache ({type(exc).__name__})", file=sys.stderr)
        return 2
    print(f"plan-usage: {failure}", file=sys.stderr)
    return 1 if page else 0


if __name__ == "__main__":
    sys.exit(main())
