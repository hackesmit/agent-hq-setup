#!/usr/bin/env python3
"""Flow collector (bead hq-3y18, design 2026-08-24 section 4.3): the three
measurements the weekly retro currently answers by anecdote.

  lead time       created_at to closed_at for closed beads, per rig, as a
                  distribution (median, p90), never a mean
  time in status  how long beads sat blocked versus in_progress over their
                  life, reconstructed from the ledger's interaction log. If
                  blocked time dominates, the bottleneck is the owner's
                  attention, and the fix is queue policy, not more workers.
  rework rate     beads reopened (a closed -> open/in_progress transition):
                  the direct measure of whether adversarial review is
                  calibrated

Read-only over the existing ledgers: `bd list --status closed --json` per rig
plus `.beads/interactions.jsonl` read directly. No schema change, no writes to
any bead. Auto-filed audit rows (egress-ledger, session-eval: 82% of the hq
ledger per proposal 22) are excluded, or every number would measure the
paperwork instead of the work.

Windows (7/30/90 days) select beads by CLOSED time; reopens by REOPEN time.
Prints one JSON document on stdout. Seams for tests: --hq, --now (ISO),
--fixture DIR (rig subdirs each holding issues.json + interactions.jsonl; bd
is never run).
"""

import argparse
import calendar
import json
import os
import subprocess
import sys
import time

WINDOWS = (7, 30, 90)
DAY_S = 86400.0
# Auto-filed audit trail, not work. Counting these as flow would say the retro
# "closes" hundreds of beads a week that nobody worked.
AUDIT_LABELS = {"egress-ledger", "session-eval"}
STATUSES = ("open", "in_progress", "blocked")
WEEKS_TREND = 6


def parse_ts(s):
    """ISO-8601 Z (with or without fractional seconds) to epoch, or None."""
    if not s:
        return None
    s = str(s)
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return calendar.timegm(time.strptime(s[:19], fmt))
        except Exception:
            continue
    return None


def is_audit(issue):
    labels = issue.get("labels") or []
    return any(l in AUDIT_LABELS for l in labels)


