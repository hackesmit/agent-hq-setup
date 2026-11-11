// Pure mappings from v1 shapes (`ctl.sh state`, hw.py, usage.py, bd) into the
// shared/api.ts contract. Kept pure and separate from the collectors so the
// tolerance for missing fields is directly testable: v1 emits empty strings
// where the contract wants null, and whole keys go missing when a sub-tool
// fails, so every reader here defaults rather than throws.

import { BEAD_RIG } from "./protocol.js";
import { judgeBackup, judgeDisk } from "./machineAlerts.js";

const iso = (v) => {
  const s = String(v || "");
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const str = (v) => {
  const s = v === 0 ? "0" : String(v || "");
  return s ? s : null;
};
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Project id for a bead id, e.g. "xd-207" -> "acme-dashboard". */
/** Only http(s) links reach the page; anything else (javascript:, data:, file:) is dropped. */
function safeLink(v) {
  const s = str(v);
  if (!s) return null;
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
}
export function rigOfBead(bead) {
  const id = String(bead || "");
  const pre = id.split("-")[0];
  return BEAD_RIG[pre] || null;
}

const SESSION_STATE = {
  active: "running",
  done: "closed",
  // not a status the registry writes, but one row (s-2404) carries it, and an
  // unknown status falls through to idle: a card for a session long gone
  closed: "closed",
  exited: "closed",
  snoozed: "snoozed",
  finishable: "finishable",
  idle: "idle",
};

// How long an "active" claim is believed without a heartbeat.
//
// A registry row records what a session last SAID about itself. A session that
// is killed, or whose machine goes away, never gets to say it stopped, so the
// row stays "active" forever. The registry has a reaper, but it runs only when a
// new session starts and it fails open: if it cannot list the panes it prunes
// nothing and reports success. So the console found 34 rows claiming to be live
// of which 33 had not been heard from in six days.
//
// The console therefore treats "active" as a claim with an expiry. Generous
// enough that a session genuinely sitting on a long build is never hidden;
// short enough that a corpse stops being counted as a colleague.
const SESSION_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * @param {any} ctl raw `ctl.sh state` JSON
 * @param {number} [now] injected clock, for tests
 * @returns {import("../../shared/api.js").Session[]}
 */
export function mapSessions(ctl, now = Date.now()) {
  const st = obj(ctl);
  const phases = obj(st.phases);
  // a session with an open question is "waiting on you", which the registry
  // does not record: it lives in the request board. Only "open" counts: once
  // the owner has answered, the request is the session's to collect, not his to
  // answer, and a session that never collects it (he answered in the terminal
  // too) otherwise showed "needs you: question" forever while it worked.
  const waiting = new Set(
    arr(st.requests)
      .filter((r) => String(obj(r).status || "open") === "open")
      .map((r) => String(obj(r).session || ""))
      .filter(Boolean),
  );
  const turns = obj(st.turns);
  return arr(st.terminals).map((raw) => {
    const t = obj(raw);
    const id = String(t.id || "");
    const bead = str(t.bead);
    const kindRaw = String(t.kind || "");
    const kind = kindRaw === "worker" ? "worker" : kindRaw === "meta" ? "meta" : "interactive";
    let state = SESSION_STATE[String(t.status || "")] || "idle";
    if (t.pane_dead && state === "running") state = "closed";
    // A worker whose process exited has finished its bead and waits for review
    // and finish.sh: that is an action, not a dead terminal (ctl marks it exited).
    if (kindRaw === "worker" && (t.pane_dead || String(t.status || "") === "exited") && state === "closed") state = "finishable";
    // Silence is the signal: no heartbeat inside the window means the row is a
    // corpse whatever it claims. Only "running" expires -- a snoozed session is
    // meant to be quiet, and a closed one is already closed.
    const heardAt = Date.parse(iso(t.last_seen) || "");
    // A pane tmux lists alive is a quiet terminal, not a corpse: it stays a card
    // (the server drops closed rows, so aging it out would hide a live terminal).
    if (state === "running" && !t.pane_live && Number.isFinite(heardAt) && now - heardAt > SESSION_STALE_MS) state = "closed";
    // An idle session with an open question is waiting too: its card carries the
    // waiting mark, since there is no Needs-you panel to find the question in.
    if ((state === "running" || state === "idle") && waiting.has(id)) state = "waiting";
    const ph = obj(phases[bead || ""]);
    return {
      id,
      kind,
      rig: str(t.rig) || str(t.derived_rig),
      bead,
      model: str(t.model),
      branch: str(t.branch),
      worktree: str(t.worktree),
      state,
      startedAt: iso(t.started) || new Date(0).toISOString(),
      lastActivityAt: iso(t.last_seen),
      phases: arr(ph.phases).map((p) => ({ name: String(obj(p).name || ""), done: Boolean(obj(p).done) })),
      wakeAt: t.wake_at ? iso(new Date(num(t.wake_at) * 1000).toISOString()) || iso(t.wake_at) : null,
      runner: "tmux",
      // a console terminal is the runner's to kill even while the runner is down (hq-je3fk.5)
      consoleTerm: kindRaw === "console-term",
      // Focus selects a tmux PANE on the box. A session with no pane (a terminal
      // this console started, which the runner owns) cannot be focused at all,
      // and offering the control anyway is a button guaranteed to fail. It is
      // also worth being clear that focusing helps only at the machine: from a
      // browser it moves something you are not looking at.
      focusable: /^%[0-9]+$/.test(String(t.tmux_window || "")),
      attachable: false, // P1.2/P1.3 turn this on with the runner
      writable: false,
      name: str(t.name),
      task: str(t.derived_task),
      ...turnOf(obj(turns[id])),
    };
  });
}

/** A turns entry from ctl state, or nulls: only the three known values pass. */
function turnOf(rec) {
  const turn = rec.turn === "working" || rec.turn === "idle" || rec.turn === "background" ? rec.turn : null;
  return { turn, turnAt: turn ? iso(rec.at) : null };
}

const REQ_STATE = {
  open: "open",
  answered: "answered",
  revival_claimed: "revival_claimed",
  delivered: "delivered",
  resolved: "resolved",
  cancelled: "cancelled",
};

/**
 * @param {any} ctl raw `ctl.sh state` JSON
 * @param {number} [nowMs]
 */
export function mapRequests(ctl, nowMs = Date.now()) {
  const st = obj(ctl);
  const one = (raw, snoozed) => {
    const r = obj(raw);
    const created = iso(r.ts);
    const kindRaw = String(r.kind || "");
    const kind = ["run", "decide", "login", "info", "autofix", "keep-or-revert"].includes(kindRaw)
      ? kindRaw
      : r.cmd
        ? "run"
        : "decide";
    const sev = ["P0", "P1", "P2"].includes(String(r.sev || r.severity || ""))
      ? String(r.sev || r.severity)
      : r.urgent
        ? "P0"
        : "P1";
    return {
      id: String(r.id || ""),
      kind,
      severity: sev,
      state: snoozed ? "snoozed" : REQ_STATE[String(r.status || "open")] || "open",
      rig: str(r.rig) === "unassigned" ? rigOfBead(r.bead) : str(r.rig) || rigOfBead(r.bead),
      bead: str(r.bead),
      session: str(r.session),
      createdAt: created || new Date(nowMs).toISOString(),
      ageSeconds: created ? Math.max(0, Math.round((nowMs - new Date(created).getTime()) / 1000)) : 0,
      question: String(r.question || ""),
      command: str(r.cmd || r.command),
      link: safeLink(r.link),
      why: str(r.why),
      answer: str(r.answer),
      settledAt: iso(r.answered_ts) || iso(r.resolved_ts) || iso(r.cancelled_ts) || null,
      snoozedUntil: iso(r.snooze_until),
      meta: obj(r.meta),
      // Ask routing (hq-4npjr.1): "orchestrator" while the orchestrator holds it,
      // "owner" once forwarded; null on every request written before routing existed.
      to: str(r.to),
      forwardClass: str(r.forward_class),
    };
  };
  return [...arr(st.requests).map((r) => one(r, false)), ...arr(st.snoozed).map((r) => one(r, true))];
}

/**
 * @param {{rig: string, beads: any[]}[]} perRig
 * @returns {import("../../shared/api.js").ReadyBead[]}
 */
export function mapReady(perRig) {
  const out = [];
  for (const entry of arr(perRig)) {
    const e = obj(entry);
    const rig = String(e.rig || "");
    for (const raw of arr(e.beads)) {
      const b = obj(raw);
      if (!b.id) continue;
      const labels = arr(b.labels).map(String);
      out.push({
        rig,
        id: String(b.id),
        title: String(b.title || ""),
        priority: num(b.priority, 3),
        labels,
        // What KIND of thing this is, which decides whether it belongs in a list
        // of work you might hand to a worker at all. An epic is a container and a
        // decision is waiting on the owner; neither is dispatchable, and both were
        // being listed as though they were.
        kind: String(b.issue_type || b.kind || "task"),
        due: iso(b.due || b.due_at),
        estimateMin: b.estimate == null ? null : num(b.estimate, 0) || null,
        model: modelFromDescription(b.description) || null,
      });
    }
  }
  out.sort((a, b) => a.priority - b.priority || a.rig.localeCompare(b.rig) || a.id.localeCompare(b.id));
  return out;
}

/** Beads carry "Model: opus-4-8" in the template body; surface it for dispatch. */
export function modelFromDescription(desc) {
  const m = String(desc || "").match(/^\s*Model:\s*([A-Za-z0-9._-]{1,40})\s*$/m);
  if (!m) return null;
  const v = m[1].toLowerCase();
  return v.startsWith("claude-") ? v : `claude-${v}`;
}

/**
 * @param {{ctl: any, ready: any[], requests: any[], rigs: {id: string, name: string, kind: string}[]}} input
 * @returns {import("../../shared/api.js").ProjectSummary[]}
 */
export function mapProjects(input) {
  const ctl = obj(obj(input).ctl);
  const tasks = obj(ctl.tasks);
  const ready = arr(obj(input).ready);
  const requests = arr(obj(input).requests);
  const rigs = arr(obj(input).rigs);
  const ids = new Set([...rigs.map((r) => String(obj(r).id)), ...Object.keys(tasks)]);
  const out = [];
  for (const id of ids) {
    if (!id) continue;
    const declared = rigs.find((r) => String(obj(r).id) === id);
    const t = obj(tasks[id]);
    const beads = arr(t.beads);
    const counts = { open: 0, inProgress: 0, blocked: 0, closed7d: 0 };
    for (const raw of beads) {
      const s = String(obj(raw).status || "");
      if (s === "open") counts.open += 1;
      else if (s === "in_progress") counts.inProgress += 1;
      else if (s === "blocked") counts.blocked += 1;
    }
    const needsYou = requests.filter((r) => obj(r).rig === id && obj(r).state === "open").length;
    const next = ready.find((b) => obj(b).rig === id) || null;
    const attention =
      needsYou > 0 ? "needs-you" : counts.blocked > 0 ? "blocked" : counts.open + counts.inProgress > 0 ? "ok" : "quiet";
    out.push({
      id,
      name: declared ? String(obj(declared).name || id) : id,
      kind: declared ? String(obj(declared).kind || "rig") : "rig",
      status: "active",
      goal: null,
      targetDate: null,
      counts,
      // The placeholder mapper has no git or bd series behind it, so it declares an
      // empty month rather than inventing one. The SOURCE still has to match what the
      // real collector would pick, or the caption on a checkout-backed project reads
      // "0 beads closed" for something that is measured in commits.
      activity30d: new Array(30).fill(0),
      activitySource: declared ? "commits" : "beads",
      activityTruncated: false,
      lastMergeAt: null,
      lastDeploy: null,
      needsYou,
      nextUp: next ? { id: String(obj(next).id), title: String(obj(next).title || "") } : null,
      attention,
    });
  }
  const rank = { "needs-you": 0, blocked: 1, late: 2, ok: 3, quiet: 4 };
  out.sort((a, b) => (rank[a.attention] ?? 9) - (rank[b.attention] ?? 9) || a.id.localeCompare(b.id));
  return out;
}

const MB = 1024 * 1024;

/** A figure a report may simply not carry: null stays null instead of becoming 0. */
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const strOrNull = (v) => (typeof v === "string" && v !== "" ? v.slice(0, 40) : null);

/**
 * The two root-written health reports hw.py passes through (snake_case, as the
 * shell jobs write them) -> MachineHealth, each with its verdict attached.
 * @returns {import("../../shared/api.js").MachineHealth}
 */
export function mapHealth(raw, now = Date.now()) {
  const h = obj(raw);
  let disk = null;
  if (h.disk && typeof h.disk === "object" && !Array.isArray(h.disk)) {
    const d = h.disk;
    const figures = {
      at: strOrNull(d.at),
      device: String(d.device || "").slice(0, 40),
      model: String(d.model || "").slice(0, 60),
      passed: typeof d.passed === "boolean" ? d.passed : null,
      tempC: numOrNull(d.temp_c),
      usedPct: numOrNull(d.used_pct),
      sparePct: numOrNull(d.spare_pct),
      spareThresholdPct: numOrNull(d.spare_threshold_pct),
      powerOnHours: numOrNull(d.power_on_hours),
      unsafeShutdowns: numOrNull(d.unsafe_shutdowns),
      mediaErrors: numOrNull(d.media_errors),
    };
    disk = { ...judgeDisk(figures, now), ...figures };
  }
  let backup = null;
  if (h.backup && typeof h.backup === "object" && !Array.isArray(h.backup)) {
    const b = h.backup;
    const figures = {
      target: String(b.target || "").slice(0, 40),
      lastSuccessAt: strOrNull(b.last_success_at),
      lastAttemptAt: strOrNull(b.last_attempt_at),
      lastResult: String(b.last_result || "").slice(0, 120),
    };
    backup = { ...judgeBackup(figures, now), ...figures };
  }
  return { disk, backup };
}

/**
 * @param {any} hw hw.py JSON
 * @returns {import("../../shared/api.js").MachineSnapshot}
 */
export function mapMachine(hw, host = "hqbox") {
  const h = obj(hw);
  const cpu = obj(h.cpu);
  const mem = obj(h.mem);
  const swap = obj(h.swap);
  const load = arr(cpu.load).map((n) => num(n));
  return {
    host,
    uptimeS: num(h.uptime_s),
    cpuPct: num(cpu.pct),
    cores: num(cpu.cores),
    load: [load[0] || 0, load[1] || 0, load[2] || 0],
    mem: {
      totalMb: Math.round(num(mem.total) / MB),
      usedMb: Math.round(num(mem.used) / MB),
      pct: num(mem.pct),
    },
    swap: {
      totalMb: Math.round(num(swap.total) / MB),
      usedMb: Math.round(num(swap.used) / MB),
      pct: num(swap.pct),
    },
    tempC: h.temp_max == null ? null : num(h.temp_max, 0),
    disks: arr(h.disks).map((raw) => {
      const d = obj(raw);
      return {
        mount: String(d.mount || ""),
        totalGb: Math.round((num(d.total) / (1024 * 1024 * 1024)) * 10) / 10,
        freeGb: Math.round((num(d.free) / (1024 * 1024 * 1024)) * 10) / 10,
        pct: num(d.pct),
      };
    }),
    topRss: arr(h.procs)
      .slice(0, 10)
      .map((raw) => {
        const p = obj(raw);
        return { pid: num(p.pid), name: String(p.cmd || p.name || ""), rssMb: Math.round(num(p.rss) / MB) };
      }),
    cpuSeries24h: arr(h.cpu_series).map((n) => num(n)), // hw.py has no ring buffer yet (P2.3)
    health: mapHealth(h.health),
  };
}

const orchWindow = (w) => {
  const o = obj(w);
  return {
    calls: num(o.calls),
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
    costUsd: num(o.costUsd),
    models: arr(o.models).map(obj).filter((m) => str(m.model)).slice(0, 8).map((m) => ({
      model: str(m.model).slice(0, 60),
      calls: num(m.calls),
      inputTokens: num(m.inputTokens),
      outputTokens: num(m.outputTokens),
      costUsd: num(m.costUsd),
    })),
  };
};

/** orch_usage.py's usage.json -> OrchestratorUsage, or null when absent or not an object. */
export function mapOrchUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = obj(raw);
  return {
    today: orchWindow(o.today),
    week: orchWindow(o.week),
    shareOfHq: typeof o.shareOfHq === "number" && Number.isFinite(o.shareOfHq) ? o.shareOfHq : null,
    threshold: num(o.threshold),
    planWeeklyPct: typeof o.planWeeklyPct === "number" && Number.isFinite(o.planWeeklyPct) ? o.planWeeklyPct : null,
    at: str(o.at) ? str(o.at).slice(0, 30) : "",
  };
}

