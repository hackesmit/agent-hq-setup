#!/usr/bin/env python3
"""Unit tests for ops/console/liveness.py (hq-6ih29.1).

Every case runs against a fake /proc tree and a fake ~/.claude/sessions directory
written into a temp dir, so the assertions are about the rules, not about whatever
runs on the box today.

run: python3 -m unittest discover -s ops/console -p 'test_*.py'
"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("liveness", os.path.join(HERE, "liveness.py"))
lv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lv)

CLK = 100
CLAUDE_START = 1_000_000  # ticks


class Box:
    """A fake /proc plus a fake sessions dir."""

    def __init__(self, root):
        self.proc = os.path.join(root, "proc")
        self.sessions = os.path.join(root, "sessions")
        os.makedirs(self.proc)
        os.makedirs(self.sessions)

    def proc_entry(self, pid, ppid, start, comm="bash", state="S", env=None, cmd="bash"):
        d = os.path.join(self.proc, str(pid))
        os.makedirs(d)
        # fields after "(comm)": state ppid pgrp session tty tpgid flags minflt cminflt
        # majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
        rest = [state, str(ppid)] + ["0"] * 17 + [str(start)] + ["0"] * 5
        with open(os.path.join(d, "stat"), "w") as fh:
            fh.write("%d (%s) %s\n" % (pid, comm, " ".join(rest)))
        with open(os.path.join(d, "environ"), "wb") as fh:
            fh.write(b"\0".join(("%s=%s" % kv).encode() for kv in (env or {}).items()) + b"\0")
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(cmd.replace(" ", "\0").encode())

    def claude(self, pid, sid, status="idle", start=CLAUDE_START, var="HQ_CONSOLE_SID", proc_start=None, extra_env=None):
        env = {var: sid, "HOME": "/home/x"}
        env.update(extra_env or {})
        self.proc_entry(pid, 1, start, comm="claude", env=env, cmd="claude --dangerously-skip-permissions")
        self.presence(pid, status, start if proc_start is None else proc_start)

    def presence(self, pid, status, proc_start):
        rec = {"pid": pid, "sessionId": "u-%d" % pid, "procStart": str(proc_start), "status": status}
        with open(os.path.join(self.sessions, "%d.json" % pid), "w") as fh:
            json.dump(rec, fh)

    def mcp(self, pid, parent, after_s=1):
        self.proc_entry(pid, parent, CLAUDE_START + after_s * CLK, comm="npm exec @mcp/x", cmd="npm exec @mcp/server-pdf --stdio")

    def bash_job(self, pid, parent, after_s=600, state="S"):
        self.proc_entry(pid, parent, CLAUDE_START + after_s * CLK, state=state,
                        cmd="/bin/bash -c source /home/x/.claude/shell-snapshots/s.sh && eval 'sleep 600'")

    def run(self, *ids):
        return lv.liveness(list(ids), sessions_dir=self.sessions, proc_root=self.proc, clk_tck=CLK)


class LivenessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.box = Box(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def live(self, sid):
        return self.box.run(sid)[sid]["live"]

    def test_idle_no_children_is_idle(self):
        self.box.claude(100, "s-a")
        self.assertEqual(self.live("s-a"), "idle")

    def test_background_bash_child_is_busy(self):
        self.box.claude(100, "s-a")
        self.box.bash_job(200, 100)
        r = self.box.run("s-a")["s-a"]
        self.assertEqual(r["live"], "busy")
        self.assertIn("child 200", r["why"])

    def test_mcp_server_child_only_is_idle(self):
        self.box.claude(100, "s-a")
        self.box.mcp(201, 100, after_s=2)
        self.assertEqual(self.live("s-a"), "idle")

    def test_mcp_plus_background_bash_is_busy(self):
        self.box.claude(100, "s-a")
        self.box.mcp(201, 100)
        self.box.bash_job(202, 100)
        self.assertEqual(self.live("s-a"), "busy")

    def test_tool_shell_started_inside_mcp_window_is_busy(self):
        # live check 2026-11-03: a session launched with a prompt started its
        # background Bash 8.6 s after claude, inside the MCP window
        self.box.claude(100, "s-a")
        self.box.mcp(201, 100, after_s=2)
        self.box.bash_job(202, 100, after_s=8)
        self.assertEqual(self.live("s-a"), "busy")

    def test_zombie_child_does_not_count(self):
        self.box.claude(100, "s-a")
        self.box.bash_job(200, 100, state="Z")
        self.assertEqual(self.live("s-a"), "idle")

    def test_grandchild_of_other_process_does_not_count(self):
        self.box.claude(100, "s-a")
        self.box.proc_entry(300, 1, CLAUDE_START + 900 * CLK)
        self.box.bash_job(301, 300)
        self.assertEqual(self.live("s-a"), "idle")

    def test_status_shell_is_busy(self):
        # Claude Code writes "shell" when the turn is idle but a background Bash runs
        self.box.claude(100, "s-a", status="shell")
        self.assertEqual(self.live("s-a"), "busy")

    def test_status_busy_from_background_agent_is_busy(self):
        # a background Agent runs in-process: no child, but Claude Code says busy
        self.box.claude(100, "s-a", status="busy")
        self.assertEqual(self.live("s-a"), "busy")

    def test_status_waiting_is_busy(self):
        self.box.claude(100, "s-a", status="waiting")
        self.assertEqual(self.live("s-a"), "busy")

    def test_missing_status_is_unknown(self):
        self.box.claude(100, "s-a", status="")
        self.assertIsNone(self.live("s-a"))

    def test_no_presence_file_is_unknown(self):
        self.box.proc_entry(100, 1, CLAUDE_START, comm="claude", env={"HQ_CONSOLE_SID": "s-a"})
        self.assertIsNone(self.live("s-a"))

    def test_missing_pid_is_unknown(self):
        self.box.presence(100, "idle", CLAUDE_START)  # presence file, process gone
        self.assertIsNone(self.live("s-a"))

    def test_reused_pid_is_unknown(self):
        self.box.claude(100, "s-a", proc_start=CLAUDE_START - 5)
        self.assertIsNone(self.live("s-a"))

    def test_session_eval_process_is_not_the_pane(self):
        self.box.claude(100, "s-a", extra_env={"HQ_SESSION_EVAL": "1"})
        self.assertIsNone(self.live("s-a"))

    def test_id_precedence_matches_the_hook(self):
        # a worker spawned from a console terminal carries both ids; its own wins
        self.box.claude(100, "s-con", var="HQ_CONSOLE_SID")
        self.box.claude(101, "s-wk", var="CDP_TERMINAL_ID", start=CLAUDE_START + 10,
                        extra_env={"HQ_CONSOLE_SID": "s-con"})
        r = self.box.run("s-con", "s-wk")
        self.assertEqual(r["s-con"]["live"], "idle")
        self.assertEqual(r["s-wk"]["live"], "idle")

    def test_oldest_claude_wins_for_a_shared_id(self):
        self.box.claude(100, "s-a", status="idle")
        self.box.claude(150, "s-a", status="busy", start=CLAUDE_START + 5000)
        self.assertEqual(self.live("s-a"), "idle")

    def test_unreadable_sessions_dir_is_unknown(self):
        r = lv.liveness(["s-a"], sessions_dir=os.path.join(self.tmp, "nope"), proc_root=self.box.proc, clk_tck=CLK)
        self.assertIsNone(r["s-a"]["live"])

    def test_comm_with_parens_and_spaces(self):
        self.box.claude(100, "s-a")
        self.box.proc_entry(200, 100, CLAUDE_START + 600 * CLK, comm="node (vitest) x")
        self.assertEqual(self.live("s-a"), "busy")


class SettleTest(unittest.TestCase):
    NOW = "2026-11-03T07:00:00Z"

    def test_working_stays_working(self):
        self.assertEqual(lv.settle({"turn": "working", "at": "t"}, {"live": "idle"}, self.NOW)["turn"], "working")

    def test_idle_and_live_idle_is_idle(self):
        v = lv.settle({"turn": "idle", "at": "t"}, {"live": "idle", "why": "w"}, self.NOW)
        self.assertEqual((v["turn"], v["at"]), ("idle", "t"))

    def test_idle_and_busy_is_background_now(self):
        v = lv.settle({"turn": "idle", "at": "t"}, {"live": "busy", "why": "w"}, self.NOW)
        self.assertEqual((v["turn"], v["at"]), ("background", self.NOW))

    def test_idle_and_unknown_is_background_keeping_time(self):
        v = lv.settle({"turn": "idle", "at": "t"}, {"live": None, "why": "w"}, self.NOW)
        self.assertEqual((v["turn"], v["at"]), ("background", "t"))
        v = lv.settle({"turn": "idle", "at": "t"}, None, self.NOW)
        self.assertEqual(v["turn"], "background")

    def test_old_background_record_follows_liveness(self):
        v = lv.settle({"turn": "background", "at": "t"}, {"live": "idle"}, self.NOW)
        self.assertEqual(v["turn"], "idle")

    def test_unknown_turn_is_dropped(self):
        self.assertIsNone(lv.settle({"turn": "weird"}, {"live": "idle"}, self.NOW))


class ReviewReprosTest(unittest.TestCase):
    """The two round-2 blocks: the hook file says idle, the card must not be red."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.box = Box(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def shown(self, sid):
        live = self.box.run(sid)[sid]
        return lv.settle({"turn": "idle", "at": "2026-11-03T06:00:00Z"}, live, "2026-11-03T06:01:00Z")["turn"]

    def test_repro_a_prompt_mid_background_build(self):
        # UserPromptSubmit; Bash run_in_background; Stop; UserPromptSubmit; Stop: the
        # hook file reads idle, but the build's shell is still a child and Claude says shell
        self.box.claude(100, "s-a", status="shell")
        self.box.bash_job(200, 100)
        self.assertEqual(self.shown("s-a"), "background")

    def test_repro_a_even_if_status_lags(self):
        self.box.claude(100, "s-a", status="idle")
        self.box.bash_job(200, 100)
        self.assertEqual(self.shown("s-a"), "background")

    def test_repro_c_background_agent_long_tool_call(self):
        # Agent (in-process) running a long Bash: Claude says busy and the subagent's
        # Bash is a child of the same claude process
        self.box.claude(100, "s-c", status="busy")
        self.box.bash_job(200, 100, after_s=60)
        self.assertEqual(self.shown("s-c"), "background")

    def test_repro_c_agent_thinking_no_child(self):
        self.box.claude(100, "s-c", status="busy")
        self.assertEqual(self.shown("s-c"), "background")

    def test_really_finished_is_idle(self):
        self.box.claude(100, "s-d", status="idle")
        self.box.mcp(201, 100)
        self.assertEqual(self.shown("s-d"), "idle")


if __name__ == "__main__":
    unittest.main()
