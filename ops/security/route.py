#!/usr/bin/env python3
"""route: plan the autonomy tier of every security finding (hq-8cry.5).

route.sh owns the side effects (bd, notify.sh, spawn.sh); this script is the
pure plan. It reads a findings file from match.sh, the tier policy
(ops/config/security-tiers.json) and the routing state of earlier runs, and
prints one JSON plan: which beads to file, which to comment on or escalate,
which tier A beads to dispatch and which to hold for the release cooldown.

The unit routed is one vulnerable package version in one rig (rig, ecosystem,
package, installed): every advisory on it is fixed by the same bump, so it is
one bead, not one bead per advisory. The bump target is the highest fixed
version across those advisories.

Tiers (the policy text lives in .claude/rules/security-watch.md):
  C  KEV or malicious on a live rig, or an own-code finding (own_code: true):
     notify.sh urgent and a P0 bead. KEV fixes may bypass the cooldown.
  A  patch bump, KEV known false, not malicious, rig in no sensitive class,
     fixed version published at least cooldown_days ago and the date known:
     dispatched to a worker that bumps, tests, gets an Opus review, finishes.
  B  everything else: the normal redteam flow plus lucy.
kev null means the catalog was unavailable: unknown, never "not exploited",
so it can never be tier A.

Inputs: --findings, --config, --state (missing = first run), --date,
--known (JSON {"secwatch:<key>": {id, status, labels, priority, title,
description}} of beads already in a ledger, open or closed, so a lost state
file never files a duplicate; a bare "<bead id>" string is also accepted),
--published (JSON {"<ecosystem>/<package>@<version>": "YYYY-MM-DD"}, read
first and written back with any new lookups; lookups use the npm and PyPI
registries unless --offline). Output: the plan on stdout.

A bead found in a ledger but not in the state (state lost, or a filing whose
id was never saved) is adopted: its tier, advisories, target and dispatch
state are read back from the bead itself (tier-x label, the Advisories line,
the title, status and the dispatched label), never assumed, and any gap
between that and today's plan is planned as an update like any other. A state
entry whose filing never confirmed takes the same read-back as floors: the ledger
tier, severity, target, evidence and advisories (hq-8cry.17).
"""
import argparse
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import date, timedelta

SEV_RANK = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1, "UNKNOWN": 0}
TIER_RANK = {"A": 1, "B": 2, "C": 3}
TIER_LABELS = {"tier-a", "tier-b", "tier-c"}
# Statuses nobody works from (bd's done and frozen categories): KEV or malicious
# news on such a bead reopens it, since a comment there is read by nobody.
INACTIVE = {"closed", "deferred", "pinned"}
FLAG_WORD = {True: "yes", None: "unknown", False: "no"}
NUMERIC = re.compile(r"^v?\d+(?:\.\d+)*$")


def vkey(v):
    """Sort key for a version: numeric parts first, a prerelease below its release."""
    m = re.match(r"^v?(\d+(?:\.\d+)*)(.*)$", v or "")
    if not m:
        return ((), 1, v or "")
    nums = tuple(int(x) for x in m.group(1).split("."))
    nums = nums + (0,) * (4 - len(nums))
    rest = m.group(2)
    return (nums, 0 if rest.startswith(("-", "a", "b", "rc", ".dev", "dev")) else 1, rest)


def bump_kind(installed, fixed):
    """patch, minor, major, or unknown (no fix, a prerelease, or unparsable)."""
    if not fixed:
        return "none"
    a = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", installed or "")
    b = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", fixed)
    if not a or not b:
        return "unknown"
    if a.group(1) != b.group(1):
        return "major"
    if a.group(2) != b.group(2):
        return "minor"
    return "patch" if int(b.group(3)) > int(a.group(3)) else "unknown"


def lookup_published(eco, pkg, ver):
    """Publish date of one version from the npm or PyPI registry, else None."""
    try:
        if eco == "npm":
            url = "https://registry.npmjs.org/" + urllib.parse.quote(pkg, safe="@")
            with urllib.request.urlopen(url, timeout=30) as r:
                t = json.load(r).get("time", {}).get(ver)
        elif eco == "PyPI":
            url = "https://pypi.org/pypi/%s/%s/json" % (urllib.parse.quote(pkg), urllib.parse.quote(ver))
            with urllib.request.urlopen(url, timeout=30) as r:
                t = pypi_published(json.load(r).get("urls"))
        else:
            return None
    except Exception:
        return None
    return t[:10] if isinstance(t, str) and re.match(r"^\d{4}-\d{2}-\d{2}", t) else None


