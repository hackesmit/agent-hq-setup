// Shared harness for the upload tests: a real HTTP server mounting the real
// module (real busboy, real node:sqlite, a real temp inbox on disk), a fake
// statvfs so free space is controllable, and a clock the tests move.
//
// Not a *.test.js file on purpose: `npm test` globs test/**/*.test.js.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { Alerts } from "../src/alerts.js";
import { createUploads } from "../src/upload/index.js";

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function bytes(n, fill = 0x61) {
  return Buffer.alloc(n, fill);
}

export function tmpInbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hq-upload-test-"));
}

/**
 * Mount the module exactly as the lead will mount it, so the tests exercise
 * the documented routes and not a private entry point.
 */
export function mount(uploads) {
  return async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (req.method === "POST" && p === "/api/upload") return await uploads.handle(req, res);
      if (req.method === "GET" && p === "/api/uploads") {
        return json(res, 200, uploads.list(url.searchParams.get("date")));
      }
      const keep = p.match(/^\/api\/uploads\/([A-Za-z0-9._-]{1,64})\/keep$/);
      if (req.method === "POST" && keep) {
        const body = await readJson(req);
        const out = uploads.setKeep(keep[1], body.keep);
        return out.ok ? json(res, 200, out.entry) : json(res, out.status, { error: out.error });
      }
      const del = p.match(/^\/api\/uploads\/([A-Za-z0-9._-]{1,64})\/delete$/);
      if (req.method === "POST" && del) {
        await readJson(req);
        const out = uploads.remove(del[1]);
        return out.ok ? json(res, 200, { ok: true }) : json(res, out.status, { error: out.error });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  };
}

function json(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * @param {{dir?: string, limits?: object, faults?: object, free?: number, now?: number}} [over]
 */
export async function startUploads(over = {}) {
  const dir = over.dir || tmpInbox();
  const clock = { ms: over.now == null ? Date.parse("2026-08-18T12:00:00.000Z") : over.now };
  const state = { free: over.free == null ? 100 * GB : over.free };
  const alerts = new Alerts({ file: path.join(dir, "alerts.jsonl"), now: () => clock.ms });
  const faults = { ...(over.faults || {}) };

  function build() {
    return createUploads({
      cfg: { inboxDir: dir },
      env: {},
      alerts,
      log: () => {},
      now: () => clock.ms,
      statfs: () => ({ bavail: Math.floor(state.free / 4096), bsize: 4096 }),
      faults,
      limits: {
        maxFile: 1 * MB,
        concurrency: 2,
        quota: 4 * MB,
        freeFloor: 1 * GB,
        retentionDays: 30,
        heartbeatMs: 20,
        ...(over.limits || {}),
      },
    });
  }

  let uploads = build();
  const server = http.createServer((req, res) => mount(uploads)(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  return {
    dir,
    clock,
    state,
    alerts,
    faults,
    port,
    server,
    get uploads() {
      return uploads;
    },
    /** Simulate a process restart: drop the old instance, open a fresh one, boot(). */
    restart(nextFaults) {
      uploads.close();
      for (const k of Object.keys(faults)) delete faults[k];
      Object.assign(faults, nextFaults || {});
      uploads = build();
      return uploads.boot();
    },
    async close() {
      uploads.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function parts(name, content) {
  const boundary = "----hqupload" + crypto.randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { boundary, head, tail, total: head.length + content.length + tail.length };
}

/**
 * POST /api/upload. `declared` overrides the headers so a lying client can be
 * tested; `content` is what actually goes on the wire.
 * @param {{port: number}} h
 */
export function upload(h, opts) {
  const started = begin(h, opts);
  started.send();
  return started.done;
}

/** Start a request, hold the body back until send() is called. */
export function begin(h, opts) {
  const name = opts.name || "note.txt";
  const content = opts.content == null ? bytes(64) : opts.content;
  const { boundary, head, tail, total } = parts(name, content);
  const headers = {
    host: `127.0.0.1:${h.port}`,
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(total),
    ...(opts.headers || {}),
  };
  if (opts.id !== null) headers["x-upload-id"] = opts.id || "up-1";
  if (opts.size !== null) headers["x-upload-size"] = String(opts.size == null ? content.length : opts.size);
  if (opts.sha !== null) headers["x-upload-sha256"] = opts.sha == null ? sha256(content) : opts.sha;

  let settled = false;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const req = http.request({ host: "127.0.0.1", port: h.port, method: "POST", path: "/api/upload", headers }, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      if (settled) return;
      settled = true;
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        /* not json */
      }
      resolve({ status: res.statusCode, headers: res.headers, text: data, json: parsed });
    });
  });
  req.on("error", () => {
    // An early refusal closes the socket under us; the response (if any) has
    // already resolved, otherwise report the reset.
    if (settled) return;
    settled = true;
    resolve({ status: 0, headers: {}, text: "", json: null });
  });
  req.write(head);
  return {
    req,
    done,
    send() {
      try {
        req.write(content);
        req.end(tail);
      } catch {
        /* the server refused and closed the socket */
      }
    },
    abort() {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

export function readManifestLines(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, "manifest.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * Several upload tests used a fixed `setTimeout` to let a request reach the server before
 * asserting on its effect. That is a bet on scheduling, and the bet loses as the suite
 * grows: the same assertion passed alone and failed consistently under a full run,
 * because forty milliseconds is plenty on an idle box and not plenty on a busy one. The
 * failures then look like flakes, and a suite that fails at random is one people stop
 * reading.
 *
 * @param {() => boolean} cond what must become true
 * @param {{timeoutMs?: number, stepMs?: number, what?: string}} [opts]
 */
export async function until(cond, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const stepMs = opts.stepMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${opts.what || "a condition"}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
