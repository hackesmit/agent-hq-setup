// HQ Console v2 server: wiring.
//
// Production: binds only the box's tailnet IPv4, TLS from the tailscale cert
// with hot reload, every connection gated by a tailscale whois owner check with
// self-peer refusal, Host pinned to CONSOLE_HOST, per-boot CSRF key on POST,
// one-use tokens for the WebSocket. Development (CONSOLE_DEV_NOAUTH=1): plain
// HTTP on loopback, no whois, everything else identical.
//
// Design: docs/superpowers/specs/2026-08-17-console-v2-design.md sections 3-6.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import https from "node:https";
import tlsMod from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allowedOrigins, loadConfig } from "./config.js";
import { Auth, certVerdict } from "./auth.js";
import { Csrf } from "./csrf.js";
import { Alerts } from "./alerts.js";
import { Collectors, registerAll } from "./collectors.js";
import { computeBadges, liveOrchestrator, mapRequests, mapSessions } from "./map.js";
import { BadRequest, Ops, buildVerbs, runVerb } from "./actions.js";
import { firstJson } from "./exec.js";
import { StaticServer } from "./static.js";
import { Wrapper } from "./wrapper.js";
import { WsLayer, createTokens } from "./ws.js";
import { RunnerClient, attachTermHandlers, sessionsFromRunner } from "./runner-client.js";
import { MetaInjectConsumer } from "./meta-inject.js";
import { CapriSay, FRAME_MAX_BYTES, capriManifest, capriMessage, parseCapriEvent, readCapriFrame, removeCapriFrame, saveCapriFrame } from "./capri.js";
import { PasskeyGate, PasskeyStore } from "./passkey.js";
import { createUploads } from "./upload/index.js";
import { Ledger } from "./money.js";
import { Goals } from "./goals.js";
import { History } from "./history.js";
import { listArtifacts } from "./artifacts.js";
import { LoadedFiles, chatModel, loadRoute, orchestratorReport, orchestratorSeed } from "./orchestrator.js";
import { Notes, NotesError } from "./notes.js";
import { Seen, SeenError } from "./seen.js";
import { Reports, ReportsError } from "./reports.js";
import {
  assumptionCards,
  auditTruths,
  loadTruthsKey,
  parseAuditHead,
  parseAuditLines,
  registerProjectCollectors,
  projectRoutes,
  terminalDir,
} from "./projects/index.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { Seals } from "./seal.js";
import { createErrors, emptySource } from "./errors.js";

/** The model a terminal opened from the console starts on. */
const TERMINAL_MODEL = "claude-opus-5-5";

const SLICES = ["sessions", "requests", "ready", "projects", "machine", "usage", "alerts", "activity", "stack", "flow", "understudy", "services", "money", "monitors", "deploys", "calendar", "discovered", "ear", "board", "errors"];
const SESSION_VERBS = new Set(["focus", "snooze", "wake", "kill", "finish", "finish-check", "name"]);
const BODY_LIMIT = 256 * 1024;

function sendJson(res, code, body, extraHeaders) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

