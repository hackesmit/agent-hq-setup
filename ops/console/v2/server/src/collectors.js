// Collector framework and the phase 0 collector set.
//
// Design section 3: one aggregator becomes a set of collectors, each with its
// own TTL cache and its own error slot, so a collector that fails shows an
// error chip in its panel while the rest of the console keeps working. A JSON
// hash per collector is the change detector, so the WebSocket pushes a slice
// only when it actually changed rather than every tick.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activityFromAlerts, activityFromGit, activityFromOps, activityFromRequests, mergeActivity, readOpsDir } from "./activity.js";
import { firstJson } from "./exec.js";
import { fetchMonitors } from "./kuma.js";
import { fetchDeploys } from "./cloud.js";
import { fetchFxRate } from "./fx.js";
import { fetchOpenAiCosts } from "./openai-costs.js";
import { evaluateMachineAlerts } from "./machineAlerts.js";
import { Wrapper } from "./wrapper.js";
import { RIGS } from "./protocol.js";
import { mapCalendar, mapFlow, mapMachine, mapMoney, mapProjects, mapReady, mapRequests, mapServices, mapSessions, mapStack, mapUnderstudy, mapUsage } from "./map.js";

function hashOf(data) {
  return crypto.createHash("sha1").update(JSON.stringify(data === undefined ? null : data)).digest("hex");
}

