// Uploads: the POST /api/upload request handler.
//
// One file per request (design section 6), so the atomic record is one sqlite
// row per file. The request carries three headers: X-Upload-Id (the client's
// idempotency key), X-Upload-Size and X-Upload-Sha256 (computed in the browser
// over file.stream() before the upload starts). The body is multipart with a
// single "file" part.
//
// Ordering, which is what makes every crash window safe:
//   1. claim the id in sqlite (row: in-progress) BEFORE any byte is accepted
//   2. reserve the full per-file maximum against quota and free space
//   3. stream to inbox/.tmp/<uuid>, hashing and counting as bytes arrive
//   4. verify size and hash against the declared values
//   5. recheck the quota with the real size, under the same lock
//   6. fsync the temp file, write and fsync the sidecar naming the intended
//      final path, link() with no-replace semantics, fsync the day directory
//   7. flip the row to committed in ONE sqlite transaction
//   8. append the manifest line, remove the sidecar, unlink the temp name
//
// A crash between 6 and 7 leaves a linked file, an in-progress row and a
// sidecar: boot re-verifies and commits it. A crash between 7 and 8 leaves a
// committed row: boot regenerates the manifest line. A row commit that FAILS
// while the server is up unlinks the file immediately, releases the
// reservation only after that cleanup, and pins an alert.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Busboy from "busboy";

import { UploadState, HEARTBEAT_MS } from "./store.js";
import {
  DIR_MODE,
  FILE_MODE,
  appendManifest,
  dayOf,
  fsyncDir,
  fsyncFile,
  manifestRecord,
  sanitiseName,
  suffixName,
  unlinkSafe,
  writeJsonFsync,
} from "./paths.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_COLLISION_SUFFIX = 999;

export class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers || null;
  }
}

/** Thrown by a fault-injection hook to simulate the process dying mid-commit. */
export class UploadCrash extends Error {
  constructor(where) {
    super(`simulated crash at ${where}`);
    this.where = where;
  }
}

export function sendJson(res, code, body, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

/**
 * Answer without reading the request body. Used for every pre-stream verdict
 * (retry of a committed id, mismatch, gone, busy, quota) so a 200 GB body is
 * never pulled off the wire to be discarded. The socket is closed after the
 * response flushes because an unread body cannot be followed by another
 * request on the same connection.
 */
export function refuse(req, res, code, body, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    connection: "close",
    ...(extraHeaders || {}),
  });
  res.end(payload, () => {
    try {
      req.destroy();
    } catch {
      /* the socket is already gone */
    }
  });
}

/** @param {import("node:http").IncomingHttpHeaders} h */
export function parseHeaders(h, limits) {
  const id = String(h["x-upload-id"] || "").trim();
  if (!ID_RE.test(id)) throw new HttpError(400, "missing or malformed X-Upload-Id");
  const rawSize = String(h["x-upload-size"] || "").trim();
  if (!/^[0-9]{1,19}$/.test(rawSize)) throw new HttpError(400, "missing or malformed X-Upload-Size");
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, "X-Upload-Size must be a positive integer");
  if (size > limits.maxFile) {
    throw new HttpError(413, `file too large: ${size} bytes, limit ${limits.maxFile}`);
  }
  const sha = String(h["x-upload-sha256"] || "").trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new HttpError(400, "missing or malformed X-Upload-Sha256");
  const ct = String(h["content-type"] || "");
  if (!/^multipart\/form-data/i.test(ct)) throw new HttpError(400, "expected multipart/form-data");
  const note = h["x-upload-note"] ? String(h["x-upload-note"]).slice(0, 500) : null;
  return { id, size, sha, note };
}

/**
 * Stream the single file part to `tmpPath`, hashing and counting as it goes.
 * Aborts the moment the declared size is exceeded (413), which is also the
 * reservation bound because the reservation is the per-file maximum and the
 * declared size can never exceed it (checked in parseHeaders).
 */
