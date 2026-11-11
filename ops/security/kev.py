#!/usr/bin/env python3
"""kev: join osv-scanner results with CISA KEV into one findings JSON (hq-8cry.2).

match.sh runs the scanner and writes a manifest of raw results; this script is
the pure join. It reads only structured feeds (osv-scanner JSON, the CISA KEV
JSON catalog, earlier findings files), never prose, and copies only ids,
package names, versions and paths into the report, so nothing from a lockfile
beyond those can leak into it.

Inputs (all paths):
  --manifest  TSV, one scan per line: rig <TAB> target <TAB> raw-osv-json
  --kev       CISA known_exploited_vulnerabilities.json (missing = no KEV join)
  --extra     JSON {"coverage": [...], "images": [...], "scanner": {...}}
  --prev-dir  directory of earlier findings-YYYY-MM-DD.json (first-seen dates)
  --date      YYYY-MM-DD of this run
  --out       findings file to write

A finding is one advisory group on one package version in one rig; the same
group found through two lockfiles (or a lockfile and an image) of one rig is one
finding with two sources. first_seen is keyed on rig, ecosystem, package and
the advisory id, so a version bump that is still vulnerable keeps its date.
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone

SEV_RANK = {"UNKNOWN": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}


def vkey(v):
    """Loose version order: numeric runs compare as ints, others as text."""
    parts = re.split(r"[.\-+_~:]", str(v or ""))
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in parts]


def label_from_score(score):
    try:
        s = float(score)
    except (TypeError, ValueError):
        return "UNKNOWN"
    if s >= 9.0:
        return "CRITICAL"
    if s >= 7.0:
        return "HIGH"
    if s >= 4.0:
        return "MEDIUM"
    return "LOW" if s > 0 else "UNKNOWN"


def norm_label(label):
    label = str(label or "").upper()
    return "MEDIUM" if label == "MODERATE" else (label if label in SEV_RANK else "UNKNOWN")


def fixed_version(vulns, name, ecosystem, installed):
    """The lowest fixed version above the installed one, across the group."""
    fixes = []
    for v in vulns:
        for aff in v.get("affected") or []:
            pkg = aff.get("package") or {}
            if pkg.get("name") != name or (ecosystem and pkg.get("ecosystem", "").split(":")[0] != ecosystem.split(":")[0]):
                continue
            for rng in aff.get("ranges") or []:
                for ev in rng.get("events") or []:
                    if "fixed" in ev:
                        fixes.append(ev["fixed"])
    above = sorted({f for f in fixes if vkey(f) > vkey(installed)}, key=vkey)
    return above[0] if above else None


def pick_id(ids):
    """Stable representative id: a GHSA id, then a CVE, then the first sorted."""
    ids = sorted(ids)
    for prefix in ("MAL-", "GHSA-", "CVE-"):
        for i in ids:
            if i.startswith(prefix):
                return i
    return ids[0]


def load_kev(path):
    if not path or not os.path.exists(path):
        return {}, None
    with open(path) as f:
        cat = json.load(f)
    kev = {v["cveID"]: v.get("dateAdded") for v in cat.get("vulnerabilities") or [] if v.get("cveID")}
    meta = {"version": cat.get("catalogVersion"), "released": cat.get("dateReleased"), "count": len(kev)}
    return kev, meta


def load_first_seen(prev_dir):
    seen = {}
    # Today's own file is read too, so a same-day rerun keeps its dates.
    for p in sorted(glob.glob(os.path.join(prev_dir or "", "findings-*.json"))):
        try:
            with open(p) as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        for fd in data.get("findings") or []:
            k = seen_key(fd["rig"], fd.get("ecosystem"), fd["package"], fd["id"])
            d = fd.get("first_seen")
            if d and (k not in seen or d < seen[k]):
                seen[k] = d
    return seen


def seen_key(rig, eco, pkg, fid):
    return "|".join([rig, eco or "", pkg, fid])


def findings_from(raw, rig, target, kev):
    out = []
    for res in raw.get("results") or []:
        for p in res.get("packages") or []:
            pkg = p.get("package") or {}
            name, ver, eco = pkg.get("name"), pkg.get("version"), pkg.get("ecosystem") or ""
            vulns = {v["id"]: v for v in p.get("vulnerabilities") or [] if v.get("id")}
            groups = p.get("groups") or [{"ids": [i]} for i in vulns]
            for g in groups:
                ids = list(g.get("ids") or [])
                if not ids:
                    continue
                gv = [vulns[i] for i in ids if i in vulns]
                aliases = set(ids) | set(g.get("aliases") or [])
                for v in gv:
                    aliases |= set(v.get("aliases") or [])
                labels = [norm_label((v.get("database_specific") or {}).get("severity")) for v in gv]
                sev = max(labels + [label_from_score(g.get("max_severity"))], key=SEV_RANK.get)
                cves = sorted(a for a in aliases if a.startswith("CVE-"))
                kev_hits = sorted(kev[c] for c in cves if c in kev)
                out.append({
                    "id": pick_id(ids),
                    "aliases": sorted(aliases - {pick_id(ids)}),
                    "rig": rig,
                    "package": name,
                    "ecosystem": eco,
                    "installed": ver,
                    "fixed": fixed_version(gv, name, eco, ver),
                    "severity": sev,
                    "cvss": g.get("max_severity") or None,
                    "kev": bool(kev_hits),
                    "kev_date_added": kev_hits[0] if kev_hits else None,
                    "malicious": any(a.startswith("MAL-") for a in aliases),
                    "sources": [target],
                })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--kev")
    ap.add_argument("--extra")
    ap.add_argument("--prev-dir")
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    kev, kev_meta = load_kev(a.kev)
    extra = {}
    if a.extra and os.path.exists(a.extra):
        with open(a.extra) as f:
            extra = json.load(f)
    coverage = list(extra.get("coverage") or [])

    merged = {}
    with open(a.manifest) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            rig, target, raw_path = line.split("\t")
            try:
                with open(raw_path) as rf:
                    raw = json.load(rf)
            except (OSError, ValueError) as e:
                coverage.append({"rig": rig, "kind": "scan-error", "target": target,
                                 "detail": "unreadable scanner output: %s" % type(e).__name__})
                continue
            for fd in findings_from(raw, rig, target, kev):
                k = (fd["rig"], fd["ecosystem"], fd["package"], fd["installed"], fd["id"])
                if k in merged:
                    if target not in merged[k]["sources"]:
                        merged[k]["sources"].append(target)
                else:
                    merged[k] = fd

    seen = load_first_seen(a.prev_dir)
    findings = []
    for fd in merged.values():
        fd["first_seen"] = seen.get(seen_key(fd["rig"], fd["ecosystem"], fd["package"], fd["id"]), a.date)
        findings.append(fd)
    findings.sort(key=lambda f: (-f["malicious"], -bool(f["kev"]), -SEV_RANK[f["severity"]], f["rig"], f["package"], f["id"]))

    if kev_meta is None:
        # the catalog was not available: unknown, never "not exploited"
        for fd in findings:
            fd["kev"] = None
    counts = {s: 0 for s in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN")}
    for fd in findings:
        counts[fd["severity"]] += 1
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "date": a.date,
        "scanner": extra.get("scanner"),
        "kev_catalog": kev_meta,
        "summary": {"findings": len(findings), "kev": sum(bool(f["kev"]) for f in findings),
                    "malicious": sum(f["malicious"] for f in findings), "by_severity": counts,
                    # a scan that failed or a missing KEV catalog makes the run
                    # incomplete; match.sh exits 4 so nobody reads it as all clear
                    "scan_errors": sum(1 for c in coverage if c.get("kind") == "scan-error"),
                    "kev_available": kev_meta is not None},
        "findings": findings,
        "coverage": coverage,
        "images": extra.get("images") or [],
    }
    tmp = a.out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(report, f, indent=1)
        f.write("\n")
    os.replace(tmp, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
