#!/usr/bin/env python3
"""Per-call Claude usage ledger: an OTLP/HTTP (JSON) log receiver into SQLite.

hq-pgbpq.6 (report 2026-10-30, row 7): Claude Code's own OpenTelemetry export
emits one `claude_code.api_request` event per model call with model, cost_usd,
token counts and session.id. Every Claude session on hqbox exports to this
receiver (env in ~/.claude/settings.json, set by install.sh), and spawn.sh tags
worker sessions with hq.session, hq.bead and hq.rig resource attributes. The
weekly review reads the ledger with `otel-ledger.py report`.

  otel-ledger.py serve            listen on 127.0.0.1:4318 (HQ_OTEL_PORT)
  otel-ledger.py report [--days N] [--json]

Only api_request rows are stored, and only the usage fields below: no prompt,
no email, no account ids. Every other event is dropped. A body that is not
OTLP JSON gets a 400 and changes nothing, so a bad client cannot poison the
ledger. Claude Code does not wait on this receiver: with it down, sessions run
the same and only the rows are lost (checked on 2.1.311).
"""
import argparse
import datetime
import gzip
import hashlib
import http.server
import io
import json
import math
import os
import sqlite3
import sys

HQ = os.environ.get("HQ_ROOT", os.path.expanduser("~/hq"))
DB = os.environ.get("HQ_OTEL_DB", os.path.join(HQ, "state/usage/claude-api.sqlite"))
HOST = "127.0.0.1"
PORT = int(os.environ.get("HQ_OTEL_PORT", "4318"))
MAX_BODY = 16 * 1024 * 1024

INTS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
        "cache_creation_5m_tokens", "cache_creation_1h_tokens", "duration_ms", "ttft_ms"]
TEXTS = {"session_id": "session.id", "prompt_id": "prompt.id", "model": "model",
         "query_source": "query_source", "effort": "effort", "speed": "speed",
         "client_version": "service.version", "hq_session": "hq.session",
         "hq_bead": "hq.bead", "hq_rig": "hq.rig"}