function streamToTemp(req, tmpPath, declaredSize, stats) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 8, fileSize: declaredSize + 1 } });
    } catch (e) {
      reject(new HttpError(400, `bad multipart request: ${e && e.message}`));
      return;
    }
    let settled = false;
    let sawFile = false;
    let parsed = false;
    let written = false;
    let bytes = 0;
    let filename = "file";
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(tmpPath, { flags: "wx", mode: FILE_MODE });

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        req.unpipe(bb);
      } catch {
        /* ignore */
      }
      // Reject only once the temp stream has really closed. fs.createWriteStream
      // opens its fd asynchronously: when a failure lands in the same tick as the
      // request body (a second file part in one packet), destroy() leaves the open
      // pending, the caller unlinks the temp path first, and the open then creates
      // an orphan temp file. Waiting for close puts the caller's unlink after it.
      if (out.closed) {
        reject(err);
        return;
      }
      out.once("close", () => reject(err));
      try {
        out.destroy();
      } catch {
        reject(err);
      }
    };
    const maybeDone = () => {
      if (settled || !parsed || !written) return;
      settled = true;
      resolve({ bytes, sha256: hash.digest("hex"), filename });
    };

    out.on("error", (e) => fail(new HttpError(500, `temp write failed: ${e && e.message}`)));
    out.on("close", () => {
      written = true;
      maybeDone();
    });

    bb.on("file", (field, stream, info) => {
      if (sawFile) {
        stream.resume();
        return;
      }
      sawFile = true;
      filename = (info && info.filename) || "file";
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        stats.bytesRead += chunk.length;
        if (bytes > declaredSize) {
          stream.unpipe(out);
          fail(new HttpError(413, `declared size ${declaredSize} exceeded`));
          return;
        }
        hash.update(chunk);
      });
      stream.on("limit", () => fail(new HttpError(413, `declared size ${declaredSize} exceeded`)));
      stream.on("error", (e) => fail(new HttpError(400, `upload stream error: ${e && e.message}`)));
      stream.pipe(out);
    });
    bb.on("filesLimit", () => fail(new HttpError(400, "exactly one file per request")));
    bb.on("error", (e) => fail(new HttpError(400, `multipart parse error: ${e && e.message}`)));
    bb.on("close", () => {
      if (!sawFile) {
        fail(new HttpError(400, "no file part in the request"));
        return;
      }
      parsed = true;
      maybeDone();
    });
    req.on("aborted", () => fail(new HttpError(499, "client aborted the upload")));
    req.on("error", (e) => fail(new HttpError(400, `request error: ${e && e.message}`)));
    req.pipe(bb);
  });
}

/**
 * Sidecar, then link, with no-replace semantics. The sidecar must name the
 * final path BEFORE the link exists, so on a collision it is rewritten for the
 * next candidate and the link retried: an orphaned final file is therefore
 * always matched to a sidecar by the recorded path.
 * @returns {{finalPath: string, name: string, day: string}}
 */
function sidecarThenLink(ctx, row, tmpPath, rawName, result, nowMs) {
  const day = dayOf(nowMs);
  const dir = path.join(ctx.paths.filesDir, day);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const base = sanitiseName(rawName);
  const sidecar = ctx.paths.sidecar(row.tmpUuid);
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n++) {
    const name = suffixName(base, n);
    const finalPath = path.join(dir, name);
    writeJsonFsync(sidecar, {
      uploadId: row.id,
      uuid: row.tmpUuid,
      finalPath,
      name,
      day,
      ts: new Date(nowMs).toISOString(),
      size: result.bytes,
      sha256: result.sha256,
      note: row.note == null ? null : row.note,
    });
    fsyncDir(ctx.paths.tmpDir);
    if (ctx.faults.afterSidecar) ctx.faults.afterSidecar({ row, finalPath });
    try {
      fs.linkSync(tmpPath, finalPath);
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw new HttpError(500, `link failed: ${e && e.message}`);
    }
    fsyncDir(dir);
    return { finalPath, name, day };
  }
  throw new HttpError(500, `too many name collisions for ${base}`);
}

/**
 * @param {{store: any, admission: any, paths: any, limits: any, alerts: any,
 *          log: Function, now: () => number, faults: any, stats: any}} ctx
 */
