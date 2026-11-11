"""flow.sqlite reader against a fixture db shaped like Wispr Flow's (WAL mode, History table)."""
import hashlib
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from capri.flow import first_after, last_rowid, newest_after, parse_ts, pick_text, row_by_id, stopped_since  # noqa: E402

# The real History columns (read from George 2026-11-04), in Flow's order.
COLS = ["transcriptEntityId", "asrText", "formattedText", "editedText", "timestamp", "audio", "screenshot", "additionalContext",
        "status", "app", "url", "e2eLatency", "needsUploading", "duration", "numWords", "shareType", "textboxContents",
        "appVersion", "editedTextStatus", "editedTextAttempts", "toneMatchedText", "toneMatchPairs", "feedback", "language", "isArchived"]


def make_db(path, rows):
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE History ({}, PRIMARY KEY (transcriptEntityId))".format(", ".join(f"{c}" for c in COLS)))
    for r in rows:
        con.execute("INSERT INTO History (transcriptEntityId, asrText, formattedText, editedText, timestamp, status) VALUES (?,?,?,?,?,?)",
                    (r["id"], r.get("asr"), r.get("fmt"), r.get("edit"), r["ts"], r.get("status", "formatted")))
    con.commit()
    return con  # kept open: the newest rows stay in the WAL, as while Flow runs


def test_parse_ts_reads_every_shape_flow_might_store():
    assert parse_ts(1762245721) == 1762245721.0
    assert parse_ts(1762245721123) == 1762245721.123
    assert parse_ts("1762245721123") == 1762245721.123
    assert parse_ts("2025-11-04 08:42:01.123 +00:00") == parse_ts("2025-11-04T08:42:01.123Z")
    assert parse_ts("2025-11-04T08:42:01") == parse_ts("2025-11-04T08:42:01+00:00")
    assert parse_ts("2025-11-04T01:42:01-07:00") == parse_ts("2025-11-04T08:42:01Z")
    for bad in (None, "", "not a date", True):
        assert parse_ts(bad) is None


def test_newest_row_after_t0_from_the_wal(tmp_path):
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [
        {"id": "old", "ts": "2026-11-04 08:42:00.000 +00:00", "fmt": "old"},
        {"id": "new", "ts": "2026-11-04 08:44:30.000 +00:00", "fmt": "new", "status": "raw_transcript"},
        {"id": "mid", "ts": "2026-11-04 08:44:10.000 +00:00", "fmt": "mid"},
    ])
    assert (db.parent / "flow.sqlite-wal").exists(), "fixture keeps rows in the WAL"
    t0 = parse_ts("2026-11-04T08:44:00Z")
    row = newest_after(t0, db)
    assert row["transcriptEntityId"] == "new" and row["status"] == "raw_transcript"
    assert newest_after(parse_ts("2026-11-04T08:45:00Z"), db) is None
    con.close()


def test_reader_never_writes(tmp_path):
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [{"id": "a", "ts": 2000.0, "fmt": "x"}])
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    before = hashlib.sha256(db.read_bytes()).hexdigest()
    assert newest_after(1000.0, db)["transcriptEntityId"] == "a"
    assert hashlib.sha256(db.read_bytes()).hexdigest() == before
    # mode=ro: the same connection settings cannot write
    from capri.flow import _connect
    ro = _connect(db)
    try:
        ro.execute("INSERT INTO History (transcriptEntityId, timestamp) VALUES ('z', 3000)")
        raise AssertionError("a read-only connection wrote")
    except sqlite3.OperationalError as e:
        assert "readonly" in str(e).replace("-", "").replace(" ", "")
    finally:
        ro.close()
    con.close()


def test_a_locked_db_is_retried(tmp_path):
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [{"id": "a", "ts": 2000.0, "fmt": "x"}])
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("BEGIN EXCLUSIVE")  # Flow holds the db
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        if len(sleeps) == 2:
            con.commit()  # Flow lets go

    row = newest_after(1000.0, db, tries=5, sleep=sleep)
    assert row["transcriptEntityId"] == "a" and len(sleeps) == 2
    con.close()


