"""Read Wispr Flow's local history (flow.sqlite) read-only. Never writes.

Flow keeps every dictation in %APPDATA%\\Wispr Flow\\flow.sqlite (WAL mode), table
History: transcriptEntityId, timestamp, status (raw_transcript, then formatted),
asrText, formattedText, editedText, and more. The listener pins the first row
written after its chime (the dictation its hotkey started) and from then on reads
only that row by its transcriptEntityId, so a later dictation never replaces it. The db is opened with mode=ro (never immutable: that
would skip the WAL, where the newest rows live) and a locked or busy db is
retried. Transcript text is returned to the caller only; nothing here logs it.
"""
from __future__ import annotations

import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote

FLOW_DB = Path(os.environ.get("APPDATA", "")) / "Wispr Flow" / "flow.sqlite"
COLUMNS = ("transcriptEntityId", "timestamp", "status", "asrText", "formattedText", "editedText")
RECENT = 20  # rows looked at per read: the newest ones by insertion order


def parse_ts(v) -> Optional[float]:
    """Epoch seconds from Flow's timestamp: epoch s or ms, or an ISO or Sequelize
    date string ("2026-11-04 08:42:01.123 +00:00"). A string with no zone is UTC.
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) / 1000.0 if v > 1e11 else float(v)
    s = str(v).strip()
    if not s:
        return None
    try:
        return parse_ts(float(s))
    except ValueError:
        pass
    s = s.replace(" +", "+").replace(" -", "-").replace("Z", "+00:00")
    if len(s) > 10 and s[10] == " ":
        s = s[:10] + "T" + s[11:]
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def _connect(path: Path) -> sqlite3.Connection:
    uri = "file:" + quote(str(path).replace("\\", "/")) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=1.0)
    con.row_factory = sqlite3.Row
    return con


def _rows(sql: str, params: tuple, path: Path, tries: int, sleep: Callable[[float], None]) -> Optional[list]:
    """The rows of one read-only query, or None when the db stays locked or missing.

    A locked or busy db, or one Flow is creating, is retried `tries` times.
    """
    for attempt in range(tries):
        try:
            con = _connect(path)
            try:
                return [dict(r) for r in con.execute(sql, params).fetchall()]
            finally:
                con.close()
        except sqlite3.OperationalError:
            if attempt + 1 < tries:
                sleep(0.2)
    return None


def _after(t0: float, rows: Optional[list]) -> list:
    """The rows stamped after t0, oldest first."""
    out = [(parse_ts(r.get("timestamp")), r) for r in rows or []]
    return [r for t, r in sorted((x for x in out if x[0] is not None and x[0] > t0), key=lambda x: x[0])]


_RECENT_SQL = "SELECT {} FROM History ORDER BY rowid DESC LIMIT {}".format(", ".join(COLUMNS), RECENT)


def newest_after(t0: float, path: Path = FLOW_DB, tries: int = 5, sleep: Callable[[float], None] = time.sleep) -> Optional[dict]:
    """The newest History row whose timestamp is after t0 (epoch s), or None (flowcheck)."""
    rows = _after(t0, _rows(_RECENT_SQL, (), path, tries, sleep))
    return rows[-1] if rows else None


def first_after(t0: float, path: Path = FLOW_DB, tries: int = 5, sleep: Callable[[float], None] = time.sleep) -> Optional[dict]:
    """The first History row whose timestamp is after t0 (epoch s), or None: the
    dictation the wake's hotkey started, since Flow runs one dictation at a time."""
    rows = _after(t0, _rows(_RECENT_SQL, (), path, tries, sleep))
    return rows[0] if rows else None


def row_by_id(tid: str, path: Path = FLOW_DB, tries: int = 5, sleep: Callable[[float], None] = time.sleep) -> Optional[dict]:
    """The History row with this transcriptEntityId, or None."""
    sql = "SELECT {} FROM History WHERE transcriptEntityId = ? LIMIT 1".format(", ".join(COLUMNS))
    rows = _rows(sql, (str(tid),), path, tries, sleep)
    return rows[0] if rows else None


def last_rowid(path: Path = FLOW_DB, tries: int = 5, sleep: Callable[[float], None] = time.sleep) -> Optional[int]:
    """Where History ends now (0 when empty), or None when it cannot be read."""
    rows = _rows("SELECT COALESCE(MAX(rowid), 0) AS m FROM History", (), path, tries, sleep)
    return int(rows[0]["m"]) if rows else None


def stopped_since(mark: Optional[int], t0: float, path: Path = FLOW_DB, tries: int = 5, sleep: Callable[[float], None] = time.sleep) -> bool:
    """True when a row written after mark is a dictation that was still recording at t0.

    Flow stamps a row with the time its dictation started and stores its length in
    seconds as duration (George 2026-11-04: timestamp plus duration is the stop
    hotkey's time). A row written after mark that started at or before t0 and ended
    at or after it was already running when the wake's hotkey stopped it. One that
    ended before t0 was stopped by the owner and only written late. A row with no
    duration counts as running. An unreadable History (mark None) answers False.
    """
    if mark is None:
        return False
    rows = _rows("SELECT timestamp, duration FROM History WHERE rowid > ?", (mark,), path, tries, sleep) or []
    for r in rows:
        start = parse_ts(r.get("timestamp"))
        if start is None or start > t0:
            continue
        try:
            length = float(r.get("duration"))
        except (TypeError, ValueError):
            return True
        if start + length >= t0:
            return True
    return False


def pick_text(row: Optional[dict], allow_raw: bool) -> Optional[str]:
    """The text to send from one History row, or None while it is not ready.

    A formatted row gives editedText if present, else formattedText. Before that
    (status raw_transcript), only allow_raw (the 10 s wait ran out) gives asrText.
    """
    if not row:
        return None

    def clean(k):
        v = row.get(k)
        return v.strip() if isinstance(v, str) and v.strip() else None

    if row.get("status") == "formatted":
        return clean("editedText") or clean("formattedText") or clean("asrText")
    return clean("asrText") if allow_raw else None
