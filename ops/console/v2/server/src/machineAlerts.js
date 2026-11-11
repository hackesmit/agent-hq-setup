// Machine floor alerts: turn the hw collector's numbers and health reports into pinned cards.
//
// The machine snapshot already carries every disk, memory and swap figure the
// Machines tab draws, but a chart nobody is looking at is not a warning. This
// module reads one MachineSnapshot (shared/api.ts) and raises or clears alerts
// through the existing Alerts class, so a box that is filling its disk or
// thrashing swap shows up in Now like a collector failure or a cert expiry.
//
// Pure over (snapshot, alerts): no timers, no state of its own. The alert ids
// are stable per mount and condition, so an ongoing problem is one card that
// keeps its original timestamp, and a fixed problem clears itself on the next
// sample instead of waiting for somebody to ack it.

/** Free space below this (percent of the filesystem) is a P1. */
export const DISK_FREE_WARN_PCT = 10;
/** Free space below this is a P0: the box is minutes from write failures. */
export const DISK_FREE_CRIT_PCT = 3;
/** Swap use above this, together with the memory floor below, is thrashing. */
export const SWAP_THRASH_PCT = 50;
/** Memory use above this is what turns swap pressure into a P0. */
export const MEM_PRESSURE_PCT = 90;

/** A CPU this hot is throttling; the fan or the paste needs a look. */
export const TEMP_HIGH_C = 90;
/** Rated endurance consumed past this is a drive to replace on your own schedule. */
export const DISK_WEAR_WARN_PCT = 90;
/** The disk job runs every ten minutes, so a reading this old means it stopped. */
export const DISK_READING_STALE_H = 2;
/** The backup job tries hourly and wants one snapshot a day; two days without is a gap. */
export const BACKUP_STALE_H = 48;

const SOURCE = "machine";
const DISK_WARN_PREFIX = "machine-disk-low:";
const DISK_CRIT_PREFIX = "machine-disk-critical:";
/** One box, one swap: no per-mount suffix. */
export const SWAP_ALERT_ID = "machine-swap-thrash";
export const TEMP_ALERT_ID = "machine-temp-high";
export const DISK_HEALTH_ALERT_ID = "machine-disk-health";
export const BACKUP_ALERT_ID = "machine-backup-stale";
const FIXED_IDS = new Set([SWAP_ALERT_ID, TEMP_ALERT_ID, DISK_HEALTH_ALERT_ID, BACKUP_ALERT_ID]);

/** Ids are read back off the alert list, so the mount has to survive a round trip. */
const mountKey = (mount) => String(mount).replace(/\s+/g, "_");

export const diskWarnAlertId = (mount) => `${DISK_WARN_PREFIX}${mountKey(mount)}`;
export const diskCritAlertId = (mount) => `${DISK_CRIT_PREFIX}${mountKey(mount)}`;

// Number(null) is 0, which would read a missing percentage as a full disk, so
// the empty cases are rejected before the coercion rather than after it.
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Free space as a percentage. hw.py reports `pct` as the USED share, so free is
 * its complement; the GB pair is the fallback for a snapshot that lost `pct`.
 * @returns {number|null} null when the row says nothing usable
 */
export function freePctOf(disk) {
  const pct = num(disk && disk.pct);
  if (pct !== null && pct >= 0 && pct <= 100) return 100 - pct;
  const total = num(disk && disk.totalGb);
  const free = num(disk && disk.freeGb);
  if (total !== null && total > 0 && free !== null && free >= 0) return (free / total) * 100;
  return null;
}

/** Hours between an ISO timestamp and now, or null when it does not parse. */
function hoursSince(iso, now) {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 3_600_000 : null;
}

/**
 * Read one disk report (the DiskHealth figures) and say how worried to be. The
 * Machines tab and the alerts both use this, so the page and the card can
 * never disagree about the same reading.
 * @returns {{level: "ok"|"warn"|"crit", problems: string[]}}
 */