def pypi_published(files):
    """A PyPI release's publish date is its LATEST file upload: a wheel added
    later to an old release must not make the release look old (fail closed)."""
    return max((f.get("upload_time_iso_8601") or "" for f in files or [] if isinstance(f, dict)), default="") or None


def group(findings, kev_known=True):
    groups = {}
    for f in findings:
        if not f.get("rig") or not f.get("package"):
            continue
        key = "%s/%s/%s@%s" % (f["rig"], f.get("ecosystem") or "?", f["package"], f.get("installed") or "?")
        g = groups.setdefault(key, {
            "key": key, "rig": f["rig"], "ecosystem": f.get("ecosystem") or "?",
            "package": f["package"], "installed": f.get("installed") or "?",
            "ids": set(), "fixes": [], "unfixed": False, "bad_fix": False, "severity": "UNKNOWN",
            "kev": False, "malicious": False, "own_code": False, "sources": set(),
        })
        g["ids"].add(f["id"])
        if f.get("fixed"):
            g["fixes"].append(f["fixed"])
            # One unparsable fix makes the whole bump unknown: max() would
            # otherwise sort it below the others and pick their patch.
            if not isinstance(f["fixed"], str) or not NUMERIC.match(f["fixed"]):
                g["bad_fix"] = True
        else:
            g["unfixed"] = True
        sev = (f.get("severity") or "UNKNOWN").upper()
        if SEV_RANK.get(sev, 0) > SEV_RANK[g["severity"]]:
            g["severity"] = sev
        # true beats null beats false: one exploited advisory makes the group exploited,
        # and an unknown one keeps it out of tier A.
        # Only a real boolean False counts as "not exploited"; any other value, or a
        # file whose KEV catalog was unavailable, is unknown and keeps the group out of A.
        kev = f.get("kev")
        if kev is True:
            g["kev"] = True
        elif (kev is not False or not kev_known) and g["kev"] is False:
            g["kev"] = None
        # Same rule for malicious: missing or non-boolean is unknown (None), never "clean".
        mal = f.get("malicious")
        # An OpenSSF MAL- id or alias is malicious whatever the flag says.
        names = [f.get("id")] + (f.get("aliases") if isinstance(f.get("aliases"), list) else [])
        if any(isinstance(n, str) and n.upper().startswith("MAL-") for n in names):
            mal = True
        if mal is True:
            g["malicious"] = True
        elif mal is not False and g["malicious"] is False:
            g["malicious"] = None
        g["own_code"] = g["own_code"] or bool(f.get("own_code"))
        g["sources"].update(f.get("sources") or [])
    for g in groups.values():
        g["fixed"] = None if g["unfixed"] or not g["fixes"] else max((str(x) for x in g["fixes"]), key=vkey)
        g["ids"] = sorted(g["ids"])
        g["sources"] = sorted(g["sources"])
        del g["fixes"], g["unfixed"]
    return groups


def rig_policy(cfg, rig):
    p = dict(cfg.get("unknown_rig") or {"ledger": "hq", "classes": ["unknown"], "live": True})
    p.update((cfg.get("rigs") or {}).get(rig) or {})
    p.setdefault("label", rig)
    p.setdefault("live", True)
    p.setdefault("ledger", "hq")
    # A classes value that is not a list (a typo like "money", or null) is
    # unknown, so sensitive: it must never open tier A.
    if not isinstance(p.get("classes"), list):
        p["classes"] = ["unknown"]
    p["sensitive"] = bool(set(p["classes"]) & set(cfg.get("sensitive_classes") or []))
    return p


def decide(g, pol, published, today, cooldown):
    """(tier, reason, hold_until or None)."""
    if g["own_code"]:
        return "C", "own-code finding", None
    if (g["kev"] is True or g["malicious"] is True) and pol["live"]:
        return "C", ("known exploited (KEV)" if g["kev"] is True else "malicious package") + " on a live rig", None
    why = []
    if g["kev"] is True or g["malicious"] is True:
        why.append(("KEV" if g["kev"] is True else "malicious") + " on a rig that is not live")
    if g["kev"] is None:
        why.append("KEV status unknown (catalog unavailable)")
    if g["malicious"] is None:
        why.append("malicious status unknown")
    if g["bad_fix"]:
        why.append("unparsable fixed version")
    elif g["bump"] != "patch":
        why.append("%s bump" % g["bump"])
    if pol["sensitive"]:
        why.append("rig is %s" % "/".join(c for c in pol.get("classes") or [] if c))
    if why:
        return "B", "; ".join(why), None
    pub = published.get(g["pubkey"])
    if not pub:
        return "B", "fix publish date unknown, cooldown cannot be checked", None
    hold = (date.fromisoformat(pub) + timedelta(days=cooldown)).isoformat()
    return "A", "patch bump on a rig with no money, auth, data or public surface", (hold if hold > today else None)


