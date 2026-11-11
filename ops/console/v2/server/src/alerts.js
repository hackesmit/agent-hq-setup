// Alerts: the pinned cards the design puts in Now (cert expiry, collector
// failures, activation problems). In memory for the live list, appended to
// $STATE/alerts.jsonl so a restart does not lose a P0 that nobody has seen.
// Check mode passes readOnly:true and nothing touches the disk.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class Alerts {
  /** @param {{file: string, readOnly?: boolean, now?: () => number, max?: number}} opts */
  constructor(opts) {
    this.file = opts.file;
    this.readOnly = Boolean(opts.readOnly);
    this.now = opts.now || (() => Date.now());
    this.max = opts.max || 200;
    /** @type {Map<string, any>} */
    this.byId = new Map();
  }

  /** Replay the file so alerts survive a restart. Never throws. */
  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (!rec || !rec.id) continue;
          if (rec.acked) this.byId.delete(rec.id);
          else this.byId.set(rec.id, rec);
        } catch {
          /* a torn line is skipped, not fatal */
        }
      }
    } catch {
      /* absent file is the first-boot state */
    }
    return this;
  }

  append(rec) {
    if (this.readOnly) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    } catch {
      /* an alert that cannot be persisted still shows in this process */
    }
  }

  /**
   * @param {{id?: string, severity: "P0"|"P1"|"P2", title: string, detail?: string|null, source: string, ackable?: boolean}} a
   */
  add(a) {
    const id = a.id || `a-${crypto.randomBytes(4).toString("hex")}`;
    const rec = {
      id,
      severity: a.severity,
      title: String(a.title || ""),
      detail: a.detail == null ? null : String(a.detail),
      createdAt: new Date(this.now()).toISOString(),
      source: String(a.source || "server"),
      ackable: a.ackable !== false,
    };
    const prev = this.byId.get(id);
    // a repeated alert (same id) keeps its original timestamp: it is one event
    if (prev) rec.createdAt = prev.createdAt;
    this.byId.set(id, rec);
    while (this.byId.size > this.max) this.byId.delete(this.byId.keys().next().value);
    if (!prev) this.append(rec);
    return rec;
  }

  ack(id) {
    const rec = this.byId.get(id);
    if (!rec) return false;
    this.byId.delete(id);
    this.append({ ...rec, acked: true, ackedAt: new Date(this.now()).toISOString() });
    return true;
  }

  /** Clear an alert that has fixed itself (cert renewed, collector recovered). */
  clear(id) {
    if (!this.byId.has(id)) return false;
    return this.ack(id);
  }

  list() {
    return [...this.byId.values()];
  }
}
