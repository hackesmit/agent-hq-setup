// The read marker: the one timestamp that says how much of the stream the owner has read.
//
// It lives on the box rather than in a browser because the whole point is that the
// laptop, the desktop and the phone agree: marking the night's events seen on the phone
// at breakfast must not leave the desktop still shouting about them.
//
// The marker moves ONLY when it is explicitly set. Never on a page load, never on tab
// focus, never on a socket push. A console that quietly decides you have read something
// is worse than one that keeps asking, because you stop trusting the count.
import fs from "node:fs";
import path from "node:path";

export class SeenError extends Error {
  constructor(message) {
    super(message);
    this.status = 500;
  }
}

export class Seen {
  /** @param {{file: string, readOnly?: boolean, log?: Function, now?: Function}} o */
  constructor(o) {
    this.file = o.file;
    this.readOnly = Boolean(o.readOnly);
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    /** ISO string, or null when nothing has ever been marked. */
    this.at = null;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const at = j && typeof j.at === "string" ? j.at : null;
      // a stored value that is not a real date is treated as no marker at all
      this.at = at && Number.isFinite(Date.parse(at)) ? at : null;
    } catch {
      this.at = null;
    }
    return this;
  }

  get() {
    return { at: this.at };
  }

  /**
   * Move the marker. `at` defaults to now; a caller may pass the timestamp of the newest
   * event it actually displayed, so events that arrived between the render and the click
   * are not marked read.
   */
  set(at) {
    if (this.readOnly) return this.get();
    const raw = typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : new Date(this.now()).toISOString();
    // Never into the future: a client with a skewed clock would otherwise blank the
    // ribbon permanently.
    let next = Date.parse(raw) > this.now() ? new Date(this.now()).toISOString() : raw;
    // Never BACKWARD either. Two devices race by design here: marking the night seen on
    // the phone and then loading a stale desktop tab must not make those events unread
    // again. The marker only ever advances.
    if (this.at && Date.parse(next) < Date.parse(this.at)) next = this.at;

    // Persist BEFORE believing it. The old order updated memory first and swallowed the
    // write error, so a full disk answered 200 and lost the marker on the next restart.
    const previous = this.at;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o750 });
      const tmp = `${this.file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ at: next }) + "\n", { mode: 0o640 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.at = previous;
      this.log(`could not persist the read marker: ${String(e && e.message)}`);
      throw new SeenError(`could not save the read marker: ${String(e && e.message)}`);
    }
    this.at = next;
    return this.get();
  }
}