def priority(tier, sev):
    if tier == "C":
        return 0
    return 1 if SEV_RANK.get(sev, 0) >= SEV_RANK["HIGH"] else 2


def title_labels(item):
    """The bead title and labels for one planned item (route.sh writes both)."""
    t = item["tier"]
    item["title"] = "Security: %s %s %s to %s (%s, tier %s)" % (
        item["rig"], item["package"], item["installed"], item["fixed"] or "no fix", item["severity"], t)
    labels = ["security", "secwatch", "tier-" + t.lower(), "P%d" % item["priority"]]
    if t != "A":
        labels.append("redteam")
    if item["ledger"] == "hq":
        labels.append(item["label"])
    item["labels"] = labels


def worse(a, b):
    """Merge two KEV or malicious flags: true beats null (unknown) beats false."""
    if a is True or b is True:
        return True
    if a is None or b is None:
        return None
    return False


def prior_evidence(prev):
    """The KEV and malicious flags and the severity earlier runs established for
    one entry: its stored plan, the bead read back (adopted), and the ledger's
    own description. Flags merge true over null over false; severity takes the max."""
    flags, sev = {}, None
    for src in ((prev.get("item") or {}), (prev if prev.get("adopted") else {}), (prev.get("ledger_flags") or {})):
        for k in ("kev", "malicious"):
            if k in src:
                flags[k] = worse(flags[k], src[k]) if k in flags else src[k]
        s = src.get("severity")
        if s in SEV_RANK and (sev is None or SEV_RANK[s] > SEV_RANK[sev]):
            sev = s
    return flags, sev