/**
 * @param {any} tokens usage.py JSON
 * @param {any} plan `ctl state`.usage (plan window)
 * @param {any} [orch] state/orchestrator/usage.json (orch_usage.py), or null
 * @returns {import("../../shared/api.js").UsageSummary}
 */
export function mapUsage(tokens, plan, orch = null) {
  const t = obj(tokens);
  const today = obj(t.today);
  const week = obj(t.week);
  const p = obj(plan);
  const models = obj(week.models && Object.keys(obj(week.models)).length ? week.models : today.models);
  return {
    tokensToday: num(today.output) + num(today.input) + num(today.cache_read) + num(today.cache_write),
    tokensWeek: num(week.output) + num(week.input) + num(week.cache_read) + num(week.cache_write),
    outputTokensToday: num(today.output),
    byModelWeek: Object.keys(models).map((model) => ({
      model,
      input: 0,
      output: num(models[model]),
      cacheRead: 0,
    })),
    sessionsToday: num(today.sessions),
    orchestrator: mapOrchUsage(orch),
    // Per-project attribution over usage.py's own window. Bounded and coerced
    // like everything else here: this arrives from a subprocess, and a row
    // whose project is empty is dropped rather than rendered as a blank card.
    byProject: arr(t.byProject)
      .map(obj)
      .filter((r) => str(r.project))
      .slice(0, 40)
      .map((r) => ({
        project: str(r.project).slice(0, 60),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        cacheReadTokens: num(r.cacheReadTokens),
        cacheWriteTokens: num(r.cacheWriteTokens),
        costUsd: num(r.costUsd),
        sessions: num(r.sessions),
      })),
    byProjectDays: num(t.byProjectDays) || 30,
    planUsage: {
      fiveHourPct: p.pct == null ? null : num(p.pct),
      weeklyPct: p.weekly_pct == null ? null : num(p.weekly_pct),
      limits: arr(p.limits)
        .map(obj)
        .slice(0, 12)
        .map((l) => ({
          kind: (str(l.kind) ?? "").slice(0, 40),
          label: (str(l.label) ?? "").slice(0, 40) || (str(l.kind) ?? "").slice(0, 40),
          percent: typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : null,
          severity: (str(l.severity) ?? "").slice(0, 20),
          resetsAt: str(l.resets_at) ? str(l.resets_at).slice(0, 40) : null,
          active: l.active === true,
        })),
      updatedAt: str(p.updated) ? str(p.updated).slice(0, 40) : null,
      error: p.error ? String(p.error).slice(0, 160) : null,
    },
  };
}

