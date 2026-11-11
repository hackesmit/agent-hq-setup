import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Alerts } from "../src/alerts.js";
import { Collectors, registerAll } from "../src/collectors.js";
import {
  DISK_FREE_CRIT_PCT,
  DISK_FREE_WARN_PCT,
  MEM_PRESSURE_PCT,
  BACKUP_ALERT_ID,
  BACKUP_STALE_H,
  DISK_HEALTH_ALERT_ID,
  SWAP_ALERT_ID,
  SWAP_THRASH_PCT,
  TEMP_ALERT_ID,
  TEMP_HIGH_C,
  judgeBackup,
  judgeDisk,
  diskCritAlertId,
  diskWarnAlertId,
  evaluateMachineAlerts,
  machineAlertsFor,
} from "../src/machineAlerts.js";
import { devConfig, fakeSources, tmpDir } from "./helpers.js";

/** A MachineSnapshot with healthy numbers, overridable slice by slice. */
function snapshot(over = {}) {
  return {
    host: "hqbox",
    uptimeS: 3600,
    cpuPct: 4,
    cores: 8,
    load: [0.2, 0.2, 0.2],
    mem: { totalMb: 16000, usedMb: 4000, pct: 25, ...(over.mem || {}) },
    swap: { totalMb: 8000, usedMb: 0, pct: 0, ...(over.swap || {}) },
    tempC: 41,
    disks: over.disks || [{ mount: "/", totalGb: 500, freeGb: 300, pct: 40 }],
    topRss: [],
    cpuSeries24h: [],
    series: null,
    ...(over.host ? { host: over.host } : {}),
    ...(over.tempC !== undefined ? { tempC: over.tempC } : {}),
    ...(over.health ? { health: over.health } : {}),
  };
}

/** hw.py reports pct as the USED share, so a disk at 8 percent free is pct 92. */
const disk = (mount, freePct, totalGb = 500) => ({
  mount,
  totalGb,
  freeGb: Math.round(totalGb * (freePct / 100) * 10) / 10,
  pct: Math.round((100 - freePct) * 10) / 10,
});

function newAlerts() {
  return new Alerts({ file: path.join(tmpDir("hqconsole-machine-alerts-"), "alerts.jsonl") });
}

test("a healthy box raises nothing", () => {
  const alerts = newAlerts();
  const r = evaluateMachineAlerts(snapshot(), alerts);
  assert.deepEqual(r.raised, []);
  assert.deepEqual(r.cleared, []);
  assert.deepEqual(alerts.list(), []);
});

test("a disk at 8 percent free raises one P1", () => {
  const alerts = newAlerts();
  const r = evaluateMachineAlerts(snapshot({ disks: [disk("/", 8)] }), alerts);
  assert.deepEqual(r.raised, [diskWarnAlertId("/")]);
  const list = alerts.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, "P1");
  assert.equal(list[0].source, "machine");
  assert.match(list[0].title, /Disk filling up: hqbox \//);
  assert.match(list[0].detail, /8 percent free/);
});

test("a disk exactly at the floor is not an alert, just under it is", () => {
  const alerts = newAlerts();
  assert.deepEqual(machineAlertsFor(snapshot({ disks: [disk("/", DISK_FREE_WARN_PCT)] })), []);
  const just = machineAlertsFor(snapshot({ disks: [disk("/", DISK_FREE_WARN_PCT - 0.5)] }));
  assert.equal(just.length, 1);
  assert.equal(just[0].severity, "P1");
  assert.equal(alerts.list().length, 0);
});

test("a disk at 2 percent free raises a P0 instead of the P1", () => {
  const alerts = newAlerts();
  const r = evaluateMachineAlerts(snapshot({ disks: [disk("/", 2)] }), alerts);
  assert.deepEqual(r.raised, [diskCritAlertId("/")]);
  const list = alerts.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, "P0");
  assert.match(list[0].title, /Disk almost full/);
  assert.ok(DISK_FREE_CRIT_PCT < DISK_FREE_WARN_PCT);
});

test("a disk sliding from P1 to P0 replaces the card rather than stacking one", () => {
  const alerts = newAlerts();
  evaluateMachineAlerts(snapshot({ disks: [disk("/", 8)] }), alerts);
  const r = evaluateMachineAlerts(snapshot({ disks: [disk("/", 2)] }), alerts);
  assert.deepEqual(r.raised, [diskCritAlertId("/")]);
  assert.deepEqual(r.cleared, [diskWarnAlertId("/")]);
  const list = alerts.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, diskCritAlertId("/"));
});

