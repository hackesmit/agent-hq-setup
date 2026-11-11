#!/usr/bin/env python3
"""Unit tests for ops/console/usage.py, the per-project attribution half.

Everything here runs against fixtures written into a temp directory: a fake
~/.claude/projects tree, a fake ops/projects.json, and a fake state/sessions.json.
Nothing reads the real box, so the assertions are about the rules rather than
about whatever happens to be on disk today.

run: python3 -m unittest discover -s ops/console -p 'test_*.py'
"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))


def load_usage():
    spec = importlib.util.spec_from_file_location("hq_usage", os.path.join(HERE, "usage.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


usage = load_usage()

HQ = "/home/owner/hq"
PROJECTS_JSON = {
    "projects": [
        {"id": "hq", "path": HQ},
        {"id": "acme-dashboard", "path": HQ + "/rigs/acme-dashboard"},
        {"id": "gym-tracker", "path": HQ + "/rigs/gym-tracker"},
        {"id": "minecraft", "path": HQ + "/ops/services/minecraft"},
        {"id": "acme-financial", "path": HQ + "/ops/services/acme-financial"},
        {"id": "studioco-digital", "path": None},
    ]
}
SESSIONS_JSON = {
    "s-9001": {"id": "s-9001", "rig": "chesski", "worktree": "/srv/elsewhere/chesski-9001"},
    "s-9002": {"id": "s-9002", "rig": "fintrack-portfolio", "worktree": HQ + "/rigs/fintrack-portfolio-9002"},
    "s-bad": {"id": "s-bad", "rig": "", "worktree": ""},
}


def attribution(**kw):
    return usage.Attribution(PROJECTS_JSON, SESSIONS_JSON, hq=HQ, home="/home/owner", **kw)


class TestAttribution(unittest.TestCase):
    def test_rig_path_maps_to_its_rig(self):
        a = attribution()
        self.assertEqual(a.project_for(HQ + "/rigs/acme-dashboard"), "acme-dashboard")
        self.assertEqual(a.project_for(HQ + "/rigs/acme-dashboard/js/charts"), "acme-dashboard")

    def test_worktree_reads_back_to_its_rig(self):
        a = attribution()
        # spawn.sh's rigs/<rig>-<4 hex>
        self.assertEqual(a.project_for(HQ + "/rigs/acme-dashboard-541b"), "acme-dashboard")
        self.assertEqual(a.project_for(HQ + "/rigs/gym-tracker-1a2b/src"), "gym-tracker")
        # the other spelling, ~/hq-<rig>-<suffix>
        self.assertEqual(a.project_for("/home/owner/hq-gym-tracker-77aa"), "gym-tracker")

    def test_hq_itself_and_anything_under_it(self):
        a = attribution()
        self.assertEqual(a.project_for(HQ), "hq")
        self.assertEqual(a.project_for(HQ + "/ops/console/v2/web"), "hq")
        # an agent worktree of the hq repo is still hq
        self.assertEqual(a.project_for(HQ + "/.claude/worktrees/agent-abc123"), "hq")

    def test_registry_settles_a_worktree_outside_the_rigs_tree(self):
        a = attribution()
        self.assertEqual(a.project_for("/srv/elsewhere/chesski-9001/src"), "chesski")
        # and wins over the path shape where both could answer
        self.assertEqual(a.project_for(HQ + "/rigs/fintrack-portfolio-9002"), "fintrack-portfolio")

    def test_a_declared_path_outside_rigs(self):
        a = attribution()
        self.assertEqual(a.project_for(HQ + "/ops/services/minecraft/server"), "minecraft")

    def test_a_directory_named_after_a_project_whose_registry_path_drifted(self):
        # acme-financial is registered under ops/services but the work happens
        # in bunkers/. The name still resolves rather than falling into hq.
        self.assertEqual(attribution().project_for(HQ + "/bunkers/acme-financial"), "acme-financial")

    def test_the_home_worktree_spelling_matches_by_prefix_not_only_at_its_root(self):
        a = attribution()
        self.assertEqual(a.project_for("/home/owner/hq-gym-tracker-77aa"), "gym-tracker")
        self.assertEqual(a.project_for("/home/owner/hq-gym-tracker-77aa/frontend/src"), "gym-tracker")
        # a ~/hq-something that is not a rig is not turned into a project
        self.assertEqual(a.project_for("/home/owner/hq-mail/logs"), "unattributed")

    def test_a_registry_row_wider_than_the_workspace_cannot_capture_everything(self):
        # a row whose worktree is the hq root (or an ancestor of it, or the
        # rigs directory) is ignored: it would file the whole box under one rig
        sessions = dict(SESSIONS_JSON,
                        **{"s-wide": {"rig": "chesski", "worktree": HQ},
                           "s-wider": {"rig": "chesski", "worktree": "/home/owner"},
                           "s-rigs": {"rig": "chesski", "worktree": HQ + "/rigs"}})
        a = usage.Attribution(PROJECTS_JSON, sessions, hq=HQ, home="/home/owner")
        self.assertEqual(a.project_for(HQ), "hq")
        self.assertEqual(a.project_for(HQ + "/ops"), "hq")
        self.assertEqual(a.project_for(HQ + "/rigs/gym-tracker"), "gym-tracker")
        # a properly narrow row still wins
        self.assertEqual(a.project_for("/srv/elsewhere/chesski-9001/src"), "chesski")

    def test_a_rig_with_no_registry_entry_keeps_its_own_name(self):
        a = attribution()
        self.assertEqual(a.project_for(HQ + "/rigs/fantasy-hq"), "fantasy-hq")
        # a project genuinely named with a hex-looking tail is not truncated:
        # rigs/never-heard-of-1a2b has no rigs/never-heard-of to fall back to
        self.assertEqual(a.project_for(HQ + "/rigs/never-heard-of-1a2b"), "never-heard-of-1a2b")

    def test_a_scratchpad_is_read_back_to_the_session_that_owns_it(self):
        a = attribution()
        self.assertEqual(a.project_for("/tmp/claude-1000/-home-owner-hq/abc-def/scratchpad"), "hq")
        self.assertEqual(
            a.project_for("/tmp/claude-1000/-home-owner-hq-rigs-gym-tracker/abc/scratchpad"), "gym-tracker"
        )

    def test_anything_else_is_named_unattributed_not_guessed(self):
        a = attribution()
        self.assertEqual(a.project_for("/home/owner"), "unattributed")
        self.assertEqual(a.project_for("/mnt/c/Users/Dan"), "unattributed")
        self.assertEqual(a.project_for(""), "unattributed")
        self.assertEqual(a.project_for(None), "unattributed")

    def test_a_sibling_of_hq_is_not_inside_hq(self):
        # the prefix test is segment-aware: /home/owner/hq-tools is not hq
        self.assertEqual(attribution().project_for("/home/owner/hqueue/x"), "unattributed")

    def test_no_registries_at_all_still_resolves_path_shapes(self):
        a = usage.Attribution(None, None, hq=HQ, home="/home/owner")
        self.assertEqual(a.project_for(HQ + "/rigs/gym-tracker"), "gym-tracker")
        self.assertEqual(a.project_for(HQ + "/ops"), "hq")


class TestPricing(unittest.TestCase):
    def test_a_dated_snapshot_prices_as_its_base_model(self):
        self.assertEqual(usage.price_of("claude-haiku-4-5-20251001"), usage.price_of("claude-haiku-4-5"))

    def test_an_unknown_model_has_no_price_rather_than_a_zero_one(self):
        self.assertIsNone(usage.price_of("<synthetic>"))
        self.assertIsNone(usage.price_of(""))

    def test_by_project_prices_each_model_at_its_own_rate(self):
        now = datetime(2026, 9, 6, 12, 0, 0)
        today = now.strftime("%Y-%m-%d")
        cache = {
            "days": {
                today: {
                    "projects": {
                        "gym-tracker": {
                            "sessions": ["s1", "s2"],
                            "models": {
                                # 1M in, 1M out at $5/$25
                                "claude-opus-5": {"input": 1_000_000, "output": 1_000_000,
                                                  "cache_read": 0, "cache_write": 0},
                                # 1M cache read at $0.20
                                "claude-sonnet-5": {"input": 0, "output": 0,
                                                    "cache_read": 1_000_000, "cache_write": 0},
                            },
                        },
                    },
                },
            },
        }
        [row] = usage.by_project(cache, 30, now=now)
        self.assertEqual(row["project"], "gym-tracker")
        self.assertEqual(row["inputTokens"], 1_000_000)
        self.assertEqual(row["outputTokens"], 1_000_000)
        self.assertEqual(row["cacheReadTokens"], 1_000_000)
        self.assertEqual(row["sessions"], 2)
        self.assertAlmostEqual(row["costUsd"], 5.0 + 25.0 + 0.20, places=4)
        self.assertEqual(row["tokens"], 3_000_000)
        self.assertEqual(row["unpricedModels"], [])

    def test_the_two_cache_write_ttls_are_priced_apart(self):
        # opus 5 input lists at $5/MTok, so a 5 minute write is $6.25 (1.25x)
        # and a 1 hour write is $10.00 (2x). Pricing both at 1.25x understated
        # this box by about 8 percent, which is what round one blocked on.
        now = datetime(2026, 9, 6, 12, 0, 0)
        def cache(cw, cw1h):
            return {"days": {now.strftime("%Y-%m-%d"): {"projects": {"hq": {
                "sessions": ["s1"],
                "models": {"claude-opus-5": {"input": 0, "output": 0, "cache_read": 0,
                                             "cache_write": cw, "cache_write_1h": cw1h}},
            }}}}}
        [all_1h] = usage.by_project(cache(1_000_000, 1_000_000), 30, now=now)
        self.assertEqual(all_1h["costUsd"], 10.0)
        self.assertEqual(all_1h["cacheWrite1hTokens"], 1_000_000)
        [all_5m] = usage.by_project(cache(1_000_000, 0), 30, now=now)
        self.assertEqual(all_5m["costUsd"], 6.25)
        self.assertEqual(all_5m["cacheWrite1hTokens"], 0)
        [mixed] = usage.by_project(cache(1_000_000, 400_000), 30, now=now)
        self.assertEqual(mixed["costUsd"], round(0.6 * 6.25 + 0.4 * 10.0, 4))
        # the reported write total stays the total, so byProject still
        # reconciles against the day row
        self.assertEqual(mixed["cacheWriteTokens"], 1_000_000)
        # a 1h counter larger than the total cannot inflate the bill
        [clamped] = usage.by_project(cache(1_000, 9_999), 30, now=now)
        self.assertEqual(clamped["costUsd"], round(1_000 * 10.0 / 1e6, 4))

    def test_cache_writes_reads_the_ttl_split_and_falls_back_to_the_rollup(self):
        # what Claude Code writes today: a split beside the rollup
        self.assertEqual(
            usage.cache_writes({"cache_creation_input_tokens": 1000,
                                "cache_creation": {"ephemeral_5m_input_tokens": 400,
                                                   "ephemeral_1h_input_tokens": 600}}),
            (1000, 600),
        )
        # the split is the more complete of the two: 20 lines on this box carry
        # a zero rollup beside a non-zero split
        self.assertEqual(
            usage.cache_writes({"cache_creation_input_tokens": 0,
                                "cache_creation": {"ephemeral_5m_input_tokens": 0,
                                                   "ephemeral_1h_input_tokens": 784}}),
            (784, 784),
        )
        # a producer that sends no split: everything at the 5 minute rate
        self.assertEqual(usage.cache_writes({"cache_creation_input_tokens": 500}), (500, 0))
        self.assertEqual(usage.cache_writes({"cache_creation_input_tokens": 500,
                                             "cache_creation": {}}), (500, 0))
        self.assertEqual(usage.cache_writes({}), (0, 0))

    def test_an_unpriced_model_counts_tokens_and_declares_itself(self):
        now = datetime(2026, 9, 6, 12, 0, 0)
        cache = {"days": {now.strftime("%Y-%m-%d"): {"projects": {"hq": {
            "sessions": ["s1"],
            "models": {"some-new-model": {"input": 10, "output": 20, "cache_read": 0, "cache_write": 0}},
        }}}}}
        [row] = usage.by_project(cache, 30, now=now)
        self.assertEqual(row["costUsd"], 0)
        self.assertEqual(row["outputTokens"], 20)
        self.assertEqual(row["unpricedModels"], ["some-new-model"])

    def test_days_outside_the_window_are_excluded(self):
        now = datetime(2026, 9, 6, 12, 0, 0)
        old = (now - timedelta(days=45)).strftime("%Y-%m-%d")
        cache = {"days": {old: {"projects": {"hq": {"sessions": ["s1"], "models": {
            "claude-opus-5": {"input": 1_000_000, "output": 0, "cache_read": 0, "cache_write": 0}}}}}}}
        self.assertEqual(usage.by_project(cache, 30, now=now), [])
        self.assertEqual(len(usage.by_project(cache, 60, now=now)), 1)


class TestEndToEnd(unittest.TestCase):
    """Three fixture transcripts, one scan, one JSON document."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hq-usage-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.transcripts = os.path.join(self.tmp, "projects")
        self.day = datetime.now().astimezone().strftime("%Y-%m-%dT12:00:00.000Z")
        self.write("-home-owner-hq-rigs-acme-dashboard", "sess-rig",
                   HQ + "/rigs/acme-dashboard", "claude-sonnet-5",
                   {"input_tokens": 1000, "output_tokens": 2000,
                    "cache_read_input_tokens": 10_000, "cache_creation_input_tokens": 500,
                    "cache_creation": {"ephemeral_5m_input_tokens": 300,
                                       "ephemeral_1h_input_tokens": 200}})
        self.write("-home-owner-hq-rigs-gym-tracker-1a2b", "sess-worktree",
                   HQ + "/rigs/gym-tracker-1a2b", "claude-opus-5",
                   {"input_tokens": 4000, "output_tokens": 8000,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})
        self.write("-home-owner-hq", "sess-hq", HQ, "claude-opus-5",
                   {"input_tokens": 100, "output_tokens": 200,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})
        self.projects_json = os.path.join(self.tmp, "projects.json")
        with open(self.projects_json, "w") as fh:
            json.dump(PROJECTS_JSON, fh)
        self.registry_json = os.path.join(self.tmp, "sessions.json")
        with open(self.registry_json, "w") as fh:
            json.dump(SESSIONS_JSON, fh)

    def write(self, slug, session, cwd, model, u):
        d = os.path.join(self.transcripts, slug)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, session + ".jsonl"), "w") as fh:
            # a line with no usage at all, to prove the cheap filter still works
            fh.write(json.dumps({"type": "user", "cwd": cwd, "timestamp": self.day}) + "\n")
            fh.write(json.dumps({"type": "assistant", "cwd": cwd, "timestamp": self.day,
                                 "message": {"model": model, "usage": u}}) + "\n")

    def run_usage(self, extra=()):
        import subprocess
        env = dict(os.environ, HQ_USAGE_TRANSCRIPTS=self.transcripts)
        out = subprocess.run(
            ["python3", os.path.join(HERE, "usage.py"),
             "--state", os.path.join(self.tmp, "state"),
             "--projects", self.projects_json,
             "--registry", self.registry_json, *extra],
            capture_output=True, text=True, env=env,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_scan_attributes_each_transcript_by_its_cwd(self):
        usage.PROJECTS = self.transcripts
        cache = {"v": usage.CACHE_VERSION, "files": {}, "days": {}}
        touched = usage.scan(cache, attribution())
        self.assertEqual(touched, 3)
        rows = {r["project"]: r for r in usage.by_project(cache, 30)}
        self.assertEqual(set(rows), {"acme-dashboard", "gym-tracker", "hq"})
        self.assertEqual(rows["acme-dashboard"]["outputTokens"], 2000)
        self.assertEqual(rows["acme-dashboard"]["cacheReadTokens"], 10_000)
        self.assertEqual(rows["gym-tracker"]["inputTokens"], 4000)
        self.assertEqual(rows["hq"]["sessions"], 1)
        # sonnet 5: 1000 in @ $2 + 2000 out @ $10 + 10000 read @ $0.20
        # + 300 write @ $2.50 (5m) + 200 write @ $4.00 (1h), reported to the
        # nearest hundredth of a cent
        self.assertAlmostEqual(
            rows["acme-dashboard"]["costUsd"],
            round(0.002 + 0.02 + 0.002 + 0.00075 + 0.0008, 4), places=6,
        )
        # the TTL split survives the scan, and the write total is still the total
        self.assertEqual(rows["acme-dashboard"]["cacheWriteTokens"], 500)
        self.assertEqual(rows["acme-dashboard"]["cacheWrite1hTokens"], 200)
        # costliest project first
        self.assertEqual(usage.by_project(cache, 30)[0]["project"], "gym-tracker")

    def test_the_day_totals_are_unchanged_by_the_new_dimension(self):
        usage.PROJECTS = self.transcripts
        cache = {"v": usage.CACHE_VERSION, "files": {}, "days": {}}
        usage.scan(cache, attribution())
        [day] = list(cache["days"].values())
        self.assertEqual(day["output"], 2000 + 8000 + 200)
        self.assertEqual(day["input"], 1000 + 4000 + 100)
        self.assertEqual(sorted(day["sessions"]), ["sess-hq", "sess-rig", "sess-worktree"])
        self.assertEqual(day["models"]["claude-opus-5"], 8200)
        # the day row keeps the write TOTAL and carries the 1h share beside it
        self.assertEqual(day["cache_write"], 500)
        self.assertEqual(day["cache_write_1h"], 200)
        # what byProject reports adds back up to the day row it came from
        rows = usage.by_project(cache, 30)
        self.assertEqual(sum(r["cacheWriteTokens"] for r in rows), day["cache_write"])
        self.assertEqual(sum(r["outputTokens"] for r in rows), day["output"])

    def test_a_second_scan_adds_nothing_twice(self):
        usage.PROJECTS = self.transcripts
        cache = {"v": usage.CACHE_VERSION, "files": {}, "days": {}}
        usage.scan(cache, attribution())
        before = usage.by_project(cache, 30)
        self.assertEqual(usage.scan(cache, attribution()), 0)
        self.assertEqual(usage.by_project(cache, 30), before)

    def test_an_older_cache_is_dropped_rather_than_upgraded_in_place(self):
        # every earlier shape, including the unversioned original: the bytes
        # that carry a new dimension were already consumed, so an in-place
        # upgrade would report the new field empty forever
        empty = {"v": usage.CACHE_VERSION, "files": {}, "days": {}}
        for stale in ({}, {"v": 1}, {"v": 2}, {"v": usage.CACHE_VERSION - 1}):
            path = os.path.join(self.tmp, "old-cache.json")
            with open(path, "w") as fh:
                json.dump(dict(stale, files={"/x": {"offset": 99, "size": 99}},
                               days={"2026-09-01": {"output": 5}}), fh)
            self.assertEqual(usage.load_cache(path), empty, stale)

    def test_the_cli_still_prints_the_original_shape(self):
        doc = self.run_usage()
        for key in ("today", "week", "series", "files_scanned"):
            self.assertIn(key, doc)
        self.assertIn("byProject", doc)
        self.assertEqual(doc["byProjectDays"], 30)
        self.assertEqual(len(doc["series"]), 14)
        doc7 = self.run_usage(["--days", "7", "--project-days", "60"])
        self.assertEqual(len(doc7["series"]), 7)
        self.assertEqual(doc7["byProjectDays"], 60)


if __name__ == "__main__":
    unittest.main()