const STACK_KINDS = new Set(["tool", "cli", "skill", "hook", "mcp", "mcp-profile", "agent", "domain", "automation"]);
const STACK_VERDICTS = new Set(["value", "friction", "low-use", "unused", "stale", "quiet"]);

/** flow.py output -> FlowReport. Defensive: the collector runs as owner. */
export function mapFlow(raw) {
  const r = obj(raw);
  const maybe = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const win = (w) => {
    const o = obj(w);
    return {
      closed: num(o.closed),
      medianLeadS: maybe(o.medianLeadS),
      p90LeadS: maybe(o.p90LeadS),
      blockedShare: maybe(o.blockedShare),
      reopened: num(o.reopened),
      reworkShare: maybe(o.reworkShare),
    };
  };
  const rigs = arr(r.rigs)
    .slice(0, 40)
    .map(obj)
    .filter((x) => x.rig)
    .map((x) => ({
      rig: String(x.rig).slice(0, 60),
      windows: {
        7: win(obj(x.windows)["7"]),
        30: win(obj(x.windows)["30"]),
        90: win(obj(x.windows)["90"]),
      },
      weekly: arr(x.weekly)
        .slice(0, 12)
        .map(obj)
        .map((wk) => ({
          weekStart: String(wk.weekStart || "").slice(0, 10),
          medianLeadS: maybe(wk.medianLeadS),
          closed: num(wk.closed),
        })),
    }));
  return { generatedAt: iso(r.generatedAt) || new Date().toISOString(), rigs };
}