def test_a_db_that_stays_locked_or_is_missing_is_none(tmp_path):
    assert newest_after(0.0, tmp_path / "missing.sqlite", tries=2, sleep=lambda s: None) is None
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [{"id": "a", "ts": 2000.0}])
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("BEGIN EXCLUSIVE")
    assert newest_after(0.0, db, tries=3, sleep=lambda s: None) is None
    con.rollback()
    con.close()


def test_pick_text_rules():
    f = {"status": "formatted", "asrText": "raw", "formattedText": "Fmt.", "editedText": None}
    assert pick_text(f, False) == "Fmt."
    assert pick_text({**f, "editedText": "  Edited. "}, False) == "Edited."
    assert pick_text({**f, "editedText": "   "}, False) == "Fmt."
    raw = {**f, "status": "raw_transcript", "formattedText": None}
    assert pick_text(raw, False) is None
    assert pick_text(raw, True) == "raw"
    assert pick_text(None, True) is None


def test_first_row_after_t0_and_the_row_by_id(tmp_path):
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [
        {"id": "old", "ts": "2026-11-04 08:42:00.000 +00:00", "fmt": "old"},
        {"id": "later", "ts": "2026-11-04 08:44:30.000 +00:00", "fmt": "later"},
        {"id": "wake", "ts": "2026-11-04 08:44:10.000 +00:00", "fmt": None, "status": "raw_transcript"},
    ])
    t0 = parse_ts("2026-11-04T08:44:00Z")
    assert first_after(t0, db)["transcriptEntityId"] == "wake"
    assert first_after(parse_ts("2026-11-04T08:45:00Z"), db) is None
    con.execute("UPDATE History SET status='formatted', formattedText='done' WHERE transcriptEntityId='wake'")
    con.commit()
    r = row_by_id("wake", db)
    assert r["status"] == "formatted" and r["formattedText"] == "done", "the WAL update is seen"
    assert row_by_id("nope", db) is None
    assert row_by_id("x' OR '1'='1", db) is None, "the id is a bound parameter"
    con.close()


def test_a_row_written_after_the_mark_that_ran_through_the_wake_means_flow_was_busy(tmp_path):
    """Flow stamps a row with its start time and stores its length as duration (George
    2026-11-04). A row written after the wake that started before it and was still
    recording at it was stopped by the wake's hotkey (hq-ymxzt.10, lucy r3 finding 4)."""
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [{"id": "a", "ts": "2026-11-04 08:40:00.000 +00:00", "fmt": "a"}])
    mark = last_rowid(db)
    assert mark == 1
    wake = parse_ts("2026-11-04 08:42:00.000 +00:00")
    add = "INSERT INTO History (transcriptEntityId, timestamp, duration, status) VALUES (?, ?, ?, 'raw_transcript')"
    assert stopped_since(mark, wake, db) is False
    con.execute(add, ("ours", "2026-11-04 08:42:00.800 +00:00", 4.0))
    con.commit()
    assert stopped_since(mark, wake, db) is False, "this wake's own row is not a busy Flow"
    con.execute(add, ("late", "2026-11-04 08:41:50.000 +00:00", 8.5))
    con.commit()
    assert stopped_since(mark, wake, db) is False, "the owner stopped it 1.5 s before the wake; Flow wrote it late"
    con.execute(add, ("owners", "2026-11-04 08:41:30.000 +00:00", 30.4))
    con.commit()
    assert stopped_since(mark, wake, db) is True


def test_a_row_with_no_duration_counts_as_running(tmp_path):
    db = tmp_path / "flow.sqlite"
    con = make_db(db, [])
    mark = last_rowid(db)
    assert mark == 0
    con.execute("INSERT INTO History (transcriptEntityId, timestamp) VALUES ('x', '2026-11-04 08:41:30.000 +00:00')")
    con.commit()
    assert stopped_since(mark, parse_ts("2026-11-04 08:42:00.000 +00:00"), db) is True


def test_busy_check_is_false_when_flow_history_cannot_be_read(tmp_path):
    missing = tmp_path / "none.sqlite"
    assert last_rowid(missing, tries=1) is None
    assert stopped_since(None, 0.0, missing, tries=1) is False
