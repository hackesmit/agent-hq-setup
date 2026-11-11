// Route 3 voice inject delivery (proposal 25, Option A).
//
// The ear queues a committed transcript with `ctl.sh meta-inject`, which appends
// it to state/console/meta-inject.jsonl (owner-writable, world-readable). This
// consumer watches that file and pushes each new entry to the live Capri tab as
// a DRAFT banner, but only when a passkey-attached tab is present.
//
// It pushes a DRAFT, it never writes to the PTY. Two cross-vendor review rounds
// established that raw PTY injection cannot be made safe from outside Claude: even
// with newlines stripped, a single-key prompt (read -n 1 "Approve? [y/N]") would
// consume the first printable byte, so an arriving task starting with "y" could
// approve the previous action. So the server never types into Capri. It shows
// the text as a banner above the terminal, and OWNER clicks Send to commit it
// through the normal passkey-attached input path, seeing exactly what Capri is
// doing first. Automatic to a banner, human-committed: the click is the same
// authority as typing it, and every action it leads to still hits the per-action
// prompt. When no attached tab exists the entry is surfaced as a card, so a
// spoken task is never lost or silently acted on.
//
// Pure-ish: the file read + per-entry decision is drainOnce(), driven directly by
// the tests; start() primes and calls drainOnce on fs.watch events and a slow poll.

import fs from "node:fs";
import path from "node:path";