/** understudy report output -> UnderstudyReport. Defensive: the collector runs
 * as owner. Scores are null rather than 0 until anything is actually graded,
 * so the card can say "waiting" instead of claiming a perfect Brier. */
export function mapUnderstudy(raw) {
  const r = obj(raw);
  const maybe = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const corpus = obj(r.corpus);
  const live = obj(r.live);
  const bt = obj(r.backtest);
  const graded = num(live.graded);
  const btN = num(bt.n);
  return {
    generatedAt: iso(r.generatedAt) || new Date().toISOString(),
    corpus: { total: num(corpus.total), answered: num(corpus.answered), open: num(corpus.open) },
    live: {
      stamped: num(live.stamped),
      graded,
      abstentions: num(live.abstentions),
      accuracy: graded ? maybe(live.accuracy) : null,
      brier: graded ? maybe(live.brier) : null,
      skill: graded ? maybe(live.skill) : null,
    },
    backtest: {
      n: btN,
      coverage: maybe(bt.coverage) ?? 0,
      accuracy: btN ? maybe(bt.accuracy) : null,
      brier: btN ? maybe(bt.brier) : null,
      skill: btN ? maybe(bt.skill) : null,
    },
    history: arr(r.history)
      .slice(-120)
      .map(obj)
      .map((p) => ({
        ts: iso(p.ts) || "",
        answered: num(p.answered),
        stamped: num(p.stamped),
        graded: num(p.graded),
        accuracy: maybe(p.accuracy),
        brier: maybe(p.brier),
        skill: maybe(p.skill),
      })),
  };
}