def percentile(sorted_vals, p):
    """Nearest-rank percentile of a pre-sorted list, or None when empty."""
    if not sorted_vals:
        return None
    k = max(0, min(len(sorted_vals) - 1, int(round(p * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def status_segments(issue, transitions, now_s):
    """Seconds spent in each status over the bead's life.

    The interaction log records field_change rows for status. A row's
    old_value is the authority for the segment that just ENDED: the ledger
    does not log every entry into a status (a claim can go unrecorded), so
    "changed FROM in_progress at T" is the only reliable statement that the
    time before T was spent in_progress. A bead starts life open at
    created_at, the final segment runs to closed_at (or now for a bead still
    open) in the last row's new_value, and a malformed row is skipped rather
    than poisoning the total.
    """
    created = parse_ts(issue.get("created_at"))
    if created is None:
        return {}
    end = parse_ts(issue.get("closed_at")) or now_s
    events = []
    for t in transitions:
        at = parse_ts(t.get("created_at"))
        extra = t.get("extra") or {}
        new = (extra.get("new_value") or "").strip()
        if at is None or not new:
            continue
        events.append((at, (extra.get("old_value") or "").strip(), new))
    events.sort()
    out = {}
    cur, cur_at = "open", created
    for at, old, new in events:
        at = max(created, min(at, end))
        # the row's own old_value wins over what we tracked, when it has one
        spent_in = old or cur
        out[spent_in] = out.get(spent_in, 0.0) + max(0.0, at - cur_at)
        cur, cur_at = new, at
    out[cur] = out.get(cur, 0.0) + max(0.0, end - cur_at)
    return out


def reopen_times(transitions):
    """Epochs at which this bead went closed -> open/in_progress."""
    out = []
    for t in transitions:
        extra = t.get("extra") or {}
        if (extra.get("old_value") or "") == "closed" and (extra.get("new_value") or "") in ("open", "in_progress"):
            at = parse_ts(t.get("created_at"))
            if at is not None:
                out.append(at)
    return out


def week_start(epoch_s):
    """Monday 00:00 UTC of the week containing epoch_s."""
    st = time.gmtime(epoch_s)
    monday = epoch_s - ((st.tm_wday * DAY_S) + st.tm_hour * 3600 + st.tm_min * 60 + st.tm_sec)
    return int(monday)


def compute_rig(rig, issues, interactions, now_s):
    """One rig's flow report from its issues and interaction log."""
    by_issue = {}
    for row in interactions:
        if row.get("kind") != "field_change":
            continue
        if ((row.get("extra") or {}).get("field")) != "status":
            continue
        by_issue.setdefault(row.get("issue_id") or "", []).append(row)

    closed = []
    for it in issues:
        if is_audit(it):
            continue
        if (it.get("status") or "") != "closed":
            continue
        c, z = parse_ts(it.get("created_at")), parse_ts(it.get("closed_at"))
        if c is None or z is None or z < c:
            continue
        closed.append((it, c, z))

    # all reopens in the ledger, stamped by when they happened; audit beads
    # excluded the same way (a session-eval bead reopened by the retro is
    # paperwork, not rework)
    audit_ids = {it.get("id") for it in issues if is_audit(it)}
    reopens = []
    for iid, rows in by_issue.items():
        if iid in audit_ids:
            continue
        reopens.extend(reopen_times(rows))

    windows = {}
    for days in WINDOWS:
        cutoff = now_s - days * DAY_S
        in_win = [(it, c, z) for (it, c, z) in closed if z >= cutoff]
        leads = sorted(z - c for (_it, c, z) in in_win)
        blocked_s = in_progress_s = 0.0
        for it, _c, _z in in_win:
            segs = status_segments(it, by_issue.get(it.get("id") or "", []), now_s)
            blocked_s += segs.get("blocked", 0.0)
            in_progress_s += segs.get("in_progress", 0.0)
        active = blocked_s + in_progress_s
        n_reopened = sum(1 for at in reopens if at >= cutoff)
        windows[str(days)] = {
            "closed": len(in_win),
            "medianLeadS": percentile(leads, 0.5),
            "p90LeadS": percentile(leads, 0.9),
            "blockedShare": (blocked_s / active) if active > 0 else None,
            "reopened": n_reopened,
            "reworkShare": (n_reopened / len(in_win)) if in_win else None,
        }

    # weekly median lead over the last WEEKS_TREND weeks, oldest first, so a
    # sparkline reads left to right
    this_week = week_start(now_s)
    weekly = []
    for i in range(WEEKS_TREND - 1, -1, -1):
        ws = this_week - int(i * 7 * DAY_S)
        wk = sorted(z - c for (_it, c, z) in closed if ws <= z < ws + 7 * DAY_S)
        weekly.append({
            "weekStart": time.strftime("%Y-%m-%d", time.gmtime(ws)),
            "medianLeadS": percentile(wk, 0.5),
            "closed": len(wk),
        })

    return {"rig": rig, "windows": windows, "weekly": weekly}


# ---------------------------------------------------------------------------
# Gathering: live (bd + .beads) or fixture (plain files)
# ---------------------------------------------------------------------------

def read_interactions(beads_dir):
    rows = []
    path = os.path.join(beads_dir, "interactions.jsonl")
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue  # a torn line is skipped, never fatal
    except OSError:
        pass
    return rows


def bd_issues(rig_dir):
    """Closed issues via bd, run in the rig. Any failure is an empty list plus
    a note, because one rig without a ledger must not take the report down."""
    try:
        r = subprocess.run(
            ["bd", "list", "--status", "closed", "--json", "-n", "0"],
            cwd=rig_dir, capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return [], "bd exit %d" % r.returncode
        out = json.loads(r.stdout or "[]")
        return (out if isinstance(out, list) else []), None
    except Exception as e:  # noqa: BLE001 - collector must not crash on one rig
        return [], str(e)[:160]


def live_rigs(hq):
    """(name, dir) for every ledger: hq itself plus each rig with a .beads."""
    out = []
    if os.path.isdir(os.path.join(hq, ".beads")):
        out.append(("hq", hq))
    rigs = os.path.join(hq, "rigs")
    try:
        names = sorted(os.listdir(rigs))
    except OSError:
        names = []
    for name in names:
        d = os.path.join(rigs, name)
        if os.path.isdir(os.path.join(d, ".beads")):
            out.append((name, d))
    return out


def fixture_rigs(fixture):
    out = []
    for name in sorted(os.listdir(fixture)):
        d = os.path.join(fixture, name)
        if os.path.isdir(d):
            out.append((name, d))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hq", default=os.environ.get("HQ_ROOT", os.getcwd()))
    ap.add_argument("--now", help="ISO Z timestamp for tests")
    ap.add_argument("--fixture", help="rig subdirs with issues.json + interactions.jsonl; bd never runs")
    args = ap.parse_args(argv)

    now_s = parse_ts(args.now) if args.now else None
    if now_s is None:
        now_s = time.time()

    rigs, errors = [], []
    if args.fixture:
        for name, d in fixture_rigs(args.fixture):
            try:
                with open(os.path.join(d, "issues.json")) as fh:
                    issues = json.load(fh)
            except Exception:
                issues = []
            rigs.append(compute_rig(name, issues, read_interactions(d), now_s))
    else:
        for name, d in live_rigs(args.hq):
            issues, err = bd_issues(d)
            if err:
                errors.append({"rig": name, "error": err})
            beads = os.path.join(d, ".beads")
            rigs.append(compute_rig(name, issues, read_interactions(beads), now_s))

    json.dump({
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_s)),
        "rigs": rigs,
        "errors": errors,
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
