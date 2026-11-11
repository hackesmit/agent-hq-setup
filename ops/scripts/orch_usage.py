#!/usr/bin/env python3
"""Orchestrator usage tracking (hq-4npjr.7).

the owner 2026-11-04: Fable is the orchestrator, on the Max plan; the limit is plan
usage, not dollars, so we watch the share of HQ usage and adjust if excessive.

Sources, all read not recalled:
  state/orchestrator/spend.jsonl   the call log the runner appends: ts, id, model,
                                   role (decide|triage), kind (event type),
                                   input_tokens, output_tokens, cost_usd
  state/usage/claude-api.sqlite    every HQ request (tokens, cost, model, hq_session);
                                   orchestrator calls carry hq_session=orchestrator-run
  state/console/usage-cache.json   the plan's own windows (weekly percent), if known

  orch_usage.py summary    print the JSON the console shows (also written to usage.json)
  orch_usage.py check      summary, then notify.sh default once per ISO week when the
                           orchestrator's share of HQ's weekly usage passes the threshold
  orch_usage.py retro      one line for the weekly retro

Share is the cost-equivalent (list price, from the usage table) of orchestrator
requests over all requests in the rolling 7 days, since tokens of different models
are not one unit. The threshold is ops/config/orchestrator.json "alert_share"
(default 0.25), HQ_ORCH_ALERT_SHARE overrides. Below MIN_WEEK_USD of HQ weekly
usage there is nothing to be a share of, so no alert.
"""
import datetime
import json
import math
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("HQ_ROOT") or os.path.dirname(os.path.dirname(HERE))
D = os.environ.get("HQ_ORCH_DIR") or os.path.join(ROOT, "state", "orchestrator")
SPEND = os.path.join(D, "spend.jsonl")
OUT = os.path.join(D, "usage.json")
DB = os.environ.get("HQ_USAGE_DB") or os.path.join(ROOT, "state", "usage", "claude-api.sqlite")
PLAN = os.environ.get("HQ_USAGE_CACHE") or os.path.join(ROOT, "state", "console", "usage-cache.json")
CONFIG = os.environ.get("HQ_ORCH_CONFIG") or os.path.join(ROOT, "ops", "config", "orchestrator.json")
NOTIFY = os.environ.get("HQ_NOTIFY") or os.path.join(ROOT, "ops", "scripts", "notify.sh")
RUN_TAG = "orchestrator-run"
MIN_WEEK_USD = 5.0


def _utc():
    return datetime.datetime.now(datetime.timezone.utc)


def threshold():
    v = os.environ.get("HQ_ORCH_ALERT_SHARE")
    if v is None:
        try:
            with open(CONFIG, encoding="utf-8") as f:
                v = json.load(f).get("alert_share")
        except (OSError, ValueError, AttributeError):
            v = None
    try:
        v = float(v)
        if math.isfinite(v) and 0 < v <= 1:
            return v
    except (TypeError, ValueError):
        pass
    return 0.25


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0.0


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def read_log(since_iso):
    """Spend rows at or after since_iso. A missing log is empty; junk lines are skipped."""
    rows = []
    try:
        with open(SPEND, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if isinstance(o, dict) and str(o.get("ts", "")) >= since_iso:
                    rows.append(o)
    except OSError:
        pass
    return rows


def window(rows):
    by = {}
    for o in rows:
        m = str(o.get("model") or "unknown")
        b = by.setdefault(m, {"model": m, "calls": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0})
        b["calls"] += 1
        b["inputTokens"] += int(_num(o.get("input_tokens")))
        b["outputTokens"] += int(_num(o.get("output_tokens")))
        b["costUsd"] += _num(o.get("cost_usd"))
    models = sorted(by.values(), key=lambda b: -b["costUsd"])
    for b in models:
        b["costUsd"] = round(b["costUsd"], 4)
    return {"calls": sum(b["calls"] for b in models),
            "inputTokens": sum(b["inputTokens"] for b in models),
            "outputTokens": sum(b["outputTokens"] for b in models),
            "costUsd": round(sum(b["costUsd"] for b in models), 4), "models": models}


def table_week(since_iso):
    """(orchestrator USD, all HQ USD) since since_iso from the usage table, or None."""
    try:
        c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=5)
    except sqlite3.Error:
        return None
    try:
        orch, total = c.execute(
            "SELECT COALESCE(SUM(CASE WHEN hq_session LIKE 'orchestrator%' THEN cost_usd END), 0), "
            "COALESCE(SUM(cost_usd), 0) FROM api_request WHERE ts >= ?", (since_iso,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        c.close()
    return _num(orch), _num(total)


def plan_weekly_pct():
    try:
        with open(PLAN, encoding="utf-8") as f:
            v = json.load(f).get("weekly_pct")
        return float(v) if _num(v) == v and v is not None else None
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def summary(now=None):
    now = now or _utc()
    day0 = now.strftime("%Y-%m-%dT00:00:00")
    wk0 = _iso(now - datetime.timedelta(days=7))
    t = table_week(wk0)
    share = None
    if t is not None and t[1] > 0:
        share = round(t[0] / t[1], 4)
    return {"at": _iso(now), "today": window(read_log(day0)), "week": window(read_log(wk0)),
            "weekHqUsd": None if t is None else round(t[1], 2),
            "weekOrchUsd": None if t is None else round(t[0], 2),
            "shareOfHq": share, "threshold": threshold(), "planWeeklyPct": plan_weekly_pct()}


def write_out(s):
    os.makedirs(D, exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f)
    os.replace(tmp, OUT)


def over(s):
    return s["shareOfHq"] is not None and s["shareOfHq"] >= s["threshold"] and (s["weekHqUsd"] or 0) >= MIN_WEEK_USD


def check(now=None):
    s = summary(now)
    try:
        write_out(s)
    except OSError:
        pass
    if over(s):
        y, w, _ = (now or _utc()).isocalendar()
        mark = os.path.join(D, "paged-usage-%d-W%02d" % (y, w))
        if not os.path.exists(mark):
            msg = ("Orchestrator is %.0f%% of HQ usage this week (threshold %.0f%%, %s USD of %s USD list-price equivalent). "
                   "Models: %s. Change ops/config/orchestrator.json to adjust."
                   % (s["shareOfHq"] * 100, s["threshold"] * 100, s["weekOrchUsd"], s["weekHqUsd"],
                      ", ".join(m["model"] for m in s["week"]["models"]) or "none logged"))
            try:
                p = subprocess.run([NOTIFY, "default", "Orchestrator usage high", msg], capture_output=True, timeout=60)
                if p.returncode == 0:
                    open(mark, "w").close()
            except (OSError, subprocess.TimeoutExpired):
                pass
    return s


def retro_line(s):
    w = s["week"]
    models = ", ".join("%s %d calls %d out tokens" % (m["model"], m["calls"], m["outputTokens"]) for m in w["models"]) or "no calls"
    share = "n/a" if s["shareOfHq"] is None else "%.1f%%" % (s["shareOfHq"] * 100)
    plan = "" if s["planWeeklyPct"] is None else "; plan weekly limit %.0f%% used" % s["planWeeklyPct"]
    return "Orchestrator, last 7 days: %s; share of HQ usage %s (alert at %.0f%%)%s." % (models, share, s["threshold"] * 100, plan)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "summary"
    if cmd == "check":
        print(json.dumps(check()))
    elif cmd == "summary":
        print(json.dumps(summary()))
    elif cmd == "retro":
        print(retro_line(summary()))
    else:
        print("usage: orch_usage.py summary|check|retro", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