/** stack.py output -> StackReport. Defensive: the collector runs as owner. */
export function mapStack(raw) {
  const r = obj(raw);
  const win = (w) => ({ uses: num(obj(w).uses), sessions: num(obj(w).sessions), errors: num(obj(w).errors) });
  const items = arr(r.items)
    .slice(0, 400)
    .map(obj)
    .filter((it) => it.id && it.name)
    .map((it) => ({
      id: str(it.id).slice(0, 120),
      name: str(it.name).slice(0, 80),
      kind: STACK_KINDS.has(it.kind) ? it.kind : "tool",
      windows: {
        7: win(obj(it.windows)["7"]),
        30: win(obj(it.windows)["30"]),
        90: win(obj(it.windows)["90"]),
      },
      lastUsed: iso(it.lastUsed),
      unstamped: num(it.unstamped),
      blocks90: num(it.blocks90),
      topBlockReason: it.topBlockReason == null ? null : str(it.topBlockReason).slice(0, 160),
      tokens90: num(it.tokens90),
      inventory: Boolean(it.inventory),
      stale: it.stale == null ? null : str(it.stale).slice(0, 200),
      detail: it.detail == null ? null : str(it.detail).slice(0, 200),
      acquisitions: arr(it.acquisitions)
        .slice(0, 5)
        .map(obj)
        .filter((a) => a.id)
        .map((a) => ({ id: str(a.id).slice(0, 40), title: str(a.title).slice(0, 120) })),
      verdictHint: STACK_VERDICTS.has(it.verdictHint) ? it.verdictHint : "quiet",
    }));
  return {
    generatedAt: iso(r.generatedAt) || new Date().toISOString(),
    windows: [7, 30, 90],
    items,
  };
}