test("each mount gets its own stable id and only the bad one alerts", () => {
  const alerts = newAlerts();
  const snap = snapshot({ disks: [disk("/", 55), disk("/mnt/data", 4, 2000)] });
  const r = evaluateMachineAlerts(snap, alerts);
  assert.deepEqual(r.raised, [diskWarnAlertId("/mnt/data")]);
  assert.equal(alerts.list().length, 1);
});

test("swap over the floor while memory is high is a P0", () => {
  const alerts = newAlerts();
  const r = evaluateMachineAlerts(snapshot({ mem: { pct: 95 }, swap: { pct: 72 } }), alerts);
  assert.deepEqual(r.raised, [SWAP_ALERT_ID]);
  const rec = alerts.list()[0];
  assert.equal(rec.severity, "P0");
  assert.match(rec.title, /Swap thrashing: hqbox/);
  assert.match(rec.detail, /memory 95 percent and swap 72 percent/);
});

test("swap pressure alone, or memory pressure alone, is not thrashing", () => {
  const alerts = newAlerts();
  evaluateMachineAlerts(snapshot({ mem: { pct: 40 }, swap: { pct: SWAP_THRASH_PCT + 20 } }), alerts);
  evaluateMachineAlerts(snapshot({ mem: { pct: MEM_PRESSURE_PCT + 5 }, swap: { pct: 10 } }), alerts);
  assert.deepEqual(alerts.list(), []);
});

test("a repeated condition is one event: raised once, same timestamp", () => {
  let now = 1_000_000;
  const alerts = new Alerts({ file: path.join(tmpDir(), "alerts.jsonl"), now: () => now });
  const snap = snapshot({ disks: [disk("/", 8)] });
  const first = evaluateMachineAlerts(snap, alerts);
  const created = alerts.list()[0].createdAt;
  now += 60_000;
  const second = evaluateMachineAlerts(snap, alerts);
  assert.deepEqual(first.raised, [diskWarnAlertId("/")]);
  assert.deepEqual(second.raised, []);
  assert.equal(alerts.list().length, 1);
  assert.equal(alerts.list()[0].createdAt, created);
});

test("recovery clears the alert on the next sample", () => {
  const alerts = newAlerts();
  evaluateMachineAlerts(snapshot({ disks: [disk("/", 2)] }), alerts);
  evaluateMachineAlerts(snapshot({ mem: { pct: 95 }, swap: { pct: 72 }, disks: [disk("/", 2)] }), alerts);
  assert.equal(alerts.list().length, 2);
  const r = evaluateMachineAlerts(snapshot(), alerts);
  assert.deepEqual(r.raised, []);
  assert.deepEqual(r.cleared.sort(), [SWAP_ALERT_ID, diskCritAlertId("/")].sort());
  assert.deepEqual(alerts.list(), []);
});

test("a mount that disappears from the snapshot clears its alert", () => {
  const alerts = newAlerts();
  evaluateMachineAlerts(snapshot({ disks: [disk("/", 55), disk("/mnt/usb", 1, 100)] }), alerts);
  assert.equal(alerts.list().length, 1);
  const r = evaluateMachineAlerts(snapshot({ disks: [disk("/", 55)] }), alerts);
  assert.deepEqual(r.cleared, [diskCritAlertId("/mnt/usb")]);
  assert.deepEqual(alerts.list(), []);
});

test("alerts raised by anything else are left alone", () => {
  const alerts = newAlerts();
  alerts.add({ id: "cert-expiry", severity: "P0", title: "TLS certificate expires soon", source: "cert" });
  evaluateMachineAlerts(snapshot({ disks: [disk("/", 8)] }), alerts);
  evaluateMachineAlerts(snapshot(), alerts);
  assert.deepEqual(alerts.list().map((a) => a.id), ["cert-expiry"]);
});

test("a snapshot with junk figures is ignored rather than alerting on zero", () => {
  const alerts = newAlerts();
  const junk = {
    host: "hqbox",
    mem: { pct: null },
    swap: { pct: null },
    disks: [{ mount: "", totalGb: 0, freeGb: 0, pct: 0 }, { mount: "/proc", totalGb: 0, freeGb: 0, pct: null }, null],
  };
  const r = evaluateMachineAlerts(junk, alerts);
  assert.deepEqual(r.raised, []);
  assert.deepEqual(alerts.list(), []);
  assert.deepEqual(machineAlertsFor(null), []);
});

test("free percent falls back to the GB pair when pct is missing", () => {
  const found = machineAlertsFor({ host: "hqbox", disks: [{ mount: "/", totalGb: 100, freeGb: 5, pct: null }] });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "P1");
});

