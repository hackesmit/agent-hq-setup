# Logon-task entry (pythonw, no console window): python -m hands serve from this folder.
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hands import core  # noqa: E402
from hands.app import main  # noqa: E402

home = core.home()
home.mkdir(parents=True, exist_ok=True)
if sys.stderr is None:  # pythonw has no console; keep crash tracebacks for the restart log
    sys.stderr = open(home / "stderr.log", "a", encoding="utf-8", buffering=1)
main(sys.argv[1:] or ["serve"])
