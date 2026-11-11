// Uploads: the module the server mounts.
//
//   const uploads = createUploads({ cfg, alerts, log });
//   uploads.boot();                       // reconcile + retention sweep, real start only
//   POST /api/upload            -> uploads.handle(req, res)   (BEFORE any body read)
//   GET  /api/uploads?date=...  -> uploads.list(date)
//   POST /api/uploads/:id/keep  -> uploads.setKeep(id, body.keep)
//   POST /api/uploads/:id/delete-> uploads.remove(id)
//   uploads.close()                       // on shutdown
//
// Design: docs/superpowers/specs/2026-08-17-console-v2-design.md section 6.

import fs from "node:fs";
import path from "node:path";

import { Admission, realStatfs } from "./admission.js";
import { createHandler, HttpError, UploadCrash } from "./handler.js";
import { createReconcile } from "./reconcile.js";
import { createRetention } from "./retention.js";
import { HEARTBEAT_MS, HEARTBEAT_STALE_MS, SCHEMA_VERSION, UploadState, UploadStore } from "./store.js";
import { dayOf, ensureTree, inboxPaths, sanitiseName } from "./paths.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const UPLOAD_DEFAULTS = Object.freeze({
  inboxDir: "/var/lib/hqconsole/inbox",
  maxFile: 200 * MB,
  concurrency: 2,
  quota: 5 * GB,
  freeFloor: 10 * GB,
  retentionDays: 30,
});

function intOr(v, d, name) {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * Upload settings. Resolved from the console config when the lead adds these
 * fields to config.js, otherwise straight from the environment, so this module
 * works today and keeps working after config.js grows them.
 * @param {any} cfg @param {NodeJS.ProcessEnv} [env]
 */
export function uploadConfig(cfg = {}, env = process.env) {
  const hqRoot = cfg.hqRoot || "/home/owner/hq";
  const devDefault = path.join(hqRoot, "state", "console-v2", "inbox");
  const inboxDir = path.resolve(
    cfg.inboxDir || env.CONSOLE_INBOX_DIR || (cfg.devNoAuth ? devDefault : UPLOAD_DEFAULTS.inboxDir),
  );
  return {
    inboxDir,
    maxFile: cfg.uploadMaxFile || intOr(env.CONSOLE_UPLOAD_MAX_FILE, UPLOAD_DEFAULTS.maxFile, "CONSOLE_UPLOAD_MAX_FILE"),
    concurrency:
      cfg.uploadConcurrency ||
      intOr(env.CONSOLE_UPLOAD_CONCURRENCY, UPLOAD_DEFAULTS.concurrency, "CONSOLE_UPLOAD_CONCURRENCY"),
    quota: cfg.inboxQuota || intOr(env.CONSOLE_INBOX_QUOTA, UPLOAD_DEFAULTS.quota, "CONSOLE_INBOX_QUOTA"),
    freeFloor: cfg.freeFloor || intOr(env.CONSOLE_FREE_FLOOR, UPLOAD_DEFAULTS.freeFloor, "CONSOLE_FREE_FLOOR"),
    retentionDays:
      cfg.uploadRetentionDays ||
      intOr(env.CONSOLE_UPLOAD_RETENTION_DAYS, UPLOAD_DEFAULTS.retentionDays, "CONSOLE_UPLOAD_RETENTION_DAYS"),
    heartbeatMs: HEARTBEAT_MS,
    heartbeatStaleMs: HEARTBEAT_STALE_MS,
  };
}

/**
 * @param {{
 *   cfg?: any, alerts?: any, log?: Function, now?: () => number,
 *   env?: NodeJS.ProcessEnv, statfs?: (dir: string) => {bavail: number, bsize: number},
 *   faults?: Record<string, Function>, limits?: any,
 * }} opts
 */
export function createUploads(opts = {}) {
  const cfg = opts.cfg || {};
  const log = opts.log || ((m) => process.stderr.write(`console: ${m}\n`));
  const now = opts.now || (() => Date.now());
  const limits = { ...uploadConfig(cfg, opts.env || process.env), ...(opts.limits || {}) };
  const paths = inboxPaths(limits.inboxDir);
  ensureTree(paths);

  const store = new UploadStore(paths.dbFile, { now });
  const admission = new Admission({
    maxFile: limits.maxFile,
    concurrency: limits.concurrency,
    quota: limits.quota,
    freeFloor: limits.freeFloor,
    dir: paths.dir,
    store,
    statfs: opts.statfs || realStatfs(fs),
  });
  const stats = { bytesRead: 0, committed: 0, failed: 0, dedupes: 0, crashed: 0 };
  const faults = opts.faults || {};
  const ctx = { store, admission, paths, limits, alerts: opts.alerts, log, now, faults, stats };

  const handle = createHandler(ctx);
  const reconcile = createReconcile(ctx);
  const retention = createRetention(ctx);

  return {
    limits,
    paths,
    store,
    admission,
    stats,
    faults,

    /** POST /api/upload. Must be routed before the JSON body reader. */
    handle,

    /** GET /api/uploads?date=YYYY-MM-DD -> UploadEntry[] */
    list: (dateStr) => retention.list(dateStr),

    /** POST /api/uploads/:id/keep {keep} -> {ok, entry} | {ok:false, status, error} */
    setKeep: (id, keep) => retention.setKeep(id, Boolean(keep)),

    /** POST /api/uploads/:id/delete -> {ok:true} | {ok:false, status, error} */
    remove: (id) => retention.remove(id),

    /** Real start only: never called from --check (which creates nothing). */
    boot() {
      const rec = reconcile.run();
      const swept = retention.sweep();
      return { ...rec, ...swept };
    },

    /** The retention sweep on its own, for a daily timer. */
    sweep: () => retention.sweep(),

    /** Health line for /healthz. */
    health() {
      return {
        inbox: paths.dir,
        schema: store.version(),
        live: store.listCommitted().length,
        bytes: store.liveBytes(),
        quota: limits.quota,
        inFlight: admission.active.size,
      };
    },

    close() {
      store.close();
    },
  };
}

export {
  Admission,
  HttpError,
  UploadCrash,
  UploadState,
  UploadStore,
  SCHEMA_VERSION,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  dayOf,
  sanitiseName,
  inboxPaths,
};