export function createHandler(ctx) {
  return async function handle(req, res) {
    let decl = null;
    try {
      decl = parseHeaders(req.headers, ctx.limits);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(400, String(e && e.message));
      return refuse(req, res, err.status, { error: err.message }, err.headers);
    }

    // 1. The idempotency gate: one sqlite transaction decides, before bytes.
    const gate = ctx.store.claim({
      id: decl.id,
      declaredSize: decl.size,
      declaredSha: decl.sha,
      note: decl.note,
      staleMs: ctx.limits.heartbeatStaleMs,
    });
    if (gate.outcome === "existing") {
      ctx.stats.dedupes++;
      return refuse(req, res, 200, resultOf(gate.row, true));
    }
    if (gate.outcome === "mismatch") {
      return refuse(req, res, 409, { error: "upload id already used with different content" });
    }
    if (gate.outcome === "gone") {
      return refuse(req, res, 410, { error: "upload was deleted" });
    }
    if (gate.outcome === "busy") {
      return refuse(req, res, 409, { error: "upload already in progress" }, { "retry-after": "5" });
    }
    // A stale in-progress row was taken over: its temp bytes are ours to drop.
    if (gate.abandoned && gate.abandoned.tmpUuid) {
      unlinkSafe(ctx.paths.tmpFile(gate.abandoned.tmpUuid));
      unlinkSafe(ctx.paths.sidecar(gate.abandoned.tmpUuid));
    }

    const row = gate.row;
    const tmpPath = ctx.paths.tmpFile(row.tmpUuid);

    // 2. Reserve the full per-file maximum before a single byte is accepted.
    const admitted = ctx.admission.acquire();
    if (!admitted.ok) {
      ctx.store.fail(row.id, admitted.error);
      return refuse(req, res, admitted.status, { error: admitted.error }, admitted.headers);
    }
    const grant = admitted.grant;

    let crashed = false;
    let linked = null;
    let committedRow = null;
    const hb = setInterval(() => {
      try {
        ctx.store.heartbeat(row.id, ctx.now());
      } catch {
        /* a missed heartbeat only risks an abandon after 60 s */
      }
    }, ctx.limits.heartbeatMs || HEARTBEAT_MS);
    if (typeof hb.unref === "function") hb.unref();

    try {
      // 3. Stream, hash and count.
      const result = await streamToTemp(req, tmpPath, decl.size, ctx.stats);

      // 4. The client's own declaration is the contract it must meet.
      if (result.bytes !== decl.size) {
        throw new HttpError(400, `size mismatch: declared ${decl.size}, received ${result.bytes}`);
      }
      if (result.sha256 !== decl.sha) {
        throw new HttpError(400, "sha256 mismatch: the uploaded bytes are not what was declared");
      }

      // 5. Recheck the quota with the real size, under the same lock.
      const recheck = ctx.admission.recheck(grant, result.bytes);
      if (!recheck.ok) throw new HttpError(recheck.status, recheck.error);

      // 6. Durability: temp fsync, sidecar, no-replace link, dir fsync.
      fsyncFile(tmpPath);
      const nowMs = ctx.now();
      const placed = sidecarThenLink(ctx, row, tmpPath, result.filename, result, nowMs);
      linked = placed.finalPath;
      if (ctx.faults.afterLink) ctx.faults.afterLink({ row, finalPath: linked });

      // 7. The row is the single atomic record.
      const committedAt = new Date(nowMs).toISOString();
      try {
        if (ctx.faults.rowCommit) ctx.faults.rowCommit({ row, finalPath: linked });
        committedRow = ctx.store.commit({
          id: row.id,
          name: placed.name,
          path: linked,
          day: placed.day,
          size: result.bytes,
          sha256: result.sha256,
          committedAt,
        });
      } catch (e) {
        if (e instanceof UploadCrash) throw e;
        // The file must not outlive a failed row: committed quota can never
        // disagree with the disk. Unlink first, release the reservation after
        // the cleanup, pin a card.
        unlinkSafe(linked);
        linked = null;
        unlinkSafe(ctx.paths.sidecar(row.tmpUuid));
        unlinkSafe(tmpPath);
        ctx.store.fail(row.id, `row commit failed: ${e && e.message}`);
        if (ctx.alerts) {
          ctx.alerts.add({
            id: `upload-commit-${row.id}`,
            severity: "P1",
            title: "Upload record could not be written",
            detail: `${placed.name}: ${e && e.message}. The file was removed; the client was told the upload failed.`,
            source: "uploads",
          });
        }
        throw new HttpError(500, `upload record could not be written: ${e && e.message}`);
      }
      if (ctx.faults.afterRowCommit) ctx.faults.afterRowCommit({ row, finalPath: linked });

      // 8. Derived projections last.
      try {
        appendManifest(ctx.paths.manifest, manifestRecord(committedRow));
      } catch (e) {
        ctx.log(`manifest append failed for ${row.id}: ${e && e.message} (boot will rebuild it)`);
      }
      unlinkSafe(ctx.paths.sidecar(row.tmpUuid));
      unlinkSafe(tmpPath);
      ctx.stats.committed++;
      return sendJson(res, 201, resultOf(committedRow, false));
    } catch (e) {
      if (e instanceof UploadCrash) {
        // A real crash leaves everything exactly where it is; the only thing
        // this simulation may do is stop talking.
        crashed = true;
        try {
          req.destroy();
          res.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      const err = e instanceof HttpError ? e : new HttpError(500, String((e && e.message) || "upload failed"));
      if (linked) unlinkSafe(linked);
      unlinkSafe(ctx.paths.sidecar(row.tmpUuid));
      unlinkSafe(tmpPath);
      if (ctx.store.get(row.id) && ctx.store.get(row.id).state === UploadState.inProgress) {
        ctx.store.fail(row.id, err.message);
      }
      ctx.stats.failed++;
      if (err.status === 499) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      return refuse(req, res, err.status, { error: err.message }, err.headers);
    } finally {
      clearInterval(hb);
      // In production a crash frees the reservation by ending the process; in
      // a simulated crash the object would leak, so it is released either way.
      ctx.admission.release(grant);
      if (crashed) ctx.stats.crashed++;
    }
  };
}

/** @returns {import("../../../shared/api.js").UploadResult} */
export function resultOf(row, duplicate) {
  const out = {
    id: row.id,
    path: row.path,
    size: Number(row.size),
    sha256: row.sha256,
    committedAt: row.committedAt,
  };
  if (duplicate) out.duplicateOf = row.id;
  return out;
}