// Strip CR/LF and C0/C1 control bytes: a pre-fill must be one inert line, never a
// submit (\r/\n) nor a terminal control (Ctrl-C, escape sequences).
export function sanitizeInjectText(text) {
  return String(text == null ? "" : text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class MetaInjectConsumer {
  /**
   * @param {{
   *   file: string,
   *   liveMetaSid: () => string|null,
   *   hasAttachment: (sid: string) => boolean,
   *   pushDraft: (sid: string, draft: {id: string, text: string}) => void,
   *   hold: (text: string, id: string) => void,
   *   stateFile?: string,   // durable disposition store (hqconsole-writable)
   *   log?: Function,
   *   now?: () => number,
   *   maxAgeMs?: number,
   * }} o
   */
  constructor(o) {
    this.file = o.file;
    this.stateFile = o.stateFile || null;
    this.liveMetaSid = o.liveMetaSid;
    this.hasAttachment = o.hasAttachment;
    this.pushDraft = o.pushDraft;
    this.hold = o.hold || (() => {});
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    this.maxAgeMs = o.maxAgeMs || 60_000;
    this.seen = new Set();
    this.held = new Set();
    this.watcher = null;
    this.poll = null;
    this.draining = false;
    this.rerun = false;
  }

  /** On startup, load the durable disposition (which ids were already drafted or
   *  carded), so a restart neither re-drafts a handled task nor loses an
   *  unhandled one. Entries with no recorded disposition are left for drainOnce,
   *  which drafts a young one to an attached tab and cards an expired one: a task
   *  queued while the console was down is thus surfaced, never silently dropped. */
  prime() {
    this._loadState();
  }

  _loadState() {
    if (!this.stateFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      for (const id of j.seen || []) this.seen.add(id);
      for (const id of j.held || []) this.held.add(id);
    } catch {
      /* no store yet, or unreadable: start empty */
    }
  }

  _saveState() {
    if (!this.stateFile) return;
    try {
      const tmp = this.stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ seen: [...this.seen], held: [...this.held] }));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.log(`meta-inject state save failed: ${err && err.message}`);
    }
  }

  _read() {
    let raw = "";
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      // a MISSING queue is genuinely empty; any other error (permissions, I/O)
      // must NOT read as empty, or _prune would wipe the durable disposition and
      // the next good read would redeliver everything. Signal the failure so the
      // drain skips pruning and saving this pass.
      if (err && err.code === "ENOENT") return [];
      this._readError = true;
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.id === "string" && typeof e.text === "string") out.push(e);
      } catch {
        /* a torn line is skipped, never fatal */
      }
    }
    return out;
  }

  async drainOnce() {
    const results = [];
    this._readError = false;
    const entries = this._read();
    if (this._readError) {
      // could not read the queue this pass: change nothing, keep the disposition
      this.log("meta-inject: queue unreadable this pass, skipping (state preserved)");
      return results;
    }
    for (const e of entries) {
      if (this.seen.has(e.id)) continue;
      // Age is checked BEFORE attachment: an entry past its window is held even if
      // a tab attaches late, so "delivered only within the window" actually holds.
      if (this._ageMs(e.ts) > this.maxAgeMs) {
        if (this.held.has(e.id)) {
          this.seen.add(e.id);
          continue;
        }
        try {
          this.hold(sanitizeInjectText(e.text) || e.text, e.id);
          this.held.add(e.id);
          this.seen.add(e.id);
          results.push({ id: e.id, action: "held" });
        } catch (err) {
          // hold() failed (e.g. alert store down): leave retryable, do not lose it
          results.push({ id: e.id, action: "hold-retry" });
          this.log(`meta-inject ${e.id}: hold failed, will retry: ${err && err.message}`);
        }
        continue;
      }
      const sid = this.liveMetaSid();
      if (!sid || !this.hasAttachment(sid)) {
        // young, but no attached Capri yet: leave unseen so a tab attaching
        // within the window still receives it
        results.push({ id: e.id, action: "waiting" });
        continue;
      }
      const data = sanitizeInjectText(e.text);
      if (!data) {
        this.seen.add(e.id); // nothing to show once sanitized
        results.push({ id: e.id, action: "empty" });
        continue;
      }
      try {
        // Push a DRAFT to the attached tab. The server never writes the PTY; the
        // tab shows a banner and the owner clicks Send to commit it. notifyAttached
        // returns how many sockets it actually reached: 0 means the tab vanished
        // between the attachment check and the send, so leave it unseen to retry.
        const reached = this.pushDraft(sid, { id: e.id, text: data });
        if (!reached) {
          results.push({ id: e.id, action: "retry" });
          continue;
        }
        this.seen.add(e.id); // seen only AFTER a real send, so a failure retries
        results.push({ id: e.id, action: "delivered" });
        this.log(`meta-inject ${e.id}: drafted to ${sid}`);
      } catch (err) {
        results.push({ id: e.id, action: "retry" });
        this.log(`meta-inject ${e.id}: draft push failed, will retry: ${err && err.message}`);
      }
    }
    this._prune(entries);
    this._saveState();
    return results;
  }

  /** Keep seen/held bounded to the ids still in the (capped) file, so a
   *  long-lived server does not accumulate ids forever. */
  _prune(entries) {
    const live = new Set(entries.map((e) => e.id));
    for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);
    for (const id of this.held) if (!live.has(id)) this.held.delete(id);
  }

  _ageMs(ts) {
    const t = Date.parse(String(ts || ""));
    return Number.isFinite(t) ? this.now() - t : 0;
  }

  start() {
    this.prime();
    const kick = () => {
      if (this.draining) {
        this.rerun = true;
        return;
      }
      this.draining = true;
      this.drainOnce()
        .catch((e) => this.log(`meta-inject drain crashed: ${e && e.message}`))
        .finally(() => {
          this.draining = false;
          if (this.rerun) {
            this.rerun = false;
            kick();
          }
        });
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.watcher = fs.watch(path.dirname(this.file), (_ev, name) => {
        if (!name || name === path.basename(this.file)) kick();
      });
      if (this.watcher.unref) this.watcher.unref();
    } catch (e) {
      this.log(`meta-inject watch unavailable, polling only: ${e && e.message}`);
    }
    // belt: a young entry queued with no tab attached must be delivered once a
    // tab attaches, and fs.watch misses events on some filesystems
    this.poll = setInterval(kick, 2000);
    if (this.poll.unref) this.poll.unref();
  }

  stop() {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    if (this.poll) clearInterval(this.poll);
  }
}
