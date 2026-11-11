"""hq-63nvj.16: system_probe.sh against a stub george.sh. The stub keeps a fake George (the
default output per role, the level, mute) in a JSON file, records every call, and takes env
knobs that inject failures, so each fail-closed rule of the probe has a test."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROBE = Path(__file__).resolve().parents[1] / "system_probe.sh"

STUB = r'''#!/usr/bin/env python3
import json, os, sys
st_file = os.environ["STUB_STATE"]
st = json.load(open(st_file))
args = sys.argv[1:]
with open(os.environ["STUB_CALLS"], "a") as f:
    f.write(" ".join(args) + "\n")
ROLES = ["console", "multimedia", "communications"]

def reply(obj, rc=0):
    json.dump(st, open(st_file, "w"))
    print(json.dumps({"ok": rc == 0, **obj}))
    sys.exit(rc)

cmd, rest = args[0], args[1:]
if cmd == "audio" and not rest:
    outs = st["outputs"][: int(os.environ.get("STUB_OUTPUTS", "3"))]
    reply({"outputs": [{"name": n, "id": n, "default": n == st["out"]["console"]} for n in outs],
           "inputs": [{"name": "mic", "id": "mic", "default": True}],
           "defaults": {"output": st["out"], "input": {r: "mic" for r in ROLES}}})
if cmd == "audio" and rest[0] == "out":
    if os.environ.get("STUB_FAIL_OUT"):
        reply({"error": "timed out"}, 1)
    roles = ROLES
    if rest[1] == "--role":
        roles, rest = [ROLES[int(rest[2])]], rest[2:]
    for r in roles:
        st["out"][r] = rest[1]
    reply({"device": rest[1]})
if cmd == "volume":
    if rest == ["mute"]:
        st["muted"] = True
    elif rest:
        lvl = int(rest[0])
        st["level"] = lvl + 1 if os.environ.get("STUB_DRIFT") and lvl != 30 else lvl
        st["muted"] = False  # a level unmutes, as core.volume_target says
    reply({"level": st["level"], "muted": st["muted"], "device": "x"})
if cmd == "windows":
    reply({"idle_s": 999, "windows": []})
if cmd == "open":
    reply({"hwnd": 5})
if cmd == "shot":
    print("/tmp/shot.png"); sys.exit(0)
if cmd == "ps":
    reply({"exit_code": 0, "stdout": "", "stderr": "", "timed_out": False, "truncated": False})
reply({})
'''


@pytest.fixture
def probe(tmp_path):
    stub = tmp_path / "george.sh"
    stub.write_text(STUB)
    stub.chmod(0o755)
    state = tmp_path / "state.json"
    calls = tmp_path / "calls.txt"
    state.write_text(json.dumps({
        "outputs": ["spk", "hyperx", "hdmi"], "level": 61, "muted": True,
        "out": {"console": "spk", "multimedia": "spk", "communications": "hyperx"}}))
    calls.write_text("")

    def run(**env):
        e = {**os.environ, "PROBE_GEORGE": str(stub), "PROBE_SLEEP": "0", "STUB_STATE": str(state),
             "STUB_CALLS": str(calls), **env}
        p = subprocess.run(["bash", str(PROBE), str(tmp_path / "out"), "0"], env=e,
                           capture_output=True, text=True, timeout=60)
        return p, calls.read_text().splitlines(), json.loads(state.read_text())
    return run


def test_happy_path_restores_mute_and_each_role(probe):
    """(a) Starts muted at 61 with communications on another device: ends exactly so."""
    p, calls, st = probe()
    assert p.returncode == 0, p.stdout
    assert "probe passed" in p.stdout
    restore = calls[calls.index("audio out --role 0 spk"):]
    assert restore[:5] == ["audio out --role 0 spk", "audio out --role 1 spk", "audio out --role 2 hyperx",
                           "volume 61", "volume mute"]
    assert st["out"] == {"console": "spk", "multimedia": "spk", "communications": "hyperx"}
    assert st["level"] == 61 and st["muted"] is True
    assert "audio out hyperx" in calls  # switched to the second device by id, all roles


def test_one_output_changes_nothing(probe):
    """(b) One output device: exit 2, no audio out and no volume set."""
    p, calls, st = probe(STUB_OUTPUTS="1")
    assert p.returncode == 2 and "needs two" in p.stdout
    assert not [c for c in calls if c.startswith("audio out") or (c.startswith("volume ") and c != "volume")]


def test_failed_switch_still_restores(probe):
    """(c) audio out answers an error with exit 1: the probe exits nonzero and the trap
    still issued every restore."""
    p, calls, st = probe(STUB_FAIL_OUT="1")
    assert p.returncode != 0 and "FAIL: switch output" in p.stdout
    for want in ("audio out --role 0 spk", "audio out --role 1 spk", "audio out --role 2 hyperx",
                 "volume 61", "volume mute"):
        assert want in calls
    assert "probe FAILED" in p.stdout


def test_wrong_level_after_restore_fails(probe):
    """(d) The level read back after the restore is not the saved one: exit nonzero, named."""
    p, calls, st = probe(STUB_DRIFT="1")
    assert p.returncode != 0 and "after restore level is 62, was 61" in p.stdout


def test_a_role_left_on_the_wrong_device_fails(probe, tmp_path):
    """A restore that sets all roles at once leaves every role on the last saved id: caught."""
    probe_text = PROBE.read_text()
    broken = tmp_path / "probe_all_roles.sh"
    broken.write_text(probe_text.replace('g audio out --role "$r" "$id"', 'g audio out "$id"'))
    stub = tmp_path / "george.sh"
    e = {**os.environ, "PROBE_GEORGE": str(stub), "PROBE_SLEEP": "0",
         "STUB_STATE": str(tmp_path / "state.json"), "STUB_CALLS": str(tmp_path / "calls.txt")}
    p = subprocess.run(["bash", str(broken), str(tmp_path / "out2"), "0"], env=e, capture_output=True,
                       text=True, timeout=60)
    assert p.returncode != 0 and "output.console is hyperx, was spk" in p.stdout