def from_ledger(rec):
    """Routing state read back from a bead already in a ledger (state lost, or a
    filing whose id never reached the state). Nothing is assumed: an unread
    tier is A (so a planned B or C still rewrites and pages), unread advisories
    are none (so each is reported), dispatch is read from the bead status, and
    a tier C bead without the paged label still owes its urgent page."""
    if not isinstance(rec, dict):
        rec = {"id": rec}
    labels = [l for l in rec.get("labels") or [] if isinstance(l, str)]
    tiers = [l[5:].upper() for l in labels if l in TIER_LABELS]
    m = re.search(r"Advisories: ([^\n]*?)\. Tier [ABC]:", rec.get("description") or "")
    t = re.search(r" to (.+) \(([A-Z]+), tier [ABC]\)$", rec.get("title") or "")
    status = rec.get("status")
    desc = rec.get("description") or ""
    kv = re.search(r"; KEV (yes|unknown|no)", desc)
    mv = re.search(r"; malicious (yes|unknown|no)", desc)
    flag = {"yes": True, "unknown": None, "no": False}
    out_flags = {}
    if kv:
        out_flags["kev"] = flag[kv.group(1)]
    if mv:
        out_flags["malicious"] = flag[mv.group(1)]
    if t and t.group(2) in SEV_RANK:
        out_flags["severity"] = t.group(2)
    return dict(out_flags, **{"bead": rec.get("id"), "tier": max(tiers, key=TIER_RANK.get) if tiers else "A",
            "ids": m.group(1).split(", ") if m else [],
            "fixed": (None if t.group(1) == "no fix" else t.group(1)) if t else None,
            # A worker claims its bead (in_progress) and finish closes it; a blocked or
            # deferred bead, or a dispatched label with no claim (a crash before the
            # spawn), is not proof of a worker. route.sh checks the session registry
            # before every spawn, so a live worker is never doubled.
            "dispatched": status in ("in_progress", "closed"),
            "paged": "paged" in labels,
            "priority": rec.get("priority"), "labels": labels, "adopted": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--findings", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--published", required=True)
    ap.add_argument("--known")
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()

    with open(a.findings) as fh:
        doc = json.load(fh)
    with open(a.config) as fh:
        cfg = json.load(fh)
    state = {}
    if os.path.exists(a.state):
        with open(a.state) as fh:
            state = json.load(fh).get("routed", {})
    published = {}
    if os.path.exists(a.published):
        with open(a.published) as fh:
            published = json.load(fh)
    known = {}
    if a.known and os.path.exists(a.known):
        with open(a.known) as fh:
            known = json.load(fh)
    cooldown = int(cfg.get("cooldown_days", 7))
    today = a.date

    plan = {"date": today, "findings_file": os.path.basename(a.findings),
            "incomplete": bool((doc.get("summary") or {}).get("scan_errors")) or
                          (doc.get("summary") or {}).get("kev_available") is False,
            "file": [], "update": [], "dispatch": [], "held": [], "duplicates": 0}
    looked_up = False
    kev_known = (doc.get("summary") or {}).get("kev_available") is True
    for key, g in sorted(group(doc.get("findings") or [], kev_known).items()):
        pol = rig_policy(cfg, g["rig"])
        # History first: the state entry, else the bead read back from its ledger.
        # Everything below (target, evidence, severity, tier) floors on it.
        prev = state.get(key)
        rec = known.get("secwatch:" + key)
        ledger_floor = None
        reconciled = False
        # An entry whose bd create failed has history but no bead: it is filed
        # again, and its tier, ids and evidence stay the floor (needs filing is
        # not the same as no history).
        refile = False
        if prev is not None and not prev.get("bead"):
            # Intent recorded but the filing never confirmed: adopt the bead if it
            # reached the ledger (and merge the ledger below like any state entry),
            # else file it again (its pending ops wait for it).
            if rec:
                prev = dict(prev, bead=from_ledger(rec)["bead"])
            else:
                refile = True
        elif prev is None and rec:
            prev = from_ledger(rec)
        if rec and prev is not None and not prev.get("adopted"):
            # A higher tier label on the bead (a tier A worker that stopped and
            # relabelled tier-b, or a hand escalation) wins over the state.
            led = from_ledger(rec)
            lt = led["tier"]
            # It is an escalation against the state's tier, so it rewrites and, for C, pages.
            if TIER_RANK[lt] > TIER_RANK.get(prev.get("tier"), 0) and set(led["labels"]) & TIER_LABELS:
                ledger_floor = lt
            # A claimed or closed bead has (or had) a worker even when the state says
            # it was never dispatched: never spawn a second one.
            if led["dispatched"] and not prev.get("dispatched"):
                prev, reconciled = dict(prev, dispatched=True), True
            # Evidence the ledger holds survives a state entry that lacks it.
            prev = dict(prev, ledger_flags={k: led[k] for k in ("kev", "malicious", "severity") if k in led},
                        ids=sorted(set(prev.get("ids") or []) | set(led["ids"])))
            # So do the advisories and the target it names (a hand edit, or a
            # filing whose id never reached the state).
            if led["fixed"] and (not prev.get("fixed") or vkey(led["fixed"]) > vkey(prev["fixed"])):
                prev["fixed"] = led["fixed"]
        # A later partial findings file never lowers an established target: keep the
        # highest fix any earlier run required for this package version.
        # A known target also survives a file that reports no fix, but a target
        # no current finding vouches for is never tier A (bump unknown, tier B).
        _pf = (prev or {}).get("fixed")
        held = False
        if _pf and not g["bad_fix"] and (g["fixed"] is None or vkey(_pf) > vkey(g["fixed"])):
            held = g["fixed"] is None
            g["fixed"] = _pf
        # A later partial findings file never clears earlier KEV or malicious
        # evidence nor lowers the severity, and the merge happens before the tier,
        # priority and remediation are computed, so they all see it.
        before, prev_sev = prior_evidence(prev) if prev is not None else ({}, None)
        for k, v in before.items():
            g[k] = worse(g[k], v)
        if prev_sev and SEV_RANK[prev_sev] > SEV_RANK.get(g["severity"], 0):
            g["severity"] = prev_sev
        g["bump"] = "unknown" if g["bad_fix"] or held else bump_kind(g["installed"], g["fixed"])
        g["pubkey"] = "%s/%s@%s" % (g["ecosystem"], g["package"], g["fixed"])
        # Only a would-be tier A needs the publish date, so only it costs a lookup.
        if (g["fixed"] and g["bump"] == "patch" and not pol["sensitive"] and g["kev"] is False
                and g["malicious"] is False and g["pubkey"] not in published and not a.offline):
            pub = lookup_published(g["ecosystem"], g["package"], g["fixed"])
            if pub:
                published[g["pubkey"]] = pub
                looked_up = True
        tier, reason, hold = decide(g, pol, published, today, cooldown)
        item = {k: g[k] for k in ("key", "rig", "ecosystem", "package", "installed", "fixed", "bump",
                                  "severity", "kev", "malicious", "own_code", "ids", "sources")}
        item.update({"ledger": pol["ledger"], "label": pol["label"], "classes": pol["classes"],
                     "published": published.get(g["pubkey"])})

        if prev is not None:
            # A tier never drops: a bead escalated earlier keeps its tier and reason.
            if TIER_RANK.get(prev.get("tier"), 0) > TIER_RANK[tier]:
                tier = prev["tier"]
                reason = (prev.get("item") or {}).get("reason") or "tier %s kept from an earlier run" % tier
                hold = None
            if ledger_floor and TIER_RANK[ledger_floor] > TIER_RANK[tier]:
                tier, reason, hold = ledger_floor, "relabelled tier %s on the bead" % ledger_floor, None
            item["ids"] = sorted(set(g["ids"]) | set(prev.get("ids") or []))
        item.update({"tier": tier, "reason": reason, "priority": priority(tier, item["severity"]),
                     "hold_until": hold, "kev_bypass": tier == "C" and item["kev"] is True and item["malicious"] is False})
        title_labels(item)

        if prev is None or refile:
            plan["file"].append(item)
            if tier == "A":
                (plan["held"] if hold else plan["dispatch"]).append(item)
            continue

        item["bead"] = prev["bead"]
        item["dispatched"] = bool(prev.get("dispatched"))
        # The ledger's dispatched label: route.sh refuses to spawn such a bead when the
        # session registry cannot prove there is no worker (missing or unreadable).
        item["dispatch_label"] = bool(rec) and isinstance(rec, dict) and "dispatched" in (rec.get("labels") or [])
        item["adopted"] = bool(prev.get("adopted")) or not (state.get(key) or {}).get("bead")
        new_ids = [i for i in g["ids"] if i not in (prev.get("ids") or [])]
        escalated = TIER_RANK[tier] > TIER_RANK.get(prev.get("tier"), 0)
        retarget = "fixed" in prev and item["fixed"] != prev["fixed"] and (
            prev["fixed"] is None or (item["fixed"] is not None and vkey(item["fixed"]) > vkey(prev["fixed"])))
        # Evidence alone (KEV or malicious turning unknown or true, a higher
        # severity) changes the bead's text and remediation: it rewrites too. It is
        # compared against the stored item (what the bead was last written from),
        # so a change that appears only in the ledger (a hand edit) counts as well.
        stored = prev.get("item") if isinstance(prev.get("item"), dict) and not prev.get("adopted") else None
        base = {k: stored[k] for k in ("kev", "malicious") if k in stored} if stored else before
        base_sev = stored.get("severity") if stored else prev_sev
        evidence = ["%s %s to %s" % ("KEV" if k == "kev" else "malicious", FLAG_WORD[base[k]], FLAG_WORD[item[k]])
                    for k in ("kev", "malicious") if k in base and base[k] in FLAG_WORD and base[k] != item[k]]
        if base_sev in SEV_RANK and SEV_RANK[item["severity"]] > SEV_RANK[base_sev]:
            evidence.append("severity %s to %s" % (base_sev, item["severity"]))
        drift = bool(prev.get("adopted")) and (
            prev.get("priority") != item["priority"] or bool(set(item["labels"]) - set(prev["labels"]))
            or bool((set(prev["labels"]) & TIER_LABELS) - {"tier-" + tier.lower()}))
        rewrite = bool(new_ids or escalated or retarget or evidence or drift
                       # An entry from before hq-8cry.9 has no stored plan: refresh the bead once.
                       or ("item" not in prev and not prev.get("adopted")))
        item.update({"new_ids": new_ids, "escalated_from": prev.get("tier") if escalated else None,
                     "fixed_from": prev.get("fixed") if retarget else None, "evidence": evidence,
                     "rewrite": rewrite,
                     # KEV or malicious news on an inactive bead (closed, deferred) reopens
                     # it: a comment there is read by nobody.
                     "reopen": rewrite and isinstance(rec, dict) and rec.get("status") in INACTIVE
                               and (item["kev"] is True or item["malicious"] is True),
                     # A bead adopted from the ledger at tier C with no paged label lost its
                     # pending page with the state file: page it now.
                     "page": tier == "C" and (escalated or (bool(prev.get("adopted")) and not prev.get("paged")))})
        if item["rewrite"] or item["adopted"] or reconciled:
            plan["update"].append(item)
        if not item["rewrite"]:
            plan["duplicates"] += 1
        # A tier A bead held by the cooldown (or capped) on an earlier run goes out once free.
        if tier == "A" and not item["dispatched"]:
            (plan["held"] if hold else plan["dispatch"]).append(item)
    if looked_up:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(a.published)), prefix=".published.")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(published, fh, indent=1, sort_keys=True)
            os.replace(tmp, a.published)
        except BaseException:
            os.unlink(tmp)
            raise
    json.dump(plan, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
