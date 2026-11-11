# test_sla.py: an unanswered question re-rings but never climbs to P0 by itself.
import importlib.util
import json
import os
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_statelib(state_dir):
    os.environ["WR"] = state_dir
    spec = importlib.util.spec_from_file_location("hq_statelib_sla", os.path.join(HERE, "statelib.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SlaTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.sl = load_statelib(self.dir)
        self.sl.sessions = lambda: {}
        self.sl.asker_gone = lambda r, s: False
        self.sl.interactive_ask = lambda r, s: False

    def sweep(self, sev, age_s):
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - age_s))
        self.sl.save("requests.json", [{"id": "r-1", "status": "open", "sev": sev, "ts": ts}])
        return self.sl.sla_sweep()

    def test_p1_stays_p1(self):
        out = self.sweep("P1", 5 * 3600)
        self.assertEqual([r["sev"] for r in out], ["P1"], "breached P1 re-rings at P1")

    def test_p2_still_raises_to_p1(self):
        self.assertEqual([r["sev"] for r in self.sweep("P2", 25 * 3600)], ["P1"])

    def test_no_raise_ever_reaches_p0_from_below(self):
        self.assertNotIn("P0", [self.sl.SLA_RAISE["P1"], self.sl.SLA_RAISE["P2"]])


if __name__ == "__main__":
    unittest.main()