const SERVICE_KINDS = new Set(["systemd-user", "systemd-system", "docker", "tmux"]);
const JOB_STATES = new Set(["ok", "stale", "missing", "malformed", "future"]);

/** services.py output -> ServicesReport. Defensive like everything crossing the wrapper. */
export function mapServices(raw) {
  const r = obj(raw);
  const services = arr(r.services)
    .slice(0, 100)
    .map(obj)
    .filter((s) => s.id)
    .map((s) => ({
      id: str(s.id).slice(0, 40),
      label: str(s.label || s.id).slice(0, 80),
      kind: SERVICE_KINDS.has(s.kind) ? s.kind : "systemd-user",
      unit: str(s.unit).slice(0, 80),
      restartable: Boolean(s.restartable),
      logs: Boolean(s.logs),
      state: str(s.state || "unknown").slice(0, 30),
      detail: s.detail == null ? null : str(s.detail).slice(0, 160),
      since: s.since == null ? null : str(s.since).slice(0, 40),
      restarts: num(s.restarts),
    }));
  const jobs = arr(r.jobs)
    .slice(0, 100)
    .map(obj)
    .filter((j) => j.id)
    .map((j) => ({
      id: str(j.id).slice(0, 40),
      label: str(j.label || j.id).slice(0, 80),
      kind: str(j.kind || "loop").slice(0, 20),
      heartbeat: str(j.heartbeat).slice(0, 200),
      source: str(j.source || "mtime").slice(0, 50),
      cadenceS: num(j.cadenceS),
      lastRun: iso(j.lastRun),
      state: JOB_STATES.has(j.state) ? j.state : "malformed",
      missed: Boolean(j.missed),
      detail: j.detail == null ? null : str(j.detail).slice(0, 160),
    }));
  const mail = obj(obj(r.automations).mail);
  return {
    generatedAt: iso(r.generatedAt) || new Date().toISOString(),
    services,
    servicesError: r.servicesError == null ? null : str(r.servicesError).slice(0, 200),
    jobs,
    jobsError: r.jobsError == null ? null : str(r.jobsError).slice(0, 200),
    automations: {
      mail: {
        flags: { disabled: Boolean(obj(mail.flags).disabled), logOnly: Boolean(obj(mail.flags).logOnly) },
        heartbeats: arr(mail.heartbeats)
          .slice(0, 30)
          .map(obj)
          .map((h) => ({
            id: str(h.id).slice(0, 40),
            cadenceS: h.cadenceS == null ? null : num(h.cadenceS),
            lastRun: iso(h.lastRun),
            state: str(h.state || "missing").slice(0, 20),
          })),
        recentRuns: arr(mail.recentRuns)
          .slice(0, 5)
          .map(obj)
          .map((x) => ({ file: str(x.file).slice(0, 60), tail: str(x.tail).slice(0, 500) })),
      },
    },
  };
}