export class Collectors {
  /** @param {{now?: () => number, log?: Function}} [opts] */
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    /** @type {Map<string, any>} */
    this.entries = new Map();
    /** @type {Set<Function>} */
    this.listeners = new Set();
    this.timers = [];
    this.stopped = false;
  }

  /**
   * @param {string} name
   * @param {number} ttlS
   * @param {(ctx: any) => Promise<any>} fn
   * @param {{internal?: boolean}} [opts] internal collectors are not slices of ConsoleState
   */
  register(name, ttlS, fn, opts = {}) {
    this.entries.set(name, {
      name,
      ttlS,
      fn,
      internal: Boolean(opts.internal),
      data: undefined,
      hash: null,
      error: null,
      updatedAt: null,
      durationMs: null,
      inflight: null,
      queued: null,
      gen: 0, // counts runs started, so a queued request can tell a newer run from the one it waited on
    });
    return this;
  }

  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  has(name) {
    return this.entries.has(name);
  }

  /** Cached value, whatever its age. */
  peek(name) {
    const e = this.entries.get(name);
    return e ? e.data : undefined;
  }

  fresh(name) {
    const e = this.entries.get(name);
    if (!e || e.updatedAt == null) return false;
    return this.now() - e.updatedAt < e.ttlS * 1000;
  }

  /**
   * Cached value if fresh, otherwise a refresh. Concurrent calls share one run.
   * A collector that has failed and has no previous value throws, so a
   * dependent collector inherits the failure instead of silently mapping
   * `undefined` into an empty, plausible-looking slice.
   */
  async get(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no such collector: ${name}`);
    if (this.fresh(name)) return e.data;
    // A reader only needs A fresh value: a run already under way is one, so it
    // joins that run rather than asking for another after it. If a follow-up is
    // already queued behind that run, a write prompted it, and the reader waits
    // for that instead so it cannot be handed data the write predates (lucy).
    await (e.queued || e.inflight || this.refresh(name));
    if (e.error && e.data === undefined) throw new Error(e.error);
    return e.data;
  }

  /**
   * Run one collector. A failure fills the error slot and keeps the previous
   * data, so a panel goes stale-with-a-chip rather than empty.
   *
   * A refresh asked for while one is already running is NOT answered by that
   * run. The run began before whatever prompted this call (a ledger write, an
   * alert ack) and may have read its sources already, so its result can predate
   * the change; the money slice used to miss a commitment added during its own
   * refresh until the next timer tick, five minutes later. Instead exactly one
   * follow-up run is queued behind the current one, and every caller that
   * arrives during the run shares that follow-up.
   * @returns {Promise<{changed: boolean, error: string|null}>}
   */
  refresh(name) {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`no such collector: ${name}`));
    if (e.inflight) {
      if (!e.queued) {
        const since = e.gen; // the run this request is waiting out
        e.queued = e.inflight.then(() => {
          e.queued = null;
          // If some other continuation of that run already started a newer one
          // in the settlement gap, that newer run began after this request and
          // is its answer: join it rather than stacking a third run behind it.
          if (e.inflight && e.gen > since) return e.inflight;
          return this.refresh(name);
        });
      }
      return e.queued;
    }
    const started = this.now();
    e.gen += 1;
    e.inflight = (async () => {
      try {
        // Through a resolved promise, never a direct call: a collector that
        // throws synchronously would otherwise run its catch and finally BEFORE
        // the assignment below, which then overwrites the cleared slot with a
        // settled promise that every later refresh waits on forever.
        const data = await Promise.resolve().then(() => e.fn(this.ctx || {}));
        e.durationMs = this.now() - started;
        e.updatedAt = this.now();
        e.error = null;
        const h = hashOf(data);
        const changed = h !== e.hash;
        e.hash = h;
        e.data = data;
        if (changed) this.emit(name, data);
        return { changed, error: null };
      } catch (err) {
        e.durationMs = this.now() - started;
        e.error = String((err && err.message) || err).slice(0, 500);
        // updatedAt stays put: the data is as old as its last success
        this.log(`collector ${name} failed: ${e.error}`);
        return { changed: false, error: e.error };
      } finally {
        e.inflight = null;
      }
    })();
    return e.inflight;
  }

  emit(name, data) {
    for (const cb of this.listeners) {
      try {
        cb(name, data, new Date(this.now()).toISOString());
      } catch (err) {
        this.log(`collector listener threw: ${String(err && err.message)}`);
      }
    }
  }

  /** One pass over every collector, errors contained. */
  async refreshAll() {
    const names = [...this.entries.keys()];
    const results = {};
    for (const n of names) results[n] = await this.refresh(n);
    return results;
  }

  /** @returns {import("../../shared/api.js").CollectorStatus[]} */
  statuses() {
    return [...this.entries.values()]
      .filter((e) => !e.internal)
      .map((e) => ({
        name: e.name,
        updatedAt: e.updatedAt == null ? null : new Date(e.updatedAt).toISOString(),
        ttlS: e.ttlS,
        error: e.error,
        durationMs: e.durationMs,
      }));
  }

  /** Periodic refresh, one timer per collector at its own TTL. */
  start(timerFns = {}) {
    const setI = timerFns.setInterval || setInterval;
    for (const e of this.entries.values()) {
      const t = setI(() => {
        this.refresh(e.name).catch(() => {});
      }, Math.max(1, e.ttlS) * 1000);
      if (t && t.unref) t.unref();
      this.timers.push(t);
    }
    return this;
  }

  stop(timerFns = {}) {
    const clearI = timerFns.clearInterval || clearInterval;
    for (const t of this.timers) clearI(t);
    this.timers = [];
    this.stopped = true;
  }
}

// ---------- the phase 0 collector set ----------

/**
 * Every source goes through the one owner-context wrapper (wrapper.js).
 * Injectable so tests never spawn a process.
 * @param {import("./config.js").Config} cfg
 * @param {import("./wrapper.js").Wrapper} [wrapper]
 */
export function defaultSources(cfg, wrapper) {
  const w = wrapper || new Wrapper(cfg);
  const json = async (verb, args, timeout, what) => {
    const r = await w.call(verb, args, { timeout });
    const j = firstJson(r.stdout, null);
    if (!j) throw new Error(`${what} produced no JSON (exit ${r.code}${r.stderr ? ": " + r.stderr.trim().slice(-200) : ""})`);
    return j;
  };
  return {
    ctlState: () => json("ctl", ["state"], 60000, "ctl state"),
    stackData: () => json("stack", [], 120000, "stack.py"),
    flowData: () => json("flow", [], 120000, "flow.py"),
    understudyData: () => json("understudy", [], 60000, "understudy report"),
    servicesData: () => json("services", [], 60000, "services.py"),
    // No wrapper: a published status page needs no credential and Kuma runs on
    // the same box, so the server fetches it directly.
    kumaData: () => fetchMonitors({ url: cfg.kumaUrl, slug: cfg.kumaStatusPage }),
    deploysData: () => fetchDeploys(cfg),
    // Display metadata for the money tab's folded view; the ledger never converts.
    fxRate: () => fetchFxRate({ cacheFile: path.join(cfg.consoleStateDir, "fx.json") }),
    // Live Codex/OpenAI spend; "not configured" when the admin credential is absent.
    openaiCosts: () => fetchOpenAiCosts({ credential: cfg.openaiAdmin }),
    gitLog: async (dir, n) => {
      const r = await w.call("git-log", [dir, String(n)], { timeout: 20000 });
      if (r.code !== 0) throw new Error(`git-log failed for ${dir} (exit ${r.code})`);
      return r.stdout;
    },
    hw: (stateDir) => json("hw", ["--state", stateDir], 20000, "hw.py"),
    // The wrapper runs this as owner: the Google grant is in owner's home and
    // hqconsole cannot traverse it. A source rather than an inline call so a test
    // can hand it a fixture without a wrapper or a network.
    calendar: (days) => json("calendar", [String(days)], 30000, "calendar.py"),
    usage: (stateDir) => json("usage", ["--state", stateDir], 40000, "usage.py"),
    usageSeries: (stateDir) => json("usage", ["--state", stateDir, "--days", "90"], 60000, "usage.py --days 90"),
    readyBeads: async (rig) => {
      const bdVerb = rig.path === "." ? ["bd", ["ready", "--json"]] : ["bd-rig", [rig.id, "ready", "--json"]];
      const r = await w.call(bdVerb[0], bdVerb[1], { timeout: 30000 });
      if (r.code === 0) {
        const j = firstJson(r.stdout, null);
        if (Array.isArray(j)) return j;
        return parseReadyText(r.stdout);
      }
      // A rig without a beads db, or a bd build without --json: fall back to
      // the text form rather than failing the whole collector.
      const t = await w.call(bdVerb[0], bdVerb[1].slice(0, -1), { timeout: 30000 });
      if (t.code !== 0) {
        throw new Error(`bd ready failed for ${rig.id} (exit ${r.code}${r.stderr ? ": " + r.stderr.trim().slice(-160) : ""})`);
      }
      return parseReadyText(t.stdout);
    },
  };
}

/** Defensive text parse for a bd build without --json. */
export function parseReadyText(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(?:[-*]\s*)?\[?([a-z]{2,3}-[A-Za-z0-9]+)\]?\s+(?:\[?P?(\d)\]?\s+)?(.*?)\s*$/);
    if (!m) continue;
    out.push({ id: m[1], priority: m[2] == null ? 3 : Number(m[2]), title: m[3] || "", labels: [] });
  }
  return out;
}

/**
 * Wire the phase 0 collectors onto a registry.
 * @param {Collectors} reg
 * @param {{cfg: any, sources?: any, alerts: import("./alerts.js").Alerts, readOnly?: boolean, rigs?: any[]}} opts
 */
export function registerAll(reg, opts) {
  const cfg = opts.cfg;
  const src = opts.sources || defaultSources(cfg, opts.wrapper);
  const alerts = opts.alerts;
  const rigs = opts.rigs || RIGS;
  // hw.py and usage.py keep incremental caches under the state dir. Check mode
  // must not write into the repo, so it points them at a throwaway directory.
  const scratchState = opts.readOnly ? fs.mkdtempSync(path.join(os.tmpdir(), "hqconsole-check-")) : cfg.stateDir;
  if (opts.readOnly) {
    // --check writes nothing durable: the scratch dir goes away with the process
    process.on("exit", () => {
      try {
        fs.rmSync(scratchState, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
  }

  reg.register("_ctl", 5, () => src.ctlState(), { internal: true });

  reg.register("sessions", 5, async () => mapSessions(await reg.get("_ctl")));
  reg.register("requests", 5, async () => mapRequests(await reg.get("_ctl")));

  reg.register("ready", 60, async () => {
    const perRig = [];
    const errors = [];
    for (const rig of rigs) {
      try {
        perRig.push({ rig: rig.id, beads: await src.readyBeads(rig) });
      } catch (e) {
        errors.push(`${rig.id}: ${String(e && e.message)}`);
      }
    }
    // one broken rig must not blank the ready list for the other four
    if (errors.length === rigs.length) throw new Error(errors.join("; "));
    return mapReady(perRig);
  });

  reg.register("projects", 60, async () => {
    const ctl = await reg.get("_ctl");
    const ready = reg.has("ready") ? await reg.get("ready").catch(() => []) : [];
    const requests = mapRequests(ctl);
    return mapProjects({ ctl, ready: ready || [], requests, rigs });
  });

  // Calendar: a slow-moving read, so a generous TTL. The wrapper runs it as
  // owner because the Google grant is in owner's home; the console only ever
  // sees the JSON it prints.
  // Not in check mode. Activation runs --check as a health probe, and a probe
  // that reaches out to Google would make a deploy depend on somebody else's
  // service being up. The test that caught this is right to forbid it.
  if (typeof src.calendar === "function" && !opts.readOnly) {
    reg.register("calendar", 300, async () => {
      try {
        return mapCalendar(await src.calendar(14));
      } catch (e) {
        // A calendar that cannot be read is a card saying so, never a failed
        // page: everything else on the console is still true.
        return mapCalendar({ ok: false, reason: String((e && e.message) || e).slice(0, 200) });
      }
    });
  }

  reg.register("machine", 15, async () => {
    const snapshot = mapMachine(await src.hw(scratchState), cfg.host.split(".")[0]);
    // Record the sample on the way past. The collector is already the only
    // thing sampling the box on a timer, so the history costs one append rather
    // than a second poller with its own schedule to drift.
    if (opts.history) opts.history.push(snapshot, new Date().toISOString());
    // Same reason: this is the only thing sampling the box, so the disk and
    // swap floors are checked here rather than by a second timer. A bad
    // threshold read must never take the machine slice down with it.
    try {
      evaluateMachineAlerts(snapshot, alerts, { log: (m) => reg.log(`machine alerts: ${m}`) });
    } catch (e) {
      reg.log(`machine alerts failed: ${String(e && e.message)}`);
    }
    return { ...snapshot, series: opts.history ? opts.history.series() : null };
  });

  reg.register("usage", 60, async () => {
    const tokens = await src.usage(scratchState);
    let plan = {};
    try {
      plan = (await reg.get("_ctl")).usage || {};
    } catch {
      plan = {};
    }
    let orch = null;
    try {
      orch = JSON.parse(fs.readFileSync(path.join(cfg.hqRoot, "state", "orchestrator", "usage.json"), "utf8"));
    } catch {
      orch = null; // no summary yet, or unreadable: the header line is simply absent
    }
    return mapUsage(tokens, plan, orch);
  });

  reg.register("alerts", 30, async () => alerts.list());

  // Stack (design 4.3): expensive (walks every transcript), so a 10-minute TTL
  // and it degrades alone like everything else.
  if (typeof src.stackData === "function") {
    reg.register("stack", 600, async () => mapStack(await src.stackData()));
  }

  if (typeof src.flowData === "function") {
    reg.register("flow", 600, async () => mapFlow(await src.flowData()));
  }

  // Understudy (proposal 26, shadow mode): each fetch IS one predict/grade
  // tick, so a short TTL is what keeps the loop live on this box; the work is
  // retrieval over a few hundred ledger rows, no tokens, no network. A tick
  // appends to state/understudy/, so check mode leaves it unregistered:
  // --check must write nothing durable.
  if (!opts.readOnly && typeof src.understudyData === "function") {
    reg.register("understudy", 120, async () => mapUnderstudy(await src.understudyData()));
  }

  // Services / jobs / automations (design 4.4): the helper bounds each probe
  // at 5 s, so a 30-second TTL keeps the Machines tab honest without load.
  if (typeof src.servicesData === "function") {
    reg.register("services", 30, async () => mapServices(await src.servicesData()));
  }

  // Uptime Kuma monitors (design 4.4): read-only, credential-free.
  if (typeof src.kumaData === "function") {
    reg.register("monitors", 60, async () => src.kumaData());
  }

  // Cloud deploys (design 4.4): Vercel and n8n, each degrading alone. A
  // provider with no token reports "not configured" rather than failing.
  if (typeof src.deploysData === "function") {
    reg.register("deploys", 120, async () => src.deploysData());
  }

  // Money (design 4.5): the day series shares usage.py's incremental cache;
  // the ledger half is in-process, so mutations refresh this collector directly.
  if (opts.money && typeof src.usageSeries === "function") {
    // The rate must never take the money slice down with it: a dead FX API
    // means the tab shows per-currency figures, not an error.
    const orNull = async (fn) => {
      if (typeof fn !== "function") return null;
      try {
        return (await fn()) || null;
      } catch {
        return null;
      }
    };
    reg.register("money", 300, async () => {
      // Due commitments become entries first, so this snapshot already counts them.
      if (opts.money && typeof opts.money.postDue === "function") {
        try {
          await opts.money.postDue();
        } catch {
          /* a failed post never takes the money slice down; the next pass retries */
        }
      }
      return mapMoney(await src.usageSeries(scratchState), opts.money, await orNull(src.fxRate), await orNull(src.openaiCosts), opts.goals || null);
    });
  }

  // Activity (design section 4.1 item 2): ops + git log per rig + asks/answers
  // + alerts in one stream. Each source degrades alone; a rig without git or a
  // missing ops directory drops its own events, never the slice.
  reg.register("activity", 30, async () => {
    const lists = [activityFromOps(readOpsDir(cfg.opsDir))];
    if (typeof src.gitLog === "function") {
      // Concurrent, not sequential: one slow or dead repo costs its own
      // timeout, never the sum of everyone's (lucy review 2026-08-19).
      const logs = await Promise.allSettled(
        rigs.map(async (rig) => {
          const dir = rig.path === "." ? cfg.hqRoot : path.join(cfg.hqRoot, rig.path);
          return activityFromGit(rig.id, await src.gitLog(dir, 15));
        }),
      );
      for (const r of logs) {
        if (r.status === "fulfilled") lists.push(r.value);
        /* a rejected rig has no repo yet, or git timed out: its events only */
      }
    }
    const requests = reg.has("requests") ? await reg.get("requests").catch(() => []) : [];
    lists.push(activityFromRequests(requests || []));
    lists.push(activityFromAlerts(alerts ? alerts.list() : []));
    return mergeActivity(lists);
  });

  // Capri voice ear: its live state (idle|wake|listening|thinking|speaking),
  // written by the ear to state/console/ear-state.json and pushed to the
  // dashboard so the indicator can show Capri as alive. An fs.watch in the
  // server refreshes this on every write for push latency; the 10s TTL is only
  // a fallback so staleness (a dead ear) is noticed even without a file event.
  const earFile = path.join(cfg.stateDir, "console", "ear-state.json");
  reg.register("ear", 10, async () => readEarState(earFile));

  return reg;
}

/** The ear's last-published state, or an offline marker if missing/stale.
 * The ear heartbeats "idle" every ~20s, so a state older than 75s means the
 * ear process is gone, which the indicator renders as offline rather than a
 * misleadingly-alive "idle". */
export function readEarState(file, nowMs) {
  const now = nowMs || Date.now();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "offline", at: null, online: false };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { state: "offline", at: null, online: false };
  }
  const PHASES = new Set(["idle", "wake", "listening", "thinking", "speaking", "muted"]);
  const SPEAKERS = new Set(["yours", "unknown", "enrolling"]);
  const state = PHASES.has(obj.state) ? obj.state : "offline";
  // progress is 0..1 or null. Anything else is dropped rather than clamped: a
  // malformed figure must not become a plausible-looking fill.
  const progress = (typeof obj.progress === "number" && Number.isFinite(obj.progress)
    && obj.progress >= 0 && obj.progress <= 1) ? obj.progress : null;
  const atMs = obj.at ? Date.parse(obj.at) : NaN;
  const age = now - atMs;
  // age >= 0 rejects a future/backward-clock timestamp that would otherwise read
  // as online forever; age < 75s catches a dead ear (it heartbeats every ~20s).
  const online = Number.isFinite(atMs) && age >= 0 && age < 75000 && state !== "offline";
  return {
    state: online ? state : "offline",
    at: obj.at || null,
    text: typeof obj.text === "string" ? obj.text : null,
    progress: online ? progress : null,
    speaker: SPEAKERS.has(obj.speaker) ? obj.speaker : undefined,
    online,
  };
}