test("the machine collector evaluates the floors on every fresh snapshot", async () => {
  const cfg = devConfig();
  const alerts = newAlerts();
  let freePct = 2;
  const reg = new Collectors({});
  registerAll(reg, {
    cfg,
    alerts,
    readOnly: true,
    rigs: [],
    sources: fakeSources({
      hw: async () => ({
        cpu: { pct: 3, cores: 8, load: [0, 0, 0] },
        mem: { total: 100, used: 25, pct: 25 },
        swap: { total: 100, used: 0, pct: 0 },
        disks: [{ mount: "/", total: 500 * 1024 ** 3, free: 500 * 1024 ** 3 * (freePct / 100), pct: 100 - freePct }],
        procs: [],
      }),
    }),
  });

  await reg.refresh("machine");
  assert.deepEqual(alerts.list().map((a) => [a.id, a.severity]), [[diskCritAlertId("/"), "P0"]]);

  freePct = 60;
  await reg.refresh("machine");
  assert.deepEqual(alerts.list(), []);
});

const NOW = Date.parse("2026-10-11T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const goodDisk = (over = {}) => ({
  at: hoursAgo(0.1), device: "/dev/nvme0", model: "SAMSUNG", passed: true, tempC: 38, usedPct: 4,
  sparePct: 100, spareThresholdPct: 10, powerOnHours: 2981, unsafeShutdowns: 101, mediaErrors: 0, ...over,
});
const goodBackup = (over = {}) => ({ target: "george", lastSuccessAt: hoursAgo(3), lastAttemptAt: hoursAgo(1), lastResult: "ok", ...over });

test("healthy disk and backup reports raise nothing, and neither does their absence", () => {
  assert.deepEqual(machineAlertsFor(snapshot({ health: { disk: goodDisk(), backup: goodBackup() } }), NOW), []);
  assert.deepEqual(machineAlertsFor(snapshot({ health: { disk: null, backup: null } }), NOW), []);
});

test("a failed drive self-check is a P0, wear and media errors are a P1", () => {
  const failing = machineAlertsFor(snapshot({ health: { disk: goodDisk({ passed: false }), backup: null } }), NOW);
  assert.deepEqual(failing.map((a) => [a.id, a.severity]), [[DISK_HEALTH_ALERT_ID, "P0"]]);
  const spare = machineAlertsFor(snapshot({ health: { disk: goodDisk({ sparePct: 9 }), backup: null } }), NOW);
  assert.equal(spare[0].severity, "P0");
  const worn = machineAlertsFor(snapshot({ health: { disk: goodDisk({ usedPct: 93, mediaErrors: 2 }), backup: null } }), NOW);
  assert.deepEqual(worn.map((a) => [a.id, a.severity]), [[DISK_HEALTH_ALERT_ID, "P1"]]);
  assert.match(worn[0].detail, /93 percent/);
  assert.match(worn[0].detail, /2 media errors/);
});

test("a disk reading that stopped arriving is a warning, not a pass", () => {
  assert.equal(judgeDisk(goodDisk({ at: hoursAgo(5) }), NOW).level, "warn");
  assert.equal(judgeDisk(goodDisk({ at: "not a date" }), NOW).level, "ok");
});

test("a backup older than the floor, or one that never succeeded, is a P1", () => {
  assert.equal(judgeBackup(goodBackup({ lastSuccessAt: hoursAgo(BACKUP_STALE_H - 1) }), NOW).level, "ok");
  const stale = machineAlertsFor(
    snapshot({ health: { disk: null, backup: goodBackup({ lastSuccessAt: hoursAgo(BACKUP_STALE_H + 2), lastResult: "skipped: george unreachable" }) } }),
    NOW,
  );
  assert.deepEqual(stale.map((a) => [a.id, a.severity]), [[BACKUP_ALERT_ID, "P1"]]);
  assert.match(stale[0].detail, /george unreachable/);
  assert.equal(judgeBackup(goodBackup({ lastSuccessAt: null }), NOW).level, "warn");
  assert.equal(judgeBackup(goodBackup({ lastResult: "skipped: george unreachable" }), NOW).level, "ok");
  assert.equal(judgeBackup(goodBackup({ lastResult: "failed: restic exit 1" }), NOW).level, "warn");
});

test("a CPU at the temperature floor is a P1 that clears when it cools", () => {
  const alerts = newAlerts();
  evaluateMachineAlerts(snapshot({ tempC: TEMP_HIGH_C }), alerts);
  assert.deepEqual(alerts.list().map((a) => [a.id, a.severity]), [[TEMP_ALERT_ID, "P1"]]);
  evaluateMachineAlerts(snapshot({ tempC: TEMP_HIGH_C - 1 }), alerts);
  assert.deepEqual(alerts.list(), []);
  assert.deepEqual(machineAlertsFor(snapshot({ tempC: null })), []);
});