/** usage.py --days output + the ledger -> MoneyReport. */
/**
 * Agent effort per project, for attributing a client's cost.
 *
 * The usage series is per day and per project when the collector can tell them
 * apart. When it cannot, this returns nothing rather than dividing the total up:
 * a made-up split is worse than an honest blank, because it looks like a fact.
 */
function effortByProject(usageRaw) {
  const u = obj(usageRaw);
  const byProject = new Map();
  for (const row of arr(u.byProject ?? u.by_project)) {
    const r = obj(row);
    const id = str(r.project ?? r.id ?? r.rig);
    if (!id) continue;
    const prev = byProject.get(id) || { tokens: 0, sessions: 0 };
    byProject.set(id, {
      tokens: prev.tokens + num(r.tokens ?? num(r.input) + num(r.output)),
      sessions: prev.sessions + num(r.sessions),
    });
  }
  if (byProject.size === 0) return null;
  return (project) => byProject.get(project) || { tokens: 0, sessions: 0 };
}

export function mapMoney(usageRaw, ledger, fx = null, apiSpend = null, goals = null) {
  const u = obj(usageRaw);
  const series = arr(u.series)
    .slice(-120)
    .map(obj)
    .filter((d) => d.day)
    .map((d) => ({
      day: str(d.day).slice(0, 10),
      input: num(d.input),
      output: num(d.output),
      cacheRead: num(d.cache_read ?? d.cacheRead),
      sessions: num(d.sessions),
    }));
  return {
    generatedAt: new Date().toISOString(),
    rangeDays: series.length,
    series,
    ledger: ledger ? ledger.visible() : [],
    totals: ledger ? ledger.totals() : [],
    // What repeats, what it commits to per month, what actually moved, and what
    // each client is worth. Held apart from `totals` on purpose: a forecast and a
    // record of movement are different questions and must not add together.
    commitments: ledger ? ledger.liveCommitments() : [],
    runRate: ledger ? ledger.runRate() : [],
    flows: ledger ? ledger.flows() : [],
    clients: ledger ? ledger.clients(effortByProject(usageRaw)) : [],
    // Targets to measure the above against. Yardsticks, never money: the web
    // computes each goal's progress from the ledger rows it already has.
    goals: goals ? goals.list() : [],
    // Display metadata only. Every figure above stays per-currency and exact;
    // the web folds USD into MXN at render time using this rate and says so.
    // Null means no rate has ever been obtained and the tab stays per-currency.
    fx:
      fx && Number.isFinite(Number(fx.mxnPerUsd))
        ? { base: "MXN", mxnPerUsd: Number(fx.mxnPerUsd), asOf: str(fx.asOf).slice(0, 10), stale: Boolean(fx.stale) }
        : null,
    // Live Codex/OpenAI spend, read from the org costs API, not from the
    // ledger. Kept apart from the ledger figures for the same reason the run
    // rate is: they answer different questions, and the invoice the owner may
    // later record for the same spend must not silently double-count it.
    apiSpend: apiSpend
      ? {
          source: "openai",
          configured: Boolean(apiSpend.configured),
          currency: "USD",
          days: arr(apiSpend.days)
            .map(obj)
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(str(d.day)) && Number.isInteger(d.cents) && d.cents >= 0)
            .map((d) => ({ day: str(d.day), cents: d.cents })),
          monthCents: Number.isInteger(apiSpend.monthCents) && apiSpend.monthCents >= 0 ? apiSpend.monthCents : 0,
          error: apiSpend.error == null ? null : str(apiSpend.error).slice(0, 120),
        }
      : null,
  };
}

const SEV_RANK = { P0: 0, P1: 1, P2: 2 };

/** How long the orchestrator may hold an ask before the owner sees it anyway (design 1). */
export const ORCH_HOLD_S = 600;
const LIVE_STATES = new Set(["running", "waiting", "idle"]);