export function judgeDisk(disk, now = Date.now()) {
  const d = disk && typeof disk === "object" ? disk : {};
  const crit = [];
  const warn = [];
  if (d.passed === false) crit.push("the drive's own health check failed");
  const used = num(d.usedPct);
  if (used !== null && used >= DISK_WEAR_WARN_PCT) warn.push(`${round1(used)} percent of rated endurance used`);
  const spare = num(d.sparePct);
  const floor = num(d.spareThresholdPct);
  if (spare !== null && floor !== null && spare <= floor) crit.push(`spare capacity ${round1(spare)} percent, at or under the drive's ${round1(floor)} percent floor`);
  const media = num(d.mediaErrors);
  if (media !== null && media > 0) warn.push(`${media} media errors logged`);
  const age = hoursSince(d.at, now);
  if (age !== null && age > DISK_READING_STALE_H) warn.push(`last reading is ${Math.round(age)} hours old, the disk check has stopped`);
  if (crit.length) return { level: "crit", problems: [...crit, ...warn] };
  return { level: warn.length ? "warn" : "ok", problems: warn };
}

/**
 * Same for the backup report. A job that has never succeeded is as much a gap
 * as one that stopped two days ago, and a failed run does not wait two days.
 * @returns {{level: "ok"|"warn"|"crit", problems: string[]}}
 */
export function judgeBackup(backup, now = Date.now()) {
  const b = backup && typeof backup === "object" ? backup : {};
  const age = hoursSince(b.lastSuccessAt, now);
  const why = b.lastResult && b.lastResult !== "ok" ? `; last attempt: ${String(b.lastResult).slice(0, 80)}` : "";
  if (age === null) return { level: "warn", problems: [`no snapshot has ever succeeded${why}`] };
  if (age > BACKUP_STALE_H) return { level: "warn", problems: [`last snapshot is ${Math.round(age)} hours old${why}`] };
  // A skipped run (the target was asleep) is routine while the snapshot is
  // fresh. A run that tried and failed is worth a card straight away.
  const result = String(b.lastResult || "");
  if (result && result !== "ok" && !result.startsWith("skipped")) return { level: "warn", problems: [`last attempt: ${result.slice(0, 80)}`] };
  return { level: "ok", problems: [] };
}

/**
 * Decide what a snapshot deserves. Split out from the raising so the thresholds
 * can be tested without an Alerts instance and a temp file.
 * @param {any} snapshot a MachineSnapshot
 * @param {number} [now] epoch ms, for the two age checks
 * @returns {{id: string, severity: "P0"|"P1", title: string, detail: string}[]}
 */
