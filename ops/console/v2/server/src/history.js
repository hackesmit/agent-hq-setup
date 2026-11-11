// A small on-disk ring buffer for the hardware figures.
//
// The machine snapshot is a photograph: 73 degrees, 38 percent, load 2.94. A
// photograph cannot answer the two questions actually being asked, which are
// "is that normal for this box" and "is it going somewhere". Both need history,
// and the producer has none: hw.py returns a bare sample and has never kept a
// series (the console has been mapping an always-empty cpu_series since P2.3).
//
// The history is kept HERE rather than by fixing hw.py, for one reason worth
// stating: hw.py lives under ops/scripts, which is guard-protected and
// proposal-only for agents. The console owns its own state directory, the
// machine collector already runs on a timer, and a ring buffer written where the
// samples are already arriving is both simpler and inside the boundary.
//
// The file is a ring, not a log. It is bounded by construction rather than by a
// sweep, so it cannot become the thing that fills the disk it is reporting on.
import fs from "node:fs";
import path from "node:path";

/** One sample per collector refresh; the machine collector runs every 15s. */
export const MAX_SAMPLES = 720; // three hours at 15s, well under a megabyte

export class History {
  /** @param {{file: string, readOnly?: boolean, max?: number, log?: Function}} o */
  constructor(o) {
    this.file = o.file;
    this.readOnly = Boolean(o.readOnly);
    this.max = o.max || MAX_SAMPLES;
    this.log = o.log || (() => {});
    /** @type {{at: string, cpu: number, mem: number, load: number, temp: number|null}[]} */
    this.samples = [];
    this.loaded = false;
  }

  load() {
    this.loaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const rows = Array.isArray(j && j.samples) ? j.samples : [];
      // Validate on read exactly as on write: a hand-edited or truncated file
      // must not put a NaN into a graph, where it would silently break the axis.
      this.samples = rows.filter((r) => this.valid(r)).slice(-this.max);
    } catch {
      this.samples = [];
    }
    return this;
  }

  valid(r) {
    if (!r || typeof r !== "object") return false;
    if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return false;
    for (const k of ["cpu", "mem", "load"]) {
      if (!Number.isFinite(r[k])) return false;
    }
    if (r.temp !== null && !Number.isFinite(r.temp)) return false;
    return true;
  }

  /**
   * Record one machine snapshot. Silently does nothing for a snapshot it cannot
   * read: a gap in the graph is honest, and a zero would be a lie about the box.
   */
  push(machine, nowIso) {
    if (!machine) return;
    const sample = {
      at: nowIso || new Date().toISOString(),
      cpu: Number(machine.cpuPct),
      mem: Number(machine.mem && machine.mem.pct),
      // Load normalised by core count, because 4.0 means saturated on 4 cores
      // and comfortable on 12, and the number alone never says which.
      load: machine.cores > 0 ? Number(machine.load && machine.load[0]) / Number(machine.cores) : NaN,
      temp: machine.tempC == null ? null : Number(machine.tempC),
    };
    if (!this.valid(sample)) return;
    this.samples.push(sample);
    if (this.samples.length > this.max) this.samples = this.samples.slice(-this.max);
    this.save();
  }

  save() {
    if (this.readOnly) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o750 });
      const tmp = `${this.file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, samples: this.samples }), { mode: 0o640 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // A history that cannot be written is a degraded graph, never a failed
      // page: the current figures are still true and still worth showing.
      this.log(`machine history not saved: ${String(e && e.message)}`);
    }
  }

  /** The series a graph draws, oldest first, one array per metric. */
  series() {
    return {
      at: this.samples.map((s) => s.at),
      cpu: this.samples.map((s) => s.cpu),
      mem: this.samples.map((s) => s.mem),
      load: this.samples.map((s) => s.load),
      // A box with no thermal sensor produces nulls rather than a flat zero line.
      temp: this.samples.map((s) => s.temp),
    };
  }
}
