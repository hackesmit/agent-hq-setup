"""Paths, limits and the private write helpers for the work inbox watcher.

Every file under state/mail/work/ holds mail text: directories are 0700,
files 0600 from creation, and writes land by rename (voice.paths idiom).
"""

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The voice package (hq-w32vy.1) owns quote stripping, the n8n call helper
# and the claude -p wrapper; reuse it instead of a second copy.
VOICE_DIR = Path(os.environ.get("MW_VOICE_DIR", str(HERE.parents[1] / "voice")))
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

HQ = Path(os.environ.get("HQ_DIR", str(Path.home() / "hq")))
STATE = Path(os.environ.get("MW_STATE", str(HQ / "state" / "mail" / "work")))
VOICE_STATE = Path(os.environ.get("VOICE_STATE", str(HQ / "state" / "voice")))
FACTS = Path(os.environ.get("MW_FACTS", str(HQ / "ops" / "reference" / "owner-facts.md")))
ENV_FILE = Path(os.environ.get("MW_ENV", str(Path.home() / ".config" / "mail-watch" / "env")))
CTL = os.environ.get("MW_CTL", str(HQ / "ops" / "console" / "ctl.sh"))
NOTIFY = os.environ.get("MW_NOTIFY", str(HQ / "ops" / "scripts" / "notify.sh"))

ACCOUNT = "owner@example.com"
OWN_NAME = "Owner Name"
# Effectively uncapped (the owner 2026-11-04): Claude runs on the paid Max plan, so usage is
# tracked, not capped; MW_DAILY_CAP_USD puts a cap back if a reason appears.
DAILY_CAP_USD = float(os.environ.get("MW_DAILY_CAP_USD", "1000000"))
MAX_DRAFTS_PER_DAY = int(os.environ.get("MW_MAX_DRAFTS_PER_DAY", "25"))
MAX_TRIES = 3            # per message, then it is marked failed and dropped from the queue
TEXT_CAP = 8000          # chars of own text kept per message (context file and model input)
QUOTE_CAP = 4000         # chars of quoted history given to the drafter


def ensure_dir(d):
    d = Path(d)
    old = os.umask(0o077)
    try:
        d.mkdir(parents=True, exist_ok=True)
    finally:
        os.umask(old)
    os.chmod(d, 0o700)
    return d


def write_private(path, data):
    path = Path(path)
    ensure_dir(path.parent)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data.encode("utf-8") if isinstance(data, str) else data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return path


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, obj):
    return write_private(path, json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + "\n")


def read_env(path=None):
    """KEY=VALUE lines from the 0600 env file setup writes; {} when absent."""
    out = {}
    try:
        with open(path or ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out