/** Merge the runner's per-session view onto ctl's rows (runner never overwrites kind/state). */
function mergeRunnerSessions(rows, fromRunner) {
  const byId = new Map(fromRunner.map((r) => [r.id, r]));
  const byPane = new Map(fromRunner.filter((r) => r.pane).map((r) => [r.pane, r]));
  const out = rows.map((s) => {
    const r = byId.get(s.id) || (s.tmuxWindow ? byPane.get(s.tmuxWindow) : null);
    if (!r) return { ...s, attachable: s.attachable ?? false, writable: s.writable ?? false };
    // For a PTY the runner itself holds (matched by sid, not pane), the runner
    // is the liveness authority: registry heartbeats go stale on long-lived
    // interactive terminals, and a dead PTY must not keep a running card.
    let state = s.state;
    let wakeAt = s.wakeAt;
    if (r.runner === "pty" && byId.has(s.id)) {
      if (r.snoozedUntil) {
        state = "snoozed";
        wakeAt = r.snoozedUntil;
      } else {
        if (r.alive && (state === "closed" || state === "snoozed")) state = "running";
        if (!r.alive && (state === "running" || state === "idle" || state === "waiting")) state = "closed";
      }
    }
    return { ...s, state, wakeAt, runner: r.runner, attachable: r.attachable, writable: r.writable };
  });
  // Runner-only sessions (interactive PTYs spawned from the console, and Capri)
  // appear as their own rows: they have no ctl registry entry, so without this the
  // console could start a session it could never show a pane for.
  for (const r of fromRunner) {
    if (!r.pane && !out.some((s) => s.id === r.id) && r.kind) {
      out.push({
        id: r.id, kind: r.kind, rig: r.rig, bead: r.bead, model: null, branch: null, worktree: null,
        state: r.snoozedUntil ? "snoozed" : r.alive ? "running" : "closed", startedAt: r.startedAt || new Date().toISOString(), lastActivityAt: null,
        phases: [], wakeAt: r.snoozedUntil || null, runner: r.runner, attachable: r.attachable, writable: r.writable, name: null, task: null,
        turn: null, turnAt: null,
      });
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > BODY_LIMIT) {
        reject(new BadRequest("body too large", 413));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Build the application (no listening socket). Everything is injectable so the
 * tests drive the real handlers with fakes.
 * @param {{cfg?: any, auth?: Auth, sources?: any, alerts?: Alerts, ops?: Ops, readOnly?: boolean, log?: Function}} [opts]
 */
export function createApp(opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const log = opts.log || ((m) => process.stderr.write(`console: ${m}\n`));
  const readOnly = Boolean(opts.readOnly);
  const auth = opts.auth || new Auth(cfg);
  const csrf = new Csrf(opts.bootKey);
  const alerts = opts.alerts || new Alerts({ file: cfg.alertsFile, readOnly });
  if (!readOnly) alerts.load();
  // One owner-context exec adapter for the whole server: collectors and
  // actions both go through it, nothing shells out on its own.
  const wrapper = opts.wrapper || new Wrapper(cfg, { runner: opts.runner });
  const collectors = new Collectors({ log });
  // The money ledger is the console's own state (design 4.5): loaded before the
  // collectors so the money slice reads a consistent view from the start.
  const money = opts.money || new Ledger({ dir: cfg.moneyDir, readOnly, log });
  // Goals live beside the ledger in their own file (see goals.js for why).
  const goals = opts.goals || new Goals({ dir: cfg.moneyDir, readOnly, log });
  if (!readOnly) {
    try {
      money.load();
    } catch (e) {
      log(`money ledger unavailable: ${String(e && e.message)}`);
    }
    try {
      goals.load();
    } catch (e) {
      log(`money goals unavailable: ${String(e && e.message)}`);
    }
  }
  // Hardware history: the snapshot is a photograph and cannot say whether 73
  // degrees is normal for this box or heading somewhere. Kept by the console
  // because the producer has no ring buffer and lives behind the guard.
  const history = opts.history || new History({ file: path.join(cfg.consoleStateDir, "machine-history.json"), readOnly, log });
  if (!readOnly) history.load();
  registerAll(collectors, { cfg, sources: opts.sources, alerts, readOnly, wrapper, money, goals, history });
  // Terminals: the runner daemon owns PTYs; the server only proxies. Not started
  // in --check (readOnly) mode: no socket connect, no reconnect loop.
  const runnerClient = opts.runnerClient || new RunnerClient({ socketPath: cfg.runnerSocket, log });
  if (!readOnly) runnerClient.start();
  // Capri, the meta terminal (proposal 19): the passkey gate proves a human is at
  // the keyboard before the runner is asked to start or attach the one uncaged
  // session. The whois gate already restricts every connection to the owner; this
  // adds proof-of-presence on top. rpId is the bare host; the WebAuthn origin
  // includes scheme and port.
  const passkey =
    opts.passkey ||
    new PasskeyGate({
      store: new PasskeyStore({ file: path.join(cfg.metaDir, "keys", "passkeys.json"), log }).load(),
      rpId: cfg.metaRpId,
      rpName: "HQ Console",
      origin: cfg.metaOrigin,
      owner: cfg.owner,
      enabled: cfg.metaEnabled,
      log,
    });
  // Authoritative set of meta session ids: populated synchronously the moment
  // /api/meta/new returns a sid, so the WS attach can require a passkey even before
  // the async sessions collector has refreshed (a cache miss must fail closed, not
  // open). Pruned when a meta session reconciles.
  const metaSids = new Set();
  // Interactive terminals this server spawned through the runner and registered
  // in the session ledger (ctl register-term). On exit their row is marked done
  // so answered requests are swept instead of wedging as deliverable.
  const consoleTermSids = new Set();
  // The orchestrator chat terminal started from this server and not yet seen live
  // in the sessions slice (a collector lags a click): {sid, at}. Blocks a double
  // click from starting two; expires so a start that died does not lock it out.
  let orchPending = null;
  const ORCH_PENDING_MS = 90 * 1000;
  const markTermDone = (sid) => {
    consoleTermSids.delete(sid);
    wrapper
      .call("ctl", ["register-term", sid, "--done"], { timeout: 15000 })
      .catch((e) => log(`register-term --done ${sid} failed: ${String(e && e.message)}`));
  };
  if (!readOnly) {
    runnerClient.on("exit", (ev) => {
      // A snooze ends the client but not the terminal: its row and address stay.
      if (ev && ev.sid && consoleTermSids.has(ev.sid) && !ev.snoozed) markTermDone(ev.sid);
    });
    const metaAlert = (kind, ev) => {
      const bad = kind === "integrity" ? ev.ok === false : (ev.errors && ev.errors.length) || (ev.changed && ev.changed.length);
      alerts.add({
        id: `meta-${kind}-${ev.sid}`,
        severity: bad ? "P1" : "P2",
        title: kind === "integrity" ? `Capri integrity ${ev.ok === false ? "FAILED" : "ok"} (${ev.sid})` : `Capri reconciled (${ev.sid})`,
        detail:
          kind === "integrity"
            ? ev.integrityFailed || (ev.error ? String(ev.error) : ev.cage && !ev.cage.clean ? `cage changed: ${(ev.cage.files || []).join(", ")}` : "clean")
            : `${(ev.autoReverted || []).length} auto-reverted, ${(ev.changed || []).length} to review${(ev.errors || []).length ? `, errors: ${ev.errors.join("; ")}` : ""}`,
        source: "meta-close",
        ackable: true,
      });
      ws.broadcastSlice && ws.broadcastSlice("alerts", alerts.list(), new Date().toISOString());
    };
    runnerClient.on("meta.reconcile", (ev) => {
      metaAlert("reconcile", ev);
      if (ev && ev.sid) metaSids.delete(ev.sid);
    });
    runnerClient.on("meta.integrity", (ev) => metaAlert("integrity", ev));
  }
  // The sessions collector merges the runner's view (attachable/writable) onto ctl's rows.
  collectors.register("sessions", 5, async () => {
    const ctl = await collectors.get("_ctl");
    const rows = mapSessions(ctl);
    // null means the runner could not be asked, which is different from the
    // runner answering "none": only a real answer may drive the sweep below.
    let fromRunner = null;
    if (!readOnly) {
      try {
        fromRunner = sessionsFromRunner(await runnerClient.list());
      } catch {
        fromRunner = null;
      }
    }
    if (fromRunner) {
      // Registered console terminals whose PTY the runner no longer holds are
      // corpses: the exit event normally marks them done, but a server restart
      // loses that in-memory set, so the ledger is reconciled here too.
      // A snoozed one is not a corpse: the runner still holds its record.
      const live = new Set(fromRunner.filter((r) => r.alive || r.snoozedUntil).map((r) => r.id));
      const awake = new Set(fromRunner.filter((r) => r.alive).map((r) => r.id));
      for (const t of Array.isArray(ctl && ctl.terminals) ? ctl.terminals : []) {
        // "snoozed" too: a snoozed terminal the runner dropped (killed, or it
        // never woke) while this server was down would otherwise stay a card.
        if (t && t.kind === "console-term" && (t.status === "active" || t.status === "snoozed") && !live.has(String(t.id || ""))) {
          markTermDone(String(t.id));
        }
        // Woken by the runner (its tick or Wake): the registry row is active again.
        if (t && t.kind === "console-term" && t.status === "snoozed" && awake.has(String(t.id || ""))) {
          consoleTermSids.add(String(t.id));
          wrapper
            .call("ctl", ["register-term", String(t.id), "--active"], { timeout: 15000 })
            .catch((e) => log(`register-term --active ${t.id} failed: ${String(e && e.message)}`));
        }
      }
    }
    // A closed session is history, not a terminal: it leaves the console at once
    // (the owner 2026-10-27). The registry keeps the row for audit.
    return mergeRunnerSessions(rows, fromRunner || []).filter((s) => s.state !== "closed");
  });
  // Projects: the real collector replaces the placeholder registered by registerAll.
  // Tests that inject fake sources keep the placeholder (the real one shells out to bd).
  const projectsWiring = opts.sources && !opts.projects
    ? { registry: null, facts: null }
    : registerProjectCollectors({ collectors, wrapper, cfg, log, money });
  // Unconfirmed assumptions ride the requests slice as synthetic decide cards
  // (design 4.2): they exist until the entry is confirmed or deleted, so the
  // collector recomputes them from the truths files on every refresh.
  if (projectsWiring.registry) {
    collectors.register("requests", 5, async () => {
      const rows = mapRequests(await collectors.get("_ctl"));
      let cards = [];
      try {
        cards = assumptionCards(projectsWiring.registry.list());
      } catch (e) {
        log(`assumption cards skipped: ${String(e && e.message)}`);
      }
      return rows.concat(cards);
    });
  }
  // Out-of-band truths commit detector (design 4.2): every commit touching a
  // truths file must carry a trailer this box's key verifies. Production only:
  // the laptop's dev key cannot verify hqbox's commits, so a dev console would
  // flag every honest write.
  if (projectsWiring.registry && !cfg.devNoAuth && !readOnly) {
    let auditKey = null;
    // The cursor makes coverage durable: each pass audits <cursor>..HEAD, so a
    // violation can never scroll out of a fixed lookback window while the
    // console is down (lucy round 2). It advances only after a processed pass.
    // The console's own state, not the repo's: hqconsole may read ~/hq and
    // must not write it, so the cursor lives beside the other server state.
    const cursorFile = path.join(cfg.consoleStateDir, "truths-audit-cursor");
    collectors.register(
      "truths-audit",
      300,
      async () => {
        if (!auditKey) auditKey = loadTruthsKey({ devNoAuth: false, log });
        let cursor = "";
        try {
          cursor = fs.readFileSync(cursorFile, "utf8").trim();
        } catch {
          /* first run */
        }
        const args = /^[0-9a-f]{7,64}$/.test(cursor) ? ["500", cursor] : ["500"];
        const r = await wrapper.call("truths-audit", args, { timeout: 30000 });
        if (r.code !== 0) throw new Error(`truths-audit exit ${r.code}: ${String(r.stderr || "").trim().slice(-160)}`);
        const entries = parseAuditLines(r.stdout);
        const violations = auditTruths(entries, { key: auditKey });
        for (const v of violations) {
          alerts.add({
            id: `truths-oob-${v.sha.slice(0, 12)}`,
            severity: "P1",
            title: `Out-of-band truths commit for ${v.project}`,
            detail: `${v.sha.slice(0, 12)} touched ${v.path} without a verifiable trailer: ${v.reason}`,
            source: "truths-audit",
          });
        }
        const scanned = parseAuditHead(r.stdout);
        if (scanned && scanned.truncated) {
          // The window filled up: older commits were not seen, so the cursor
          // holds and the backlog is a card, never a silent skip.
          alerts.add({
            id: "truths-audit-backlog",
            severity: "P1",
            title: "Truths audit backlog: scan window truncated",
            detail: `More than 500 truths-touching commits since the cursor; the cursor is held at ${cursor || "(none)"} until the backlog is resolved by hand.`,
            source: "truths-audit",
          });
        } else if (scanned && scanned.head) {
          try {
            const tmp = `${cursorFile}.tmp`;
            fs.writeFileSync(tmp, scanned.head + "\n");
            fs.renameSync(tmp, cursorFile);
          } catch (e) {
            log(`truths-audit cursor not saved: ${String(e && e.message)}`);
          }
        }
        return { checked: entries.length, violations: violations.length, head: scanned && scanned.head };
      },
      { internal: true },
    );
  }
  // Uploads: file drop into the inbox (design section 6). Boot reconcile runs on real start only.
  // A box where the inbox cannot be created (tests with prod paths, first boot before
  // provisioning) gets a stub that answers 503 instead of a dead server.
  let uploads = opts.uploads || null;
  if (!uploads) {
    try {
      // --check must not create the inbox: the stub below answers until real start
      if (readOnly) throw new Error("check mode");
      uploads = createUploads({ cfg, alerts, log });
    } catch (e) {
      log(`uploads unavailable: ${String(e && e.message)}`);
      uploads = {
        handle: (req, res) => sendJson(res, 503, { error: "uploads unavailable on this box" }),
        list: () => [], setKeep: () => ({ ok: false, status: 503, error: "uploads unavailable" }),
        remove: () => ({ ok: false, status: 503, error: "uploads unavailable" }),
        boot: () => {}, close: () => {}, health: () => ({ ok: false }),
      };
    }
  }
  // Files the owner drops for the orchestrator (Now page, hq-4npjr.5): a list in the inbox
  // tree, which owner can read and this server can write.
  // Capri say (hq-ymxzt.3): dictated text goes into the live orchestrator terminal.
  const capriSay =
    opts.capriSay ||
    new CapriSay({
      orchestrator: async () => liveOrchestrator((await collectors.get("sessions").catch(() => [])) || []),
      foreground: async (sid) => (await runnerClient.request("term.fg", { sid })).command,
      input: (sid, data) => runnerClient.request("input", { sid, data }),
    });
  const loaded = opts.loaded || new LoadedFiles(path.join((uploads.paths && uploads.paths.dir) || cfg.inboxDir, "orchestrator-loaded.json"));
  // Sticky notes: the console's own scratch surface, server-side so a note pinned on
  // the laptop is there on the phone (design: notes.js).
  const notes = opts.notes || new Notes({ file: path.join(cfg.consoleStateDir, "notes.json"), readOnly, log });
  if (!readOnly) notes.load();
  // The read marker (see seen.js): server side so every device agrees on what has
  // been read, and only ever moved by an explicit press.
  const seen = opts.seen || new Seen({ file: path.join(cfg.consoleStateDir, "seen.json"), readOnly, log });
  if (!readOnly) seen.load();
  // The report store (see reports.js): read here, marked read through publish.py so
  // its lock covers every write to read.json.
  const reports =
    opts.reports ||
    new Reports({
      dir: path.join(cfg.stateDir, "reports"),
      publishScript: path.join(cfg.hqRoot, "ops", "reports", "publish.py"),
      readOnly,
      log,
    });
  function reportsSummary() {
    try {
      return reports.summary();
    } catch (e) {
      return { total: null, unread: null, error: String(e && e.message) };
    }
  }
  const ops = opts.ops || new Ops({ dir: cfg.opsDir, readOnly, runner: opts.runner });
  // Sweep once at startup and then daily. The op store is a replay guard, not an
  // archive: without this it kept one file and one map entry per verb ever run.
  if (!readOnly) {
    try {
      const n = ops.prune();
      if (n) log(`pruned ${n} expired op records`);
    } catch (e) {
      log(`op prune skipped: ${String(e && e.message)}`);
    }
    const opSweep = setInterval(() => {
      try {
        ops.prune();
      } catch {
        /* next sweep will try again */
      }
    }, 24 * 60 * 60 * 1000);
    if (opSweep.unref) opSweep.unref();
  }
  // Approvals for destructive verbs. The signing key is per process on purpose: a
  // restart invalidates outstanding approvals, which is correct, because a restart also
  // means the op records they name are no longer in memory.
  const seals = new Seals();
  const verbs = buildVerbs({
    cfg,
    wrapper,
    seals,
    ops,
    requestState: (rid) => {
      const rows = (collectors.peek ? collectors.peek("requests") : null) || [];
      const row = rows.find((r) => r && r.id === rid);
      return row ? String(row.state || "") || null : null;
    },
  });
  const statik = new StaticServer({ root: cfg.releaseRoot, csrf, origins: allowedOrigins(cfg), log });
  const tokens = createTokens({ ttlMs: cfg.wsTokenTtlMs, strictPort: cfg.wsTokenStrictPort });
  const ws = new WsLayer({ cfg, auth, tokens, getHello: async () => hello(), log });
  // Errors tab (bead hq-hsl2.3): the incidents slice, the resolve route, and the
  // fixer panes the term handlers below may attach (see errors.js).
  const errors = createErrors({ collectors, wrapper, log, source: opts.errorsSource || (opts.sources ? emptySource() : null) });
  const termHandlers = attachTermHandlers({
    ws,
    runner: runnerClient,
    sessions: (sid) => (collectors.peek ? (collectors.peek("sessions") || []) : []).find((s) => s.id === sid) || errors.termRecord(sid),
    // The awaited second look: `peek` is a cache and its miss is not an answer.
    // This one refreshes, so a console that has just restarted learns about the
    // Capri the runner is still holding before it decides whether to gate it.
    sessionsFresh: async (sid) => ((await collectors.get("sessions").catch(() => [])) || []).find((s) => s.id === sid) || (await errors.termRecordFresh(sid)),
    passkey,
    requirePasskey: cfg.metaRequirePasskey,
    connKey: (sock) => Auth.connKey(sock && sock._socket),
    // fail closed: a sid known to be meta (authoritative set) OR reported as meta by
    // the cache requires a passkey; a sid nothing can account for is refused outright.
    isMeta: (sid) => metaSids.has(sid),
    // the owner's own Enter or Ctrl-C in the orchestrator terminal clears Capri's
    // uncertain mark there (hq-ymxzt.14).
    onInput: (sid, data) => capriSay.humanInput?.(sid, data),
    log,
  });

  // Route 3 voice inject (proposal 25, Option A): deliver queued transcripts to
  // the live Capri session, but only when a passkey-attached tab is present.
  // Watches the ctl.sh meta-inject queue; holds an undeliverable entry as a card.
  const metaInject = (!readOnly && cfg.metaEnabled)
    ? new MetaInjectConsumer({
        file: path.join(cfg.stateDir, "console", "meta-inject.jsonl"),
        // durable disposition lives under the console's OWN state dir (hqconsole
        // writable), so a restart neither re-drafts a handled task nor loses one
        stateFile: path.join(cfg.consoleStateDir, "meta-inject-seen.json"),
        liveMetaSid: () => {
          for (const sid of metaSids) return sid; // one meta session per box
          return null;
        },
        hasAttachment: (sid) => termHandlers.hasAttachment(sid),
        // Push a draft banner to the attached tab; never write the PTY (proposal
        // 25, lucy rounds 1-2: raw PTY injection cannot be made safe from outside
        // Claude). The tab commits on the owner's click via the normal input path.
        pushDraft: (sid, draft) => termHandlers.notifyAttached(sid, { t: "meta.inject", sid, id: draft.id, text: draft.text }),
        hold: (text, id) => {
          alerts.add({
            id: `meta-inject-${id}`,
            severity: "P1",
            title: "Voice task not delivered: Capri was not open",
            detail: text, // full transcript, not truncated: it is the whole task
            source: "meta-inject",
            ackable: true,
          });
          ws.broadcastSlice && ws.broadcastSlice("alerts", alerts.list(), new Date().toISOString());
        },
        log,
      })
    : null;
  // start() is deferred to the boot path (createServer), so building an app in a
  // test does not leave an fs.watch + interval keeping the event loop alive.
  const projects = projectsWiring.registry
    ? projectRoutes({ cfg, wrapper, collectors, registry: projectsWiring.registry, facts: projectsWiring.facts, log })
    : () => false;

  // A new report or a read on another device moves the unread count; push it when it
  // changes so every open console agrees without a reload.
  let lastReports = JSON.stringify(reportsSummary());
  function pushReports() {
    const now = reportsSummary();
    const sig = JSON.stringify(now);
    if (sig === lastReports) return;
    lastReports = sig;
    ws.broadcastSlice && ws.broadcastSlice("reports", now, new Date().toISOString());
  }
  if (!readOnly) {
    const reportsWatch = setInterval(pushReports, 20000);
    if (reportsWatch.unref) reportsWatch.unref();
  }
  collectors.onChange((name, data, at) => {
    if (SLICES.includes(name)) ws.broadcastSlice(name, data, at);
  });

  async function sliceOrNull(name, fallback) {
    try {
      return await collectors.get(name);
    } catch {
      return fallback;
    }
  }

  /** @returns {Promise<import("../../shared/api.js").ConsoleState>} */
  async function buildState() {
    const [sessions, requests, ready, projects, machine, usage, alertList, activity, stack, flow, understudy, services, moneySlice, monitors, deploys, calendar, discovered, ear, board] = await Promise.all([
      sliceOrNull("sessions", []),
      sliceOrNull("requests", []),
      sliceOrNull("ready", []),
      sliceOrNull("projects", []),
      sliceOrNull("machine", null),
      sliceOrNull("usage", null),
      sliceOrNull("alerts", []),
      sliceOrNull("activity", []),
      sliceOrNull("stack", null),
      sliceOrNull("flow", null),
      sliceOrNull("understudy", null),
      sliceOrNull("services", null),
      sliceOrNull("money", null),
      sliceOrNull("monitors", null),
      sliceOrNull("deploys", null),
      sliceOrNull("calendar", null),
      sliceOrNull("discovered", null),
      sliceOrNull("ear", null),
      sliceOrNull("board", null),
    ]);
    const state = {
      generatedAt: new Date().toISOString(),
      version: { release: statik.release, protocol: PROTOCOL_VERSION },
      owner: cfg.owner,
      sessions: sessions || [],
      requests: requests || [],
      ready: ready || [],
      projects: projects || [],
      machine: machine || null,
      usage: usage || null,
      alerts: alertList || [],
      activity: activity || [],
      stack: stack || null,
      flow: flow || null,
      understudy: understudy || null,
      services: services || null,
      money: moneySlice || null,
      monitors: monitors || null,
      deploys: deploys || null,
      calendar: calendar || null,
      discovered: discovered || null,
      ear: ear || null,
      board: board || null,
      errors: await sliceOrNull("errors", null),
      collectors: collectors.statuses(),
      badges: { now: 0, nowSeverity: null, projects: 0, stack: 0, machines: 0 },
    };
    state.badges = computeBadges(state);
    state.reports = reportsSummary();
    state.badges.reports = state.reports.unread || 0;
    return state;
  }

  async function hello() {
    return {
      release: statik.release,
      protocol: PROTOCOL_VERSION,
      owner: cfg.owner,
      state: await buildState(),
    };
  }

  function healthChecks() {
    const failing = collectors.statuses().filter((c) => c.error);
    return {
      release: statik.release,
      staticRoot: statik.available,
      protocol: PROTOCOL_VERSION,
      collectors: collectors.statuses().length,
      collectorErrors: failing.map((c) => `${c.name}: ${c.error}`),
      alerts: alerts.list().length,
    };
  }

  /** The per-request gate: authorized socket, then the Host pin. */
  function gate(req, res) {
    if (!auth.socketAllowed(req.socket)) {
      sendJson(res, 403, { error: "unauthorized connection" });
      try {
        req.socket.destroy();
      } catch {
        /* ignore */
      }
      return false;
    }
    if (!auth.hostAllowed(req.headers.host)) {
      sendJson(res, 403, { error: "bad host" });
      return false;
    }
    return true;
  }

  async function handleRequest(req, res) {
    // Declared OUTSIDE the try: the catch below logs the url, and when it was
    // declared inside, that log line itself threw ReferenceError and took the
    // whole process down on the first unexpected route error (2026-08-27, an
    // EACCES from the money ledger crashed the server instead of answering 500).
    const url = String(req.url || "/").split("?")[0];
    const method = req.method || "GET";
    try {
      if (!gate(req, res)) return;

      if (method === "GET" || method === "HEAD") {
        if (url === "/healthz") {
          const checks = healthChecks();
          return sendJson(res, 200, {
            ok: checks.collectorErrors.length === 0,
            release: checks.release,
            protocol: PROTOCOL_VERSION,
            checks,
          });
        }
        if (url === "/api/state") return sendJson(res, 200, await buildState());
        const slice = url.match(/^\/api\/state\/([a-z]+)$/);
        if (slice) {
          if (!SLICES.includes(slice[1])) return sendJson(res, 404, { error: "no such slice" });
          return sendJson(res, 200, { slice: slice[1], data: await sliceOrNull(slice[1], null) });
        }
        const svcLogs = url.match(/^\/api\/service\/([a-z0-9-]{1,40})\/logs$/);
        if (svcLogs) {
          // Same reasoning as diffstat below: this GET is uncached and each call
          // starts a privileged journalctl/docker process across the sudo
          // boundary. A cross-origin page cannot read the answer, but it can make
          // the owner's own browser issue the request in a loop, so the per-boot
          // key is required here too.
          const key = csrf.check(req);
          if (!key.ok) return sendJson(res, key.status, key.body);
          const q = new URL(req.url || "/", "http://x").searchParams.get("n");
          const n = Math.max(1, Math.min(Number(q) || 50, 200));
          const r = await wrapper.call("service-logs", [svcLogs[1], String(n)], { timeout: 15000 });
          if (r.code !== 0) {
            return sendJson(res, 502, { error: String(r.stderr || "").trim().slice(-200) || "logs unavailable" });
          }
          const j = firstJson(r.stdout, null);
          return j ? sendJson(res, 200, j) : sendJson(res, 502, { error: "no logs payload" });
        }
        // What a merge would touch: names and line counts, never file contents. The
        // console shows the size and shape of the change so the decision is informed;
        // reading the diff itself stays a terminal job.
        const diffstat = url.match(/^\/api\/session\/([A-Za-z0-9._-]{1,64})\/diffstat$/);
        if (diffstat) {
          // This GET starts a git process across the sudo boundary, so it is guarded
          // like a mutation even though it only reads: a page the owner happens to
          // visit can make their browser issue same-origin GETs, and without the
          // per-boot key it could keep one spawning.
          const key = csrf.check(req);
          if (!key.ok) return sendJson(res, key.status, key.body);
          const rows = (collectors.peek ? collectors.peek("sessions") || [] : []);
          const sess = rows.find((x) => x.id === diffstat[1]);
          if (!sess) return sendJson(res, 404, { error: "no such session" });
          if (!sess.branch || !sess.rig) return sendJson(res, 200, { files: [], added: 0, removed: 0, note: "no branch on this session" });
          const dir = sess.worktree || path.join(cfg.rigsDir, sess.rig);
          const base = String((sess).base || "main");
          const r = await wrapper.call("git-diffstat", [dir, base, sess.branch], { timeout: 20000 });
          if (r.code !== 0) {
            return sendJson(res, 502, { error: String(r.stderr || "").trim().slice(-200) || "diffstat unavailable" });
          }
          const files = [];
          let added = 0;
          let removed = 0;
          for (const line of String(r.stdout || "").split("\n")) {
            const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
            if (!m) continue;
            // a binary file reports "-" for both counts: shown, but not summed
            const a = m[1] === "-" ? null : Number(m[1]);
            const d = m[2] === "-" ? null : Number(m[2]);
            if (a !== null) added += a;
            if (d !== null) removed += d;
            files.push({ path: m[3], added: a, removed: d });
          }
          files.sort((x, y) => (y.added ?? 0) + (y.removed ?? 0) - ((x.added ?? 0) + (x.removed ?? 0)));
          return sendJson(res, 200, { branch: sess.branch, base, files: files.slice(0, 60), truncated: files.length > 60, added, removed });
        }
        const op = url.match(/^\/api\/op\/([A-Za-z0-9._-]{1,64})$/);
        if (op) {
          const rec = ops.read(op[1]);
          return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: "no such op" });
        }
        if (url === "/api/notes") return sendJson(res, 200, notes.list());
        if (url === "/api/artifacts") return sendJson(res, 200, listArtifacts(cfg.stateDir, 10));
        if (url === "/api/orchestrator") return sendJson(res, 200, orchestratorReport({ stateDir: cfg.stateDir, loaded }));
        if (url === "/api/seen") return sendJson(res, 200, seen.get());
        if (url === "/api/capri/frames") return sendJson(res, 200, capriManifest(cfg.stateDir));
        const capriFrame = url.match(/^\/api\/capri\/frames\/([a-z]{1,16})\/([^/]{1,80})$/);
        if (capriFrame) {
          const f = readCapriFrame(cfg.stateDir, capriFrame[1], capriFrame[2]);
          if (!f) return sendJson(res, 404, { error: "no such frame" });
          res.writeHead(200, {
            "content-type": f.type,
            "content-length": String(f.body.length),
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          });
          return res.end(method === "HEAD" ? undefined : f.body);
        }
        if (url === "/api/reports" || url.startsWith("/api/reports/")) {
          try {
            if (url === "/api/reports") {
              const q = new URL(req.url || "/", "http://x").searchParams;
              return sendJson(res, 200, reports.list({ kind: q.get("kind"), unread: q.get("unread"), limit: q.get("limit"), offset: q.get("offset") }));
            }
            const one = url.match(/^\/api\/reports\/([A-Za-z0-9._-]{1,128})$/);
            return one ? sendJson(res, 200, reports.get(one[1])) : sendJson(res, 404, { error: "not found" });
          } catch (e) {
            if (e instanceof ReportsError) return sendJson(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (url === "/api/meta/status") {
          const p = passkey.status();
          let runnerMeta = { enabled: cfg.metaEnabled, live: null, unreconciled: [], lastClose: null };
          try {
            if (!readOnly && cfg.metaEnabled) runnerMeta = await runnerClient.metaStatus();
          } catch {
            runnerMeta = { enabled: cfg.metaEnabled, live: null, unreconciled: [], lastClose: null, runnerDown: true };
          }
          return sendJson(res, 200, { ...runnerMeta, passkeys: p.passkeys, bootstrap: p.bootstrap, enabled: cfg.metaEnabled, requirePasskey: cfg.metaRequirePasskey });
        }
        if (url === "/api/uploads") {
          const q = new URL(req.url || "/", "http://x").searchParams.get("date");
          return sendJson(res, 200, uploads.list(q));
        }
        if (projects(req, res, url)) return;
        if (url.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
        if (await statik.serve(req, res, url)) return;
        return sendJson(res, 404, { error: "not found" });
      }

      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

      // POST: Origin (when present) must be exactly ours, then the CSRF key.
      const origin = req.headers.origin;
      if (origin && !auth.originAllowed(origin)) return sendJson(res, 403, { error: "bad origin" });
      const key = csrf.check(req);
      if (!key.ok) return sendJson(res, key.status, key.body);

      // Capri Load images (hq-ymxzt.8): raw image bytes, owner only (origin and key
      // checked above), read with their own 5 MB cap instead of readBody's.
      const frameRoute = url.match(/^\/api\/capri\/frames\/([a-z]{1,16})\/([^/]{1,80})(\/delete)?$/);
      if (frameRoute) {
        if (readOnly) return sendJson(res, 503, { error: "read-only" });
        const [, state, name, del] = frameRoute;
        if (del) {
          const r = removeCapriFrame(cfg.stateDir, state, name);
          return sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true } : { error: r.error });
        }
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > FRAME_MAX_BYTES) {
            req.resume();
            return sendJson(res, 413, { error: "image is over 5 MB" });
          }
          chunks.push(c);
        }
        let r;
        try {
          r = saveCapriFrame(cfg.stateDir, state, decodeURIComponent(name), Buffer.concat(chunks));
        } catch (e) {
          log(`capri frame save: ${String(e && e.message)}`);
          return sendJson(res, 500, { error: "could not save the image" });
        }
        return sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true, frame: r.frame } : { error: r.error });
      }

      // multipart upload: streamed by its own handler, never through readBody
      if (url === "/api/upload") return uploads.handle(req, res);

      let body = {};
      const raw = await readBody(req);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: "bad json" });
        }
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad body" });

      if (url === "/api/ws-token") {
        return sendJson(res, 200, tokens.mint(Auth.connKey(req.socket)));
      }
      // Capri wake word (hq-ymxzt.2): relay wake/done to every open page; say (hq-ymxzt.3)
      // types the dictated text into the live orchestrator terminal.
      if (url === "/api/capri") {
        const ev = parseCapriEvent(body);
        if (!ev.ok) return sendJson(res, 400, { error: ev.error });
        if (ev.event === "wake") {
          // The listener presses the Wispr Flow hotkey only when an orchestrator is live.
          const r = await ws.capriWake(capriMessage("wake"));
          const orch = liveOrchestrator(collectors.peek ? collectors.peek("sessions") || [] : []);
          return sendJson(res, 200, { ok: true, event: "wake", pages: r.pages, focused: r.focused, orchestrator: Boolean(orch) });
        }
        if (ev.event === "say") {
          // Only ids and lengths are logged, never the text.
          const r = await capriSay.deliver(ev);
          log(`capri say ${ev.transcriptId}: ${r.status}, ${[...ev.text].length} chars`);
          return sendJson(res, r.status, r.body);
        }
        ws.broadcast(capriMessage(ev.event));
        return sendJson(res, 200, { ok: true, event: ev.event, pages: ws.clientCount });
      }
      if (url.startsWith("/api/orchestrator/")) {
        if (readOnly) return sendJson(res, 503, { error: "read-only" });
        try {
          const r = loadRoute(url, body, { uploads, loaded });
          if (r) return sendJson(res, r.status, r.body);
        } catch (e) {
          log(`orchestrator load list: ${String(e && e.message)}`);
          return sendJson(res, 500, { error: "could not update the loaded list" });
        }
      }
      const ack = url.match(/^\/api\/alerts\/([A-Za-z0-9._-]{1,64})\/ack$/);
      if (ack) {
        const okAck = alerts.ack(ack[1]);
        collectors.refresh("alerts").catch(() => {});
        return sendJson(res, okAck ? 200 : 404, { ok: okAck });
      }
      const keep = url.match(/^\/api\/uploads\/([A-Za-z0-9._-]{1,64})\/keep$/);
      if (keep) {
        const r = uploads.setKeep(keep[1], Boolean(body.keep));
        return r.ok ? sendJson(res, 200, r.entry) : sendJson(res, r.status || 400, { error: r.error });
      }
      const del = url.match(/^\/api\/uploads\/([A-Za-z0-9._-]{1,64})\/delete$/);
      if (del) {
        const r = uploads.remove(del[1]);
        if (!r.ok) return sendJson(res, r.status || 400, { error: r.error });
        // A deleted upload must not stay listed for the orchestrator with a path to
        // nothing (review round 1, note 5).
        try {
          loaded.remove(del[1]);
        } catch (e) {
          log(`orchestrator load list: ${String(e && e.message)}`);
        }
        return sendJson(res, 200, { ok: true });
      }
      req.body = body;
      if (projects(req, res, url)) return;
      if (await errors.route(url, body, (code, payload) => sendJson(res, code, payload))) return;
      if (url === "/api/money/entry") {
        const r = await money.add(body);
        collectors.refresh("money").catch(() => {});
        return sendJson(res, r.replayed ? 200 : 201, r.entry);
      }
      if (url === "/api/money/delete") {
        const r = await money.remove(body);
        collectors.refresh("money").catch(() => {});
        return sendJson(res, 200, { ok: true, target: r.target });
      }
      // Commitments are a separate pair of routes rather than a flag on the entry
      // routes, because they write a different record to a different question:
      // one says money moved, the other says money is scheduled to.
      if (url === "/api/money/commitment") {
        const r = await money.addCommitment(body);
        collectors.refresh("money").catch(() => {});
        return sendJson(res, r.replayed ? 200 : 201, r.commitment);
      }
      if (url === "/api/money/commitment/cancel") {
        const r = await money.cancelCommitment(body);
        collectors.refresh("money").catch(() => {});
        return sendJson(res, 200, { ok: true, target: r.target });
      }
      // A goal is a yardstick, not money: its own store, its own pair of routes.
      if (url === "/api/money/goal") {
        const r = await goals.add(body);
        collectors.refresh("money").catch(() => {});
        return sendJson(res, r.replayed ? 200 : 201, r.goal);
      }
      if (url === "/api/money/goal/delete") {
        const r = await goals.remove(body);
        collectors.refresh("money").catch(() => {});
        return sendJson(res, 200, { ok: true, target: r.target });
      }
      if (url === "/api/session/new") {
        // an interactive PTY session for the owner, spawned by the runner as owner
        // role "orchestrator" (hq-4npjr.11): the one chat terminal, in ~/hq, on the
        // decide model, named orchestrator; a second is refused while one lives.
        const role = body.role === undefined || body.role === null ? null : String(body.role);
        if (role !== null && role !== "orchestrator") return sendJson(res, 400, { error: "bad role" });
        const orch = role === "orchestrator";
        const rig = !orch && body.rig ? String(body.rig) : null;
        if (rig && !/^[A-Za-z0-9._-]{1,64}$/.test(rig)) return sendJson(res, 400, { error: "bad rig" });
        // Resolve the working directory and refuse a name with no checkout on
        // this box HERE, where the browser gets an answer. Spawning anyway used
        // to "succeed" (201) and then die inside the runner on the cd (exit 2),
        // which read as "the console cannot create terminals" with no error
        // shown anywhere. A registry project may declare its own path (a
        // service living inside the hq tree); anything else must be a real
        // directory under rigs/ (a rig checkout or a worktree).
        let cwd = cfg.hqRoot;
        if (rig) {
          let project = null;
          try {
            project = projectsWiring.registry ? projectsWiring.registry.list().find((p) => p.id === rig) || null : null;
          } catch {
            project = null; // an unparseable registry is reported elsewhere; fall back to rigs/<rig>
          }
          cwd = project ? terminalDir(project, cfg) : terminalDir({ id: rig, path: null }, cfg);
          if (!cwd) {
            return sendJson(res, 400, {
              error: `${rig} has no working directory on this box (no checkout under rigs/ and no path in ops/projects.json), so a terminal cannot start there`,
            });
          }
        }
        let model = TERMINAL_MODEL;
        if (orch) {
          model = chatModel(cfg.hqRoot);
          if (!model) return sendJson(res, 500, { error: "ops/config/orchestrator.json has no valid models.decide, so the orchestrator cannot start" });
          const sessions = (await collectors.get("sessions").catch(() => [])) || [];
          const live = liveOrchestrator(sessions);
          if (live) return sendJson(res, 409, { error: `the orchestrator is already running (${live.id})`, sid: live.id });
          if (orchPending && Date.now() - orchPending.at < ORCH_PENDING_MS) {
            return sendJson(res, 409, { error: `the orchestrator is starting (${orchPending.sid || "spawn in flight"})`, sid: orchPending.sid || null });
          }
          orchPending = { sid: null, at: Date.now() };
        }
        const rec = ops.newRecord ? ops.newRecord("session-new") : null;
        // The seed prompt is what makes a console-spawned terminal a citizen:
        // it names its own card (instead of the raw sid) and it asks the owner in
        // this terminal while filing the question with ctl ask, so the card
        // carries a waiting mark and the question even when the pane is closed
        // (the owner, 2026-10-20: no Needs-you panel). Mirrors ops/scripts/term.sh.
        const ctlPath = `${cfg.hqRoot}/ops/console/ctl.sh`;
        const kb = rig
          ? `Orient from the project KB first: read ~/hq/outbox/vault/01 Projects/${rig}/Knowledge.md and graphify-out/GRAPH_REPORT.md. `
          : "";
        const seed = orch
          ? orchestratorSeed(cfg.hqRoot)
          : "You are an interactive HQ terminal the owner opened from the console; your session id is in the HQ_CONSOLE_SID env var. " +
          `First, name your console card: run \`${ctlPath} name $(${ctlPath} whoami) "<short label for what you are working on>"\` and re-run it whenever your focus changes. ` +
          kb +
          "Whenever you need the owner's input (any question, choice, or blocker), ask it here in this terminal and wait for him: " +
          `first run \`${ctlPath} ask "<question>"\` without --wait (for a choice, spell out the numbered options inside the question and pass --kind decide); it prints a request id and marks this terminal's console card as waiting, with the question on it. ` +
          "Then put the same question in your reply and end your turn. " +
          `When he answers here, run \`${ctlPath} answer <req-id> --here "<his answer>"\` to clear the waiting mark, then continue. ` +
          "An answer he sends from the card arrives typed into this terminal as \"[HQ console] the owner answered ...\"; it is already recorded, so just continue. " +
          "Then greet the owner and await his task.";
        try {
          // A console terminal is an HQ agent like any Alt-key tmux pane, so it
          // launches the way ops/scripts/term.sh does: bypassPermissions, never
          // the "auto" mode the user-level settings default to. Outside ~/hq (a
          // rig checkout or a worktree) the project cage is not loaded and the
          // default would be auto, which stalls a terminal on a prompt nobody is
          // watching. Enforcement here is the hook guards, not the permission layer.
          // Persistent (2026-10-09): the runner hosts it in the hqterm tmux
          // server, so a runner restart only drops the attached client and the
          // terminal is re-attached under the same sid. The Claude conversation
          // id is pinned here so that after a reboot the runner can resume it
          // in the same cwd (proposal 56) without anyone clicking anything.
          const claudeSession = crypto.randomUUID();
          // The orchestrator chat terminal always runs with Remote Control, named
          // like its card, so the owner can drive it from claude.ai/code and the
          // Claude app (hq-7fs2u). A resume reconnects to the same remote session.
          // The name is explicit: the flag's argument is optional, so a bare
          // --remote-control before the seed would take the seed as the name.
          const rc = orch ? ["--remote-control", "orchestrator"] : [];
          const r = await runnerClient.spawn({
            kind: "interactive",
            // Opus 5.5 by default (the owner, 2026-10-12), named here so a terminal
            // does not depend on whatever the user-level settings say that day.
            argv: ["claude", "--dangerously-skip-permissions", "--model", model, ...rc, "--session-id", claudeSession, seed],
            resumeArgv: ["claude", "--dangerously-skip-permissions", "--model", model, ...rc, "--resume", claudeSession],
            persist: true,
            // The delegate hook (ops/scripts/hook-orchestrator-delegate.sh,
            // hq-4npjr.26) keys on this: only the chat terminal is refused inline
            // work. The runner stores it with the term, so a resume keeps it.
            ...(orch ? { env: { HQ_CONSOLE_ROLE: "orchestrator" } } : {}),
            cwd,
            cols: 120,
            rows: 32,
            rig,
          });
          const sid = r && r.sid;
          // Register the terminal in the session ledger so its name binds to a
          // generation and its ctl asks have a live return address; the
          // exit handler and the sessions collector mark the row done later.
          if (sid) {
            consoleTermSids.add(sid);
            if (orch) orchPending = { sid, at: Date.now() };
            wrapper
              .call("ctl", ["register-term", sid, ...(rig ? ["--rig", rig] : [])], { timeout: 15000 })
              .then(async (rr) => {
                if (rr.code !== 0) log(`register-term ${sid} failed: ${String(rr.stderr || "").trim().slice(-200)}`);
                // Name the card here, not only from the seed: the Now page finds the
                // orchestrator by name, so the card is on top before claude has
                // even read its prompt. ctl name refuses a second live holder.
                if (orch) {
                  const nr = await wrapper.call("ctl", ["name", sid, "orchestrator"], { timeout: 15000 });
                  if (nr.code !== 0) log(`name ${sid} orchestrator failed: ${String(nr.stderr || "").trim().slice(-200)}`);
                }
              })
              .catch((e) => log(`register-term ${sid} failed: ${String(e && e.message)}`));
          }
          return sendJson(res, 201, { ok: true, sid, op: rec, ...(orch ? { role: "orchestrator", model } : {}) });
        } catch (e) {
          if (orch) orchPending = null;
          return sendJson(res, 502, { error: `runner: ${String(e && e.message)}` });
        }
      }
      if (url === "/api/seen") {
        try {
          return sendJson(res, 200, seen.set(body.at));
        } catch (e) {
          // a marker the box could not write is not a marker: say so rather than
          // letting the client believe the night was filed away
          if (e instanceof SeenError) return sendJson(res, e.status, { error: e.message });
          throw e;
        }
      }

      // ---- reports: mark read -------------------------------------------------
      const markRead = url === "/api/reports/read-all" ? true : url.match(/^\/api\/reports\/([A-Za-z0-9._-]{1,128})\/read$/);
      if (markRead) {
        try {
          const r = markRead === true ? await reports.markAll(typeof body.kind === "string" ? body.kind : null) : await reports.markRead(markRead[1]);
          pushReports();
          return sendJson(res, 200, r);
        } catch (e) {
          if (e instanceof ReportsError) return sendJson(res, e.status, { error: e.message });
          throw e;
        }
      }

      // ---- sticky notes ------------------------------------------------------
      if (url === "/api/notes") {
        try {
          return sendJson(res, 201, notes.create(body));
        } catch (e) {
          if (e instanceof NotesError) return sendJson(res, e.status, { error: e.message });
          throw e;
        }
      }
      const note = url.match(/^\/api\/notes\/(n-[0-9a-f]{12})(\/delete)?$/);
      if (note) {
        try {
          return note[2] ? sendJson(res, 200, notes.remove(note[1])) : sendJson(res, 200, notes.update(note[1], body));
        } catch (e) {
          if (e instanceof NotesError) return sendJson(res, e.status, { error: e.message });
          throw e;
        }
      }

      // ---- Capri, the meta terminal (proposal 19): passkey + start ----------
      const connKey = Auth.connKey(req.socket);
      // The whole gate follows the feature switch, not just the start route.
      // Enrolment is first-come on an empty store, so on a box where Capri is
      // switched off and nobody is watching the console, leaving these open let
      // whoever asked first own the gate for whenever it is switched on.
      if (url.startsWith("/api/passkey/") && !cfg.metaEnabled) {
        return sendJson(res, 404, { error: "the meta terminal is not enabled" });
      }
      if (url === "/api/passkey/register/options") {
        if (!passkey.store.isEmpty) {
          // adding a second device needs a fresh assertion on this connection
          if (!passkey.spendCapability(body.capability, connKey)) return sendJson(res, 403, { error: "a fresh passkey assertion is required to register another device" });
        }
        try {
          return sendJson(res, 200, await passkey.registerOptions(connKey));
        } catch (e) {
          return sendJson(res, 400, { error: String(e && e.message) });
        }
      }
      if (url === "/api/passkey/register") {
        try {
          const r = await passkey.registerVerify(body, connKey, body.label);
          // The credential is PERSISTED by the line above. Everything after it is
          // best effort inside its own try, because a failing alert store must not
          // answer 400 for an enrolment that actually committed: the browser would
          // believe it failed and retry against a server that already trusts the key.
          try {
            alerts.add({
              id: `passkey-registered-${(r && r.id) || "new"}`,
              severity: "P1",
              title: "A passkey was registered for Capri",
              detail: `${(r && r.label) || "unlabelled"} (${passkey.store.count} now enrolled)`,
              source: "passkey",
              ackable: true,
            });
            ws.broadcastSlice && ws.broadcastSlice("alerts", alerts.list(), new Date().toISOString());
          } catch (e) {
            log(`passkey registered but the alert failed: ${String(e && e.message)}`);
          }
          return sendJson(res, 201, r);
        } catch (e) {
          return sendJson(res, 400, { error: String(e && e.message) });
        }
      }
      if (url === "/api/passkey/assert/options") {
        try {
          return sendJson(res, 200, await passkey.authOptions(connKey));
        } catch (e) {
          return sendJson(res, 400, { error: String(e && e.message) });
        }
      }
      if (url === "/api/passkey/assert") {
        try {
          return sendJson(res, 200, await passkey.authVerify(body, connKey));
        } catch (e) {
          return sendJson(res, 401, { error: String(e && e.message) });
        }
      }
      if (url === "/api/meta/new") {
        if (!cfg.metaEnabled) return sendJson(res, 404, { error: "the meta terminal is not enabled" });
        // proof of presence: spend the passkey capability bound to this connection.
        // Proposal 31: with metaRequirePasskey off (root-set, single-user posture),
        // reaching this tailnet-only origin IS the proof, and no capability is spent.
        if (cfg.metaRequirePasskey && !passkey.spendCapability(body.capability, connKey)) return sendJson(res, 403, { error: "a fresh passkey assertion is required" });
        const cols = Math.min(1000, Math.max(2, Math.trunc(Number(body.cols) || 120)));
        const rows = Math.min(1000, Math.max(2, Math.trunc(Number(body.rows) || 32)));
        try {
          const cap = await runnerClient.metaCapability(); // the runner's one-start ticket
          const r = await runnerClient.spawn({ kind: "meta", capability: cap.capability, cols, rows });
          if (r && r.sid) metaSids.add(r.sid); // authoritative before the collector refreshes
          collectors.refresh("sessions").catch(() => {});
          return sendJson(res, 201, { ok: true, sid: r && r.sid });
        } catch (e) {
          const code = (e && e.code) || "";
          const status = code.includes("already live") ? 409 : code.includes("meta disabled") ? 404 : code.includes("meta refused") ? 422 : 502;
          return sendJson(res, status, { error: code || String(e && e.message), detail: (e && e.detail) || null });
        }
      }
      const sess = url.match(/^\/api\/session\/([A-Za-z0-9._-]{1,64})\/([a-z-]+)$/);
      if (sess) {
        if (!SESSION_VERBS.has(sess[2])) return sendJson(res, 404, { error: "no such session verb" });
        // Kill has to go to whoever actually owns the session. A terminal started
        // from this console is a runner PTY with NO ctl registry entry, and ctl
        // kill begins by looking that entry up, so killing one failed with a
        // registry error while the session carried on running. The registry
        // sessions (workers, panes) still go through ctl, which does the tmux
        // teardown and the bookkeeping that the runner knows nothing about.
        const known = (collectors.peek ? collectors.peek("sessions") || [] : []).find((x) => x.id === sess[1]);
        // Only a PTY the runner holds is the runner's. Every registry row maps to
        // runner "tmux" and no row carries a tmuxWindow, so the old test
        // (runner && !tmuxWindow) sent every worker's Kill to the runner, which
        // answered "no such session" and the card could never be cleared
        // (hq-je3fk.5).
        // A console terminal (kind console-term) is the runner's even when the runner
        // is down and the row carries no "pty" mark: ctl kill would only mark it done
        // while its claude ran on, so a down runner must fail the Kill, not hide it.
        const runnerOwned = Boolean(known && (known.runner === "pty" || known.consoleTerm === true));
        // Snooze likewise: snooze.sh frees a session by killing its tmux window,
        // and a console terminal has none, so it either failed ("no such
        // session") or marked the row snoozed while the terminal ran on. The
        // runner ends it and resumes the same conversation at the wake time.
        if (sess[2] === "snooze" && runnerOwned && known.runner === "pty" && known.kind === "interactive") {
          const wakeAt = String(body.until || body.when || "");
          if (!Number.isFinite(Date.parse(wakeAt)) || Date.parse(wakeAt) <= Date.now()) {
            return sendJson(res, 400, { error: "snooze needs a wake time in the future" });
          }
          try {
            const r = await runnerClient.request("term.snooze", { sid: sess[1], wakeAt: new Date(Date.parse(wakeAt)).toISOString() });
            // The registry row says snoozed too, so the sweep and the answer
            // delivery treat it as asleep, not finished.
            await wrapper
              .call("ctl", ["register-term", sess[1], "--snoozed", String(Math.floor(Date.parse(wakeAt) / 1000))], { timeout: 15000 })
              .catch((e) => log(`register-term --snoozed ${sess[1]} failed: ${String(e && e.message)}`));
            collectors.refresh("sessions").catch(() => {});
            return sendJson(res, 200, { ok: true, session: sess[1], wakeAt: r && r.wakeAt, by: "runner" });
          } catch (e) {
            return sendJson(res, 502, { error: `runner could not snooze ${sess[1]}: ${String((e && e.code) || (e && e.message))}` });
          }
        }
        if (sess[2] === "wake" && (await wakeGate(sess[1], known, res))) return;
        if (sess[2] === "kill") {
          if (runnerOwned) {
            try {
              await runnerClient.kill(sess[1]);
              collectors.refresh("sessions").catch(() => {});
              return sendJson(res, 200, { ok: true, session: sess[1], by: "runner" });
            } catch (e) {
              // The runner no longer holds it (it ended, or the runner restarted):
              // the session is already gone, so Kill clears its registry row through
              // ctl like any other instead of failing. Any other error is real.
              if (String((e && e.code) || "") !== "no such session") {
                return sendJson(res, 502, { error: `runner could not kill ${sess[1]}: ${String((e && e.code) || (e && e.message))}` });
              }
            }
          }
        }
        const { rec } = runVerb({ ops, verbs, verb: sess[2], body: { ...body, session: sess[1] } });
        return sendJson(res, 202, rec);
      }
      const verb = url.match(/^\/api\/([a-z-]+)$/);
      if (verb && verbs[verb[1]]) {
        // POST /api/wake {session} reaches the same wake.sh verb, so it passes the
        // same gate as the session route (review round 1, note 3).
        if (verb[1] === "wake") {
          const sid = String((body && body.session) || "");
          if (!/^[A-Za-z0-9._-]{1,64}$/.test(sid)) return sendJson(res, 400, { error: "session must be a session id" });
          const known = (collectors.peek ? collectors.peek("sessions") || [] : []).find((x) => x.id === sid);
          if (await wakeGate(sid, known, res)) return;
        }
        const { rec, replayed, done } = runVerb({ ops, verbs, verb: verb[1], body });
        // A completed services mutation must not leave the slice stale for the
        // whole TTL (lucy plan review): refresh right after the op settles.
        if (done && (verb[1] === "service-restart" || verb[1] === "mail-switch")) {
          done.then(() => collectors.refresh("services")).catch(() => {});
        }
        return sendJson(res, replayed ? 200 : 202, rec);
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      // A deliberate refusal (BadRequest and friends carry a status) is written to
      // be read by the operator, so it is passed through. An UNEXPECTED throw is
      // not: its message is whatever node produced, which is routinely an absolute
      // path or an internal detail. It goes to the log, where it is useful, and
      // the client gets a sentence plus nothing to work from.
      const expected = Boolean(e && e.status);
      const msg = expected && e.message ? String(e.message) : "server error";
      if (!expected) log(`unhandled ${req.method} ${url}: ${String((e && e.stack) || e)}`);
      try {
        sendJson(res, status, { error: msg });
      } catch {
        /* the response is already gone */
      }
    }
  }

  /**
   * Wake now (Now page, hq-4npjr.5). Answers the request itself and returns true,
   * or returns false when the caller should run the wrapper's wake verb (wake.sh).
   * A console terminal the runner holds wakes through the runner. A console
   * terminal the runner does not list (runner down or restarted) fails like Kill:
   * wake.sh would start a second claude in the rig while the runner later resumes
   * the real conversation. Only a snoozed registry worker reaches wake.sh.
   */
  async function wakeGate(sid, known, res) {
    if (known && known.runner === "pty" && known.kind === "interactive") {
      try {
        await runnerClient.request("term.wake", { sid });
        collectors.refresh("sessions").catch(() => {});
        sendJson(res, 200, { ok: true, session: sid, by: "runner" });
      } catch (e) {
        sendJson(res, 502, { error: `runner could not wake ${sid}: ${String((e && e.code) || (e && e.message))}` });
      }
      return true;
    }
    if (!known || known.state !== "snoozed") {
      sendJson(res, 400, { error: "wake now is only for a snoozed session" });
      return true;
    }
    if (known.consoleTerm === true || known.runner === "pty") {
      sendJson(res, 502, { error: `runner down: it does not hold console terminal ${sid}` });
      return true;
    }
    return false;
  }

  /**
   * The activation script cannot make an HTTP call (self-peer connections are
   * refused at the socket layer), so a healthy listen is reported in a file.
   */
  function writeHealthFile(port) {
    if (readOnly) return null;
    const rec = { sha: statik.release, at: new Date().toISOString(), port };
    try {
      fs.mkdirSync(path.dirname(cfg.healthFile), { recursive: true });
      const tmp = `${cfg.healthFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec) + "\n");
      fs.renameSync(tmp, cfg.healthFile);
    } catch (e) {
      log(`health file not written: ${String(e && e.message)}`);
    }
    return rec;
  }

  return {
    cfg,
    wrapper,
    auth,
    csrf,
    alerts,
    collectors,
    ops,
    verbs,
    statik,
    tokens,
    ws,
    log,
    buildState,
    hello,
    healthChecks,
    writeHealthFile,
    handleRequest,
    handleUpgrade: (req, socket, head) => ws.handleUpgrade(req, socket, head),
    notes,
    seen,
    runnerClient,
    metaInject,
    money,
    errors,
    uploads,
    termHandlers,
    projects: projectsWiring,
  };
}

/** Start listening. Returns the app plus its http(s) server. */
export async function startServer(opts = {}) {
  const app = createApp(opts);
  const cfg = app.cfg;
  let server;
  let listener;

  if (cfg.tls) {
    const tls = await app.auth.loadTls();
    const verdict = certVerdict(tls.daysLeft, cfg.certWarnDays);
    if (verdict === "expired") {
      throw new Error(
        `TLS certificate expired ${tls.notAfter ? tls.notAfter.toISOString() : "(unknown date)"}; refusing to start`,
      );
    }
    if (verdict === "warn") {
      app.alerts.add({
        id: "cert-expiry",
        severity: "P0",
        title: "TLS certificate expires soon",
        detail: `${tls.daysLeft.toFixed(1)} days left (${tls.notAfter ? tls.notAfter.toISOString() : "?"}); tailscale cert renewal has not run`,
        source: "cert",
      });
    }
    // The listener is a plain net.Server: the peer verdict runs on the RAW socket
    // (the peer address is known before any TLS byte), the TLS handshake starts
    // only for an authorized peer, and the http server gets the TLSSocket only
    // after the handshake. An unauthorized or half-open client never costs a
    // handshake and never reaches the parser. Handshakes are capped at 10 s.
    let secureContext = tlsMod.createSecureContext({ cert: tls.cert, key: tls.key });
    listener = net.createServer();
    server = http.createServer(app.handleRequest);
    listener.on("connection", (raw) =>
      gateAndHandOff(raw, (sock) => {
        const tlsSock = new tlsMod.TLSSocket(sock, { isServer: true, secureContext, requestCert: false });
        const timer = setTimeout(() => {
          try { tlsSock.destroy(); } catch { /* ignore */ }
        }, 10000);
        tlsSock.once("secure", () => {
          clearTimeout(timer);
          server.emit("connection", tlsSock);
        });
        tlsSock.once("error", () => {
          clearTimeout(timer);
          try { tlsSock.destroy(); } catch { /* ignore */ }
        });
      }),
    );
    app.auth.watchTls(
      (next) => {
        try {
          secureContext = tlsMod.createSecureContext({ cert: next.cert, key: next.key });
          app.log("TLS certificate reloaded");
          if (certVerdict(next.daysLeft, cfg.certWarnDays) === "ok") app.alerts.clear("cert-expiry");
        } catch (e) {
          app.log(`TLS reload failed: ${String(e && e.message)}`);
        }
      },
      (e) => app.log(`TLS watch: ${String(e && e.message)}`),
    );
  } else {
    listener = net.createServer();
    server = http.createServer(app.handleRequest);
    listener.on("connection", (socket) => gateAndHandOff(socket));
  }

  // Refuse at the socket layer, before HTTP parsing. The http parser consumes the
  // socket handle directly (stream pause does not hold it), so the only way to
  // keep an unauthorized peer's bytes out of the parser is to not give the
  // socket to the http server at all until the whois verdict is in: the
  // listener accepts, gates, and only then emits "connection" on the http
  // server. Refused peers see a reset, never a response. An authorized peer's
  // first request cannot race the verdict either.
  function gateAndHandOff(socket, handOff = (sock) => server.emit("connection", sock)) {
    app.auth
      .gateSocket(socket)
      .then((verdict) => {
        if (!verdict || !verdict.ok) return; // gateSocket already destroyed it
        if (socket.destroyed) return;
        handOff(socket);
      })
      .catch((e) => {
        app.log(`peer check threw: ${String(e && e.message)}`);
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
  }
  server.on("upgrade", (req, socket, head) => app.handleUpgrade(req, socket, head));

  await app.statik.reload();
  app.ops.reconcile();
  try {
    app.uploads.boot();
  } catch (e) {
    app.log(`uploads boot: ${String(e && e.message)}`);
  }
  app.collectors.start();
  app.collectors.refreshAll().catch(() => {});
  if (app.metaInject) app.metaInject.start();

  // Capri ear indicator, pushed with no poll lag: the ear writes its state file
  // atomically (rename), which fires on the directory, so watch the dir and
  // refresh the "ear" slice on that name. refresh() -> onChange -> broadcast.
  try {
    const earDir = path.join(cfg.stateDir, "console");
    fs.mkdirSync(earDir, { recursive: true });
    const earWatcher = fs.watch(earDir, (_ev, name) => {
      if (!name || String(name) === "ear-state.json") {
        app.collectors.refresh("ear").catch(() => {});
      }
    });
    if (earWatcher.unref) earWatcher.unref();
    app._earWatcher = earWatcher;
  } catch (e) {
    app.log(`ear watch: ${String(e && e.message)}`);
  }

  const bindHost = await app.auth.resolveBindAddress();
  // Every accepted socket costs one whois round trip to tailscaled BEFORE we know
  // whether the peer is allowed, so the cost is paid pre-authorization and any
  // host on the tailnet can make us pay it. One operator needs a handful of
  // connections; this is three orders of magnitude above that and still a ceiling.
  listener.maxConnections = cfg.maxConnections;
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(cfg.port, bindHost, () => {
      listener.removeListener("error", reject);
      resolve();
    });
  });
  app.writeHealthFile(cfg.port);
  app.log(`listening on ${cfg.tls ? "https" : "http"}://${bindHost}:${cfg.port} (release ${app.statik.release})`);

  /** Graceful: stop accepting, close sockets politely, drain in-flight ops. */
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log(`${signal}: draining`);
    app.collectors.stop();
    listener.close();
    server.close();
    app.ws.closeAll(1001, "server shutting down");
    try { if (app.metaInject) app.metaInject.stop(); } catch { /* ignore */ }
    try { if (app._earWatcher) { app._earWatcher.close(); app._earWatcher = null; } } catch { /* ignore */ }
    try { app.runnerClient.stop(); } catch { /* ignore */ }
    try { app.uploads.close(); } catch { /* ignore */ }
    const deadline = Date.now() + cfg.shutdownGraceMs;
    while (app.ops.inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    app.log(`shutdown complete (${app.ops.inflight} ops still running)`);
  }

  return { app, server, listener, shutdown };
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`console: config error: ${String(e && e.message)}\n`);
    process.exit(2);
  }
  if (cfg.check) {
    const { runCheck } = await import("./check.js");
    const result = await runCheck({ cfg });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  }
  try {
    const { shutdown } = await startServer({ cfg });
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, () => {
        shutdown(sig).then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }
  } catch (e) {
    process.stderr.write(`console: fatal: ${String(e && e.message)}\n`);
    process.exit(1);
  }
}

// main-module guard: compare REAL paths. In production the unit starts
// .../releases/current/server/src/server.js through the `current` symlink and
// Node resolves import.meta.url to the real path, so a plain string compare
// would silently do nothing (the service exited 0 with no output on first boot).
function isMain() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
}
if (isMain()) {
  main();
}
