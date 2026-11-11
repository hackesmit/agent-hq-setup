// Uploads: filesystem primitives shared by the handler, the reconcile and the
// retention sweep. Every durability step the design fixes lives here, so the
// ordering (fsync temp, fsync sidecar, link no-replace, fsync dir, row, then
// manifest) is written once and read once.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Built from escapes so no literal control byte ever lands in this source. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

export const SIDECAR_SUFFIX = ".meta.json";
export const MANIFEST_NAME = "manifest.jsonl";
export const DIR_MODE = 0o755;
export const FILE_MODE = 0o644;

/** @param {string} inboxDir */
export function inboxPaths(inboxDir) {
  const dir = path.resolve(inboxDir);
  return {
    dir,
    filesDir: path.join(dir, "files"),
    tmpDir: path.join(dir, ".tmp"),
    dbFile: path.join(dir, "uploads.sqlite"),
    manifest: path.join(dir, MANIFEST_NAME),
    tmpFile: (uuid) => path.join(dir, ".tmp", uuid),
    sidecar: (uuid) => path.join(dir, ".tmp", uuid + SIDECAR_SUFFIX),
  };
}

export function ensureTree(p) {
  fs.mkdirSync(p.filesDir, { recursive: true, mode: DIR_MODE });
  fs.mkdirSync(p.tmpDir, { recursive: true, mode: DIR_MODE });
}

/** Local calendar day: the inbox is one box in one timezone and the UI lists "today". */
export function dayOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A client-supplied filename is untrusted: no directories, no traversal, no
 * control characters, no leading dot (a hidden file in the inbox is a trap),
 * and a bounded length that leaves room for the collision suffix.
 */
export function sanitiseName(raw) {
  let name = String(raw == null ? "" : raw);
  name = name.split(/[\\/]/).pop() || "";
  name = name.replace(CONTROL_CHARS, "");
  name = name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\-]+/, "");
  if (name === "" || name === "." || name === "..") name = "file";
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

/** name.ext -> name-2.ext, name-3.ext ... for the no-replace link loop. */
export function suffixName(name, n) {
  if (n <= 1) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem}-${n}${ext}`;
}

export function fsyncFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
  } catch {
    return; // a platform that refuses a directory fd is not worth failing over
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    /* not fatal: the link itself is already in the journal */
  } finally {
    fs.closeSync(fd);
  }
}

export function writeJsonFsync(file, obj) {
  const fd = fs.openSync(file, "w", FILE_MODE);
  try {
    fs.writeFileSync(fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function unlinkSafe(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

export function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** sha256 of a file on disk, streamed (a 200 MB re-hash must not allocate 200 MB). */
export function hashFileSync(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** The manifest is a derived projection; every append is fsynced anyway. */
export function appendManifest(file, rec) {
  const fd = fs.openSync(file, "a", FILE_MODE);
  try {
    fs.writeFileSync(fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function manifestRecord(row) {
  return {
    ts: row.committedAt,
    id: row.id,
    name: row.name,
    path: row.path,
    size: Number(row.size),
    sha256: row.sha256,
    note: row.note == null ? null : row.note,
  };
}

/** Rewrite the manifest from the table; boot uses this when the file lags. */
export function rewriteManifest(file, rows) {
  const tmp = `${file}.tmp`;
  const body = rows.map((r) => JSON.stringify(manifestRecord(r)) + "\n").join("");
  const fd = fs.openSync(tmp, "w", FILE_MODE);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

export function readManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line is dropped by the rewrite */
    }
  }
  return out;
}

/** Every file under files/YYYY-MM-DD/, absolute paths. */
export function walkFiles(filesDir) {
  const out = [];
  let days;
  try {
    days = fs.readdirSync(filesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dir = path.join(filesDir, day.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile()) out.push(path.join(dir, e.name));
    }
  }
  return out;
}