/** The live orchestrator chat session: the one named "orchestrator". */
export function liveOrchestrator(sessions) {
  return arr(sessions).find((x) => String(obj(x).name || "").trim().toLowerCase() === "orchestrator" && LIVE_STATES.has(obj(x).state)) || null;
}

/**
 * True while an ask is the orchestrator's to answer and so hidden from the owner.
 * Fail-closed: a missing or dead orchestrator, or an ask older than ten minutes,
 * shows on the owner's card as before. Mirrored in web/src/now/orchestrator.ts.
 */
export function orchestratorHolds(request, sessions, nowMs = Date.now()) {
  const r = obj(request);
  if (r.to !== "orchestrator" || r.state !== "open") return false;
  const created = Date.parse(String(r.createdAt || ""));
  if (!Number.isFinite(created) || nowMs - created >= ORCH_HOLD_S * 1000) return false;
  return liveOrchestrator(sessions) !== null;
}

/** Tab badges: counts plus the highest severity waiting in Now. */
export function computeBadges(state, nowMs = Date.now()) {
  const s = obj(state);
  const open = arr(s.requests).filter((r) => obj(r).state === "open" && !orchestratorHolds(r, s.sessions, nowMs));
  let sev = null;
  for (const r of open) {
    const cur = String(obj(r).severity || "P2");
    if (sev === null || (SEV_RANK[cur] ?? 2) < (SEV_RANK[sev] ?? 2)) sev = cur;
  }
  const blocked = arr(s.projects).reduce((n, p) => n + num(obj(obj(p).counts).blocked), 0);
  const alerts = arr(s.alerts).filter((a) => obj(a).severity !== "P2").length;
  // Stack badge: items needing a keep/revert decision (unused or stale, and
  // nothing filed on them yet).
  const stackPending = arr(obj(s.stack).items).filter(
    (it) => ["unused", "stale"].includes(obj(it).verdictHint) && arr(obj(it).acquisitions).length === 0,
  ).length;
  // Machines badge: alert cards plus concretely failing services and missed jobs.
  const failing = arr(obj(s.services).services).filter((x) =>
    ["failed", "unavailable"].includes(obj(x).state),
  ).length;
  const missedJobs = arr(obj(s.services).jobs).filter((j) => obj(j).missed).length;
  return {
    now: open.length,
    nowSeverity: sev,
    projects: blocked,
    stack: stackPending,
    machines: alerts + failing + missedJobs,
  };
}

/**
 * The upcoming calendar, shaped for the console.
 *
 * Everything here is validated rather than trusted: this is the one collector
 * whose input comes from outside the box, so an event title is somebody else's
 * text and a link is somebody else's URL. Lengths are bounded, the response is
 * pinned to the set Google actually uses, and a link that is not plainly an https
 * URL is dropped rather than rendered as one.
 */
export function mapCalendar(raw) {
  /** A bounded string, and "" rather than null, since these are rendered directly. */
  const cut = (v, n) => String(v || "").slice(0, n);
  const r = obj(raw);
  if (r.ok === false) {
    return { ok: false, reason: str(r.reason).slice(0, 200), generatedAt: new Date().toISOString(), events: [] };
  }
  const RESPONSES = new Set(["accepted", "declined", "tentative", "needsAction"]);
  const events = arr(r.events)
    .map(obj)
    .filter((e) => e.startsAt)
    .map((e) => ({
      // str() answers null for an absent field, so every one of these is bounded
      // through a helper rather than by chaining slice onto a maybe-null.
      id: cut(e.id, 120),
      title: cut(e.title, 200) || "(no title)",
      startsAt: str(e.startsAt) || "",
      endsAt: str(e.endsAt) || "",
      allDay: Boolean(e.allDay),
      response: RESPONSES.has(String(e.response)) ? String(e.response) : null,
      // Only an https link is a meeting link. Anything else is not rendered as
      // one, because this string arrived from an invitation somebody else wrote.
      meetLink: /^https:\/\//.test(String(e.meetLink || "")) ? cut(e.meetLink, 500) : null,
      organizer: cut(e.organizer, 120),
      location: cut(e.location, 160),
    }))
    .slice(0, 50);
  return { ok: true, reason: null, generatedAt: iso(r.generatedAt) || new Date().toISOString(), events };
}

/** Invitations that arrived and were never answered: the thing worth a nudge. */
export function unanswered(report) {
  return arr(obj(report).events).filter((e) => obj(e).response === "needsAction");
}
