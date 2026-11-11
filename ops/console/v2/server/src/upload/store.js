// Uploads: the durable record. One sqlite row per upload id is the single
// atomic fact about that upload; the manifest and the files on disk are
// derived projections that the boot reconcile rebuilds from this table.
//
// Design: docs/superpowers/specs/2026-08-17-console-v2-design.md section 6.
//
// Schema rules (design section 3, expand-then-contract): a release may only
// ADD tables, columns or indexes with defaults an older release ignores. It
// may never rename, drop, or change the meaning of a column. The version is
// recorded in `schema_version` so a candidate can refuse to open a store
// written by a newer release rather than corrupt it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Bump only for an additive migration; add the ALTERs to MIGRATIONS below. */
export const SCHEMA_VERSION = 1;
export const SCHEMA_COMPONENT = "uploads";

/** Heartbeat cadence and the age at which an in-progress row is abandoned. */
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_STALE_MS = 60_000;

export class SchemaTooNew extends Error {
  constructor(found, understood) {
    super(`uploads schema version ${found} is newer than this release understands (${understood})`);
    this.found = found;
    this.understood = understood;
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  component TEXT PRIMARY KEY,
  version   INTEGER NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  state        TEXT NOT NULL,
  name         TEXT,
  declaredSize INTEGER NOT NULL,
  declaredSha  TEXT NOT NULL,
  size         INTEGER,
  sha256       TEXT,
  path         TEXT,
  day          TEXT,
  tmpUuid      TEXT,
  note         TEXT,
  keep         INTEGER NOT NULL DEFAULT 0,
  startedAt    TEXT NOT NULL,
  committedAt  TEXT,
  deletedAt    TEXT,
  heartbeat    INTEGER NOT NULL DEFAULT 0,
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS uploads_day   ON uploads(day);
CREATE INDEX IF NOT EXISTS uploads_state ON uploads(state);
CREATE INDEX IF NOT EXISTS uploads_path  ON uploads(path);
`;

/**
 * Additive migrations keyed by the version they produce. Each entry is a list
 * of statements that must be safe to run on a store already at that version
 * (IF NOT EXISTS / a column-presence check), because a rollback and a
 * re-upgrade will run them again.
 * @type {Record<number, string[]>}
 */
const MIGRATIONS = {};

export const UploadState = Object.freeze({
  inProgress: "in-progress",
  committed: "committed",
  deleted: "deleted",
  failed: "failed",
});

/** Rows come back null-prototype from node:sqlite; make them plain objects. */
function plain(row) {
  return row ? { ...row } : null;
}

export class UploadStore {
  /**
   * @param {string} file absolute path to uploads.sqlite
   * @param {{now?: () => number, readOnly?: boolean}} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.now = opts.now || (() => Date.now());
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    this.db = new DatabaseSync(file);
    // WAL for concurrent readers, FULL so a COMMIT is an fsync: the row is the
    // single atomic record and must survive power loss (design section 6).
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      this.#migrate();
    } catch (e) {
      // A store this release cannot understand must not be left open.
      this.close();
      throw e;
    }
  }

  #migrate() {
    this.db.exec(DDL);
    const cur = this.version();
    if (cur > SCHEMA_VERSION) throw new SchemaTooNew(cur, SCHEMA_VERSION);
    for (let v = cur + 1; v <= SCHEMA_VERSION; v++) {
      for (const stmt of MIGRATIONS[v] || []) this.db.exec(stmt);
    }
    if (cur !== SCHEMA_VERSION) {
      this.db
        .prepare("INSERT INTO schema_version(component, version, updatedAt) VALUES(?, ?, ?)" +
          " ON CONFLICT(component) DO UPDATE SET version = excluded.version, updatedAt = excluded.updatedAt")
        .run(SCHEMA_COMPONENT, SCHEMA_VERSION, new Date(this.now()).toISOString());
    }
  }

  /** 0 when the table has never been stamped (first boot). */
  version() {
    const row = this.db.prepare("SELECT version FROM schema_version WHERE component = ?").get(SCHEMA_COMPONENT);
    return row ? Number(row.version) : 0;
  }

  /** IMMEDIATE so a second writer blocks instead of upgrading mid-read. */
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      throw e;
    }
  }

  get(id) {
    return plain(this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id));
  }

  byPath(p) {
    return plain(this.db.prepare("SELECT * FROM uploads WHERE path = ? AND state = ?").get(p, UploadState.committed));
  }

  /**
   * The idempotency gate. One transaction decides the fate of an upload id:
   * a committed row answers a retry without bytes (or rejects a different
   * body), a deleted row is gone forever, a live in-progress row is busy, and
   * anything else (absent, failed, or an in-progress row whose heartbeat has
   * gone stale) is claimed for this request.
   *
   * @param {{id: string, declaredSize: number, declaredSha: string, note?: string|null, staleMs?: number}} req
   * @returns {{outcome: "existing"|"mismatch"|"gone"|"busy"|"claimed", row: any, abandoned?: any}}
   */
  claim(req) {
    const nowMs = this.now();
    const staleMs = req.staleMs == null ? HEARTBEAT_STALE_MS : req.staleMs;
    return this.tx(() => {
      const prev = plain(this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(req.id));
      if (prev) {
        if (prev.state === UploadState.committed) {
          const same = Number(prev.declaredSize) === req.declaredSize && prev.declaredSha === req.declaredSha;
          return { outcome: same ? "existing" : "mismatch", row: prev };
        }
        if (prev.state === UploadState.deleted) return { outcome: "gone", row: prev };
        if (prev.state === UploadState.inProgress && nowMs - Number(prev.heartbeat || 0) <= staleMs) {
          return { outcome: "busy", row: prev };
        }
      }
      // Claim: fresh temp name, in-progress row written before any byte is read.
      const tmpUuid = crypto.randomUUID();
      const startedAt = new Date(nowMs).toISOString();
      if (prev) {
        this.db
          .prepare(
            "UPDATE uploads SET state = ?, declaredSize = ?, declaredSha = ?, note = ?, tmpUuid = ?," +
              " startedAt = ?, heartbeat = ?, size = NULL, sha256 = NULL, path = NULL, day = NULL," +
              " committedAt = NULL, deletedAt = NULL, reason = NULL WHERE id = ?",
          )
          .run(
            UploadState.inProgress,
            req.declaredSize,
            req.declaredSha,
            req.note == null ? null : String(req.note),
            tmpUuid,
            startedAt,
            nowMs,
            req.id,
          );
      } else {
        this.db
          .prepare(
            "INSERT INTO uploads(id, state, declaredSize, declaredSha, note, tmpUuid, startedAt, heartbeat)" +
              " VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            req.id,
            UploadState.inProgress,
            req.declaredSize,
            req.declaredSha,
            req.note == null ? null : String(req.note),
            tmpUuid,
            startedAt,
            nowMs,
          );
      }
      const row = plain(this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(req.id));
      return { outcome: "claimed", row, abandoned: prev && prev.state === UploadState.inProgress ? prev : null };
    });
  }

  heartbeat(id, atMs) {
    this.db
      .prepare("UPDATE uploads SET heartbeat = ? WHERE id = ? AND state = ?")
      .run(atMs == null ? this.now() : atMs, id, UploadState.inProgress);
  }

  /**
   * The commit: one transaction flips the row to committed with its final
   * identity. Called only after the file is linked and its directory fsynced.
   * @param {{id: string, name: string, path: string, day: string, size: number, sha256: string, committedAt: string}} rec
   */
  commit(rec) {
    return this.tx(() => {
      const res = this.db
        .prepare(
          "UPDATE uploads SET state = ?, name = ?, path = ?, day = ?, size = ?, sha256 = ?, committedAt = ?," +
            " heartbeat = ?, reason = NULL WHERE id = ? AND state = ?",
        )
        .run(
          UploadState.committed,
          rec.name,
          rec.path,
          rec.day,
          rec.size,
          rec.sha256,
          rec.committedAt,
          this.now(),
          rec.id,
          UploadState.inProgress,
        );
      if (res.changes !== 1) throw new Error(`upload ${rec.id} was not in progress at commit`);
      return plain(this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(rec.id));
    });
  }

  /** A failed attempt keeps the id (audit) but stays retryable. */
  fail(id, reason) {
    this.db
      .prepare("UPDATE uploads SET state = ?, reason = ?, tmpUuid = NULL WHERE id = ? AND state = ?")
      .run(UploadState.failed, reason == null ? null : String(reason).slice(0, 500), id, UploadState.inProgress);
    return this.get(id);
  }

  /** Bytes are gone; the id answers every later retry with "gone". */
  markDeleted(id, reason) {
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare("UPDATE uploads SET state = ?, deletedAt = ?, reason = ?, keep = 0 WHERE id = ?")
      .run(UploadState.deleted, at, reason == null ? null : String(reason), id);
    return this.get(id);
  }

  setKeep(id, keep) {
    const res = this.db
      .prepare("UPDATE uploads SET keep = ? WHERE id = ? AND state = ?")
      .run(keep ? 1 : 0, id, UploadState.committed);
    return res.changes === 1 ? this.get(id) : null;
  }

  /** Live bytes only: the quota counts what is actually on disk. */
  liveBytes() {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM uploads WHERE state = ?")
      .get(UploadState.committed);
    return Number(row ? row.total : 0);
  }

  listDay(day) {
    return this.db
      .prepare("SELECT * FROM uploads WHERE state = ? AND day = ? ORDER BY committedAt ASC")
      .all(UploadState.committed, day)
      .map(plain);
  }

  listCommitted() {
    return this.db
      .prepare("SELECT * FROM uploads WHERE state = ? ORDER BY committedAt ASC")
      .all(UploadState.committed)
      .map(plain);
  }

  listInProgress() {
    return this.db.prepare("SELECT * FROM uploads WHERE state = ?").all(UploadState.inProgress).map(plain);
  }

  /** Committed, unpinned rows whose retention window closed before `cutoffIso`. */
  listExpired(cutoffIso) {
    return this.db
      .prepare("SELECT * FROM uploads WHERE state = ? AND keep = 0 AND committedAt IS NOT NULL AND committedAt < ?")
      .all(UploadState.committed, cutoffIso)
      .map(plain);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
