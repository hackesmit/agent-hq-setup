"""State paths and private atomic writes.

Every file this package writes holds mail text, so the directory is 0700,
files are 0600 from creation (umask, not a chmod after the fact) and
final outputs land by rename so a crash never leaves a partial file.
"""

import json
import os
import tempfile
from pathlib import Path

HQ = Path(os.environ.get("HQ_DIR", str(Path.home() / "hq")))
STATE = Path(os.environ.get("VOICE_STATE", str(HQ / "state" / "voice")))

PERSONAL = "personal"
WORK = "work"
ACCOUNTS = {PERSONAL: "owner@example.com", WORK: "owner@example.com"}


def state_dir(*parts):
    d = STATE.joinpath(*parts)
    old = os.umask(0o077)
    try:
        d.mkdir(parents=True, exist_ok=True)
    finally:
        os.umask(old)
    for p in [STATE, *[STATE.joinpath(*parts[:i + 1]) for i in range(len(parts))]]:
        os.chmod(p, 0o700)
    return d


def write_private(path, data):
    """Write text or bytes to path atomically, mode 0600."""
    path = Path(path)
    state_dir() if path.parent == STATE else path.parent.mkdir(parents=True, exist_ok=True)
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


def write_jsonl(path, rows):
    return write_private(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
