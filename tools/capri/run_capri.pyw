# Logon-task entry (pythonw, no console window): python -m capri run from this folder.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capri.app import main  # noqa: E402

main(sys.argv[1:] or ["run"])