export function machineAlertsFor(snapshot, now = Date.now()) {
  const out = [];
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const host = String(snap.host || "this box");

  const disks = Array.isArray(snap.disks) ? snap.disks : [];
  for (const disk of disks) {
    const mount = disk && disk.mount ? String(disk.mount) : "";
    if (!mount) continue;
    const freePct = freePctOf(disk);
    if (freePct === null) continue;
    const freeGb = num(disk.freeGb);
    const size = freeGb === null ? "" : ` (${round1(freeGb)} GB)`;
    const where = `${host} ${mount}`;
    // Critical is a strict subset of low, so exactly one card exists per mount:
    // the P0 replaces the P1 rather than stacking a second row for one disk.
    if (freePct < DISK_FREE_CRIT_PCT) {
      out.push({
        id: diskCritAlertId(mount),
        severity: "P0",
        title: `Disk almost full: ${where}`,
        detail: `${round1(freePct)} percent free${size}, under the ${DISK_FREE_CRIT_PCT} percent floor; writes are about to start failing`,
      });
    } else if (freePct < DISK_FREE_WARN_PCT) {
      out.push({
        id: diskWarnAlertId(mount),
        severity: "P1",
        title: `Disk filling up: ${where}`,
        detail: `${round1(freePct)} percent free${size}, under the ${DISK_FREE_WARN_PCT} percent floor`,
      });
    }
  }

  const memPct = num(snap.mem && snap.mem.pct);
  const swapPct = num(snap.swap && snap.swap.pct);
  if (memPct !== null && swapPct !== null && swapPct > SWAP_THRASH_PCT && memPct > MEM_PRESSURE_PCT) {
    out.push({
      id: SWAP_ALERT_ID,
      severity: "P0",
      title: `Swap thrashing: ${host}`,
      detail: `memory ${round1(memPct)} percent and swap ${round1(swapPct)} percent, over the ${MEM_PRESSURE_PCT}/${SWAP_THRASH_PCT} floor; the box is paging, not working`,
    });
  }

  const tempC = num(snap.tempC);
  if (tempC !== null && tempC >= TEMP_HIGH_C) {
    out.push({
      id: TEMP_ALERT_ID,
      severity: "P1",
      title: `Running hot: ${host}`,
      detail: `${round1(tempC)} C, at or over the ${TEMP_HIGH_C} C floor; the CPU is throttling`,
    });
  }

  // A half that is null means its job has never reported here (a dev box, a
  // test), which is not a finding. Only a report that exists can be bad.
  const health = snap.health && typeof snap.health === "object" ? snap.health : {};
  if (health.disk) {
    const verdict = judgeDisk(health.disk, now);
    if (verdict.level !== "ok") {
      out.push({
        id: DISK_HEALTH_ALERT_ID,
        severity: verdict.level === "crit" ? "P0" : "P1",
        title: verdict.level === "crit" ? `Disk failing: ${host}` : `Disk health warning: ${host}`,
        detail: `${String(health.disk.device || "disk")}: ${verdict.problems.join("; ")}`,
      });
    }
  }
  if (health.backup) {
    const verdict = judgeBackup(health.backup, now);
    if (verdict.level !== "ok") {
      out.push({
        id: BACKUP_ALERT_ID,
        severity: "P1",
        title: `Backup overdue: ${host}`,
        detail: `to ${String(health.backup.target || "its target")}: ${verdict.problems.join("; ")}`,
      });
    }
  }

  return out;
}

const isMachineAlertId = (id) =>
  typeof id === "string" && (FIXED_IDS.has(id) || id.startsWith(DISK_WARN_PREFIX) || id.startsWith(DISK_CRIT_PREFIX));

/**
 * Evaluate one snapshot and reconcile the alert list against it: raise what is
 * wrong now, clear what this module raised before and is no longer true. A
 * mount that vanished from the snapshot clears too, so unplugging a full disk
 * does not leave a card behind forever.
 *
 * There is no notify verb in the server (the wrapper's allowlist has no
 * notify.sh), so a P0 logs and the console card is the delivery. Adding one is
 * a separate acquisition, not a silent shell-out from here.
 *
 * @param {any} snapshot a MachineSnapshot
 * @param {import("./alerts.js").Alerts} alerts
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {{raised: string[], cleared: string[]}}
 */
export function evaluateMachineAlerts(snapshot, alerts, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const raised = [];
  const cleared = [];
  if (!alerts || typeof alerts.add !== "function") return { raised, cleared };

  const wanted = machineAlertsFor(snapshot);
  const wantedIds = new Set(wanted.map((a) => a.id));

  const existing = typeof alerts.list === "function" ? alerts.list() : [];
  const held = new Set(existing.filter((rec) => rec && isMachineAlertId(rec.id)).map((rec) => rec.id));

  for (const a of wanted) {
    const fresh = !held.has(a.id);
    alerts.add({ id: a.id, severity: a.severity, title: a.title, detail: a.detail, source: SOURCE });
    if (fresh) {
      raised.push(a.id);
      log(`${a.severity} ${a.title}: ${a.detail}`);
    }
  }

  for (const id of held) {
    if (wantedIds.has(id)) continue;
    if (typeof alerts.clear === "function" && alerts.clear(id)) {
      cleared.push(id);
      log(`machine alert cleared: ${id}`);
    }
  }

  return { raised, cleared };
}