COLS = ["request_key", "ts", "cost_usd"] + INTS + list(TEXTS) + ["received_at"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_request (
  request_key TEXT PRIMARY KEY, ts TEXT NOT NULL, cost_usd REAL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER, cache_creation_5m_tokens INTEGER,
  cache_creation_1h_tokens INTEGER, duration_ms INTEGER, ttft_ms INTEGER,
  session_id TEXT, prompt_id TEXT, model TEXT, query_source TEXT, effort TEXT,
  speed TEXT, client_version TEXT, hq_session TEXT, hq_bead TEXT, hq_rig TEXT,
  received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS api_request_ts ON api_request(ts);
CREATE INDEX IF NOT EXISTS api_request_session ON api_request(session_id);
CREATE INDEX IF NOT EXISTS api_request_bead ON api_request(hq_bead);
"""


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def connect(path=DB):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


def value(v):
    """One OTLP AnyValue to a Python scalar; anything else is None."""
    if not isinstance(v, dict):
        return None
    for k in ("stringValue", "boolValue", "doubleValue"):
        if k in v:
            return v[k]
    if "intValue" in v:   # int64 arrives as a JSON number or a decimal string
        try:
            return int(v["intValue"])
        except (TypeError, ValueError):
            return None
    return None


def attrs(lst):
    out = {}
    for a in lst if isinstance(lst, list) else []:
        if isinstance(a, dict) and isinstance(a.get("key"), str):
            out[a["key"]] = value(a.get("value"))
    return out


def count(x):
    if isinstance(x, bool) or not isinstance(x, (int, float, str)):
        return None
    try:
        n = float(x)
    except ValueError:
        return None
    return int(n) if math.isfinite(n) and 0 <= n < 1e15 else None


def money(x):
    if isinstance(x, bool) or not isinstance(x, (int, float, str)):
        return None
    try:
        n = float(x)
    except ValueError:
        return None
    return n if math.isfinite(n) and 0 <= n < 1e6 else None


def text(x):
    return x[:200] if isinstance(x, str) and x else None


def ts_of(rec, a):
    t = a.get("event.timestamp")
    if isinstance(t, str) and len(t) <= 40:
        try:   # stored only in the ISO form the report's since-filter compares as text
            datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
            if t.endswith("Z") and t[4:5] == "-" and t[10:11] == "T":
                return t
        except ValueError:
            pass
    try:
        ns = int(rec.get("timeUnixNano") or 0)
    except (TypeError, ValueError):
        ns = 0
    if ns > 0:
        try:
            return datetime.datetime.fromtimestamp(ns / 1e9, datetime.timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        except (OverflowError, ValueError, OSError):
            pass   # an out-of-range stamp falls back to receipt time (review note)
    return now_iso()


def rows(payload):
    """api_request rows from one OTLP ExportLogsServiceRequest (JSON form)."""
    out = []
    for rl in payload.get("resourceLogs") or []:
        if not isinstance(rl, dict):
            continue
        res = attrs((rl.get("resource") or {}).get("attributes"))
        for sl in rl.get("scopeLogs") or []:
            for rec in (sl.get("logRecords") or []) if isinstance(sl, dict) else []:
                if not isinstance(rec, dict):
                    continue
                a = dict(res)
                a.update(attrs(rec.get("attributes")))
                body = value(rec.get("body"))
                if a.get("event.name") != "api_request" and body != "claude_code.api_request":
                    continue
                r = {"ts": ts_of(rec, a), "cost_usd": money(a.get("cost_usd")), "received_at": now_iso()}
                for k in INTS:
                    r[k] = count(a.get(k))
                for col, key in TEXTS.items():
                    r[col] = text(a.get(key))
                key = text(a.get("request_id")) or text(a.get("client_request_id"))
                if not key:
                    key = "h:" + hashlib.sha256(json.dumps(
                        [r["session_id"], r["ts"], r["model"], a.get("event.sequence")]).encode()).hexdigest()[:32]
                r["request_key"] = key
                out.append(r)
    return out


def store(con, rs):
    """Insert rows; an exporter retry of the same request is a no-op."""
    sql = "INSERT OR IGNORE INTO api_request (%s) VALUES (%s)" % (",".join(COLS), ",".join("?" * len(COLS)))
    with con:
        cur = con.executemany(sql, [[r[c] for c in COLS] for r in rs])
    return cur.rowcount


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "hq-otel-ledger"

    def reply(self, code, body=b"{}"):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.reply(400)
        if n <= 0 or n > MAX_BODY:
            return self.reply(413 if n > MAX_BODY else 400)
        raw = self.rfile.read(n)
        if self.path.split("?")[0] != "/v1/logs":
            return self.reply(200)   # metrics or traces: accepted and dropped
        try:
            if (self.headers.get("Content-Encoding") or "").lower() == "gzip":
                with gzip.GzipFile(fileobj=io.BytesIO(raw)) as g:
                    raw = g.read(MAX_BODY * 4 + 1)
                if len(raw) > MAX_BODY * 4:
                    return self.reply(413)
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("not an object")
            rs = rows(payload)
        except (ValueError, TypeError, AttributeError, OSError, EOFError, RecursionError):
            return self.reply(400, b'{"error":"not OTLP JSON"}')
        try:
            if rs:
                con = connect()
                try:
                    store(con, rs)
                finally:
                    con.close()
        except sqlite3.Error as e:
            print("otel-ledger: store failed: %s" % e, file=sys.stderr, flush=True)
            return self.reply(503)
        self.reply(200)

    def log_message(self, *a):
        pass


def serve():
    connect().close()   # create the schema before the first request
    srv = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("otel-ledger: listening on %s:%d, db %s" % (HOST, PORT, DB), flush=True)
    srv.serve_forever()


def report(days, as_json):
    con = connect()
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    q = lambda sql: [dict(zip([d[0] for d in c.description], r)) for c in [con.execute(sql, (since,))] for r in c.fetchall()]
    sums = ("COUNT(*) AS calls, ROUND(COALESCE(SUM(cost_usd),0),4) AS cost_usd, "
            "COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, "
            "COALESCE(SUM(cache_read_tokens),0) AS cache_read, COALESCE(SUM(cache_creation_tokens),0) AS cache_write")
    out = {
        "since": since + "Z", "days": days,
        "total": q("SELECT %s FROM api_request WHERE ts >= ?" % sums)[0],
        "by_model": q("SELECT model, %s FROM api_request WHERE ts >= ? GROUP BY model ORDER BY 3 DESC" % sums),
        "by_bead": q("SELECT COALESCE(hq_bead,'(none)') AS bead, COALESCE(hq_rig,'') AS rig, %s FROM api_request "
                     "WHERE ts >= ? GROUP BY 1,2 ORDER BY 4 DESC LIMIT 20" % sums),
        "by_session": q("SELECT session_id, COALESCE(hq_session,'') AS hq_session, MIN(ts) AS first, %s "
                        "FROM api_request WHERE ts >= ? GROUP BY 1,2 ORDER BY 5 DESC LIMIT 20" % sums),
    }
    if as_json:
        print(json.dumps(out, indent=1))
        return
    t = out["total"]
    print("Claude usage since %s: %d calls, $%.2f" % (out["since"], t["calls"], t["cost_usd"]))
    for title, key, label in (("By model", "by_model", lambda r: r["model"] or "?"),
                              ("By bead (top 20)", "by_bead", lambda r: "%s %s" % (r["bead"], r["rig"])),
                              ("By session (top 20)", "by_session",
                               lambda r: "%s %s" % ((r["session_id"] or "?")[:8], r["hq_session"]))):
        print("\n" + title)
        for r in out[key]:
            print("  %-34s %6d calls  $%9.4f  in %d out %d cache_read %d cache_write %d" % (
                label(r)[:34], r["calls"], r["cost_usd"], r["input"], r["output"], r["cache_read"], r["cache_write"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    rp = sub.add_parser("report")
    rp.add_argument("--days", type=int, default=7)
    rp.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.cmd == "serve":
        serve()
    else:
        report(args.days, args.json)


if __name__ == "__main__":
    main()
