// HQ Console v2 shared contract: REST + WebSocket types.
// Source of truth for both server (JSDoc-checked) and web (imported).
// Design: docs/superpowers/specs/2026-08-17-console-v2-design.md

export type Severity = "P0" | "P1" | "P2";
export type SessionKind = "worker" | "interactive" | "meta";
export type SessionState = "running" | "waiting" | "idle" | "finishable" | "snoozed" | "draining" | "closed";
export type RequestKind = "run" | "decide" | "login" | "info" | "autofix" | "keep-or-revert";
export type RequestState = "open" | "answered" | "revival_claimed" | "delivered" | "resolved" | "cancelled" | "snoozed";

export interface Session {
  id: string;
  kind: SessionKind;
  rig: string | null;          // project id, e.g. "acme-dashboard"
  bead: string | null;         // e.g. "xd-207"
  model: string | null;
  branch: string | null;
  worktree: string | null;
  state: SessionState;
  startedAt: string;           // ISO
  lastActivityAt: string | null;
  phases: { name: string; done: boolean }[];
  wakeAt: string | null;       // snoozed sessions
  runner: "tmux" | "pty";
  /** Has a tmux pane, so `focus` can do something. Runner-owned PTYs do not. */
  focusable: boolean;
  attachable: boolean;         // terminal view available
  writable: boolean;           // keyboard input accepted (interactive/meta only)
  name: string | null;         // ctl name label
  task: string | null;         // derived task title
  /**
   * From hook-turn-state.sh, settled by ctl state with ops/console/liveness.py: "working"
   * while a turn runs; "idle" once it ends AND the claude process has nothing left
   * (Claude Code's own status idle, no child but its MCP servers); "background" when the
   * turn ended but work still runs (a background Bash, Monitor or Agent) or the process
   * could not be checked; null when unknown. Background is never shown as finished.
   */
  turn: "working" | "idle" | "background" | null;
  turnAt: string | null;       // ISO, when the turn last changed
}

export interface Request {
  id: string;
  kind: RequestKind;
  severity: Severity;
  state: RequestState;
  rig: string | null;
  bead: string | null;
  session: string | null;
  createdAt: string;
  ageSeconds: number;
  question: string;
  command: string | null;      // for kind=run
  link: string | null;
  why: string | null;
  answer: string | null;
  settledAt: string | null;    // when answered/resolved/cancelled (drives the 2-minute fade)
  snoozedUntil: string | null;
  meta: Record<string, unknown>; // kind-specific: autofix {branch, headSha, baseSha}, keep-or-revert {bead}
  /** Ask routing (hq-4npjr.1): "orchestrator" while it holds the ask, "owner" once forwarded. */
  to?: string | null;
  /** Why the orchestrator forwarded it: business | taste | unknowable. */
  forwardClass?: string | null;
}

export interface ReadyBead {
  rig: string;
  id: string;
  title: string;
  priority: number;
  labels: string[];
  /** task | bug | epic | decision | chore. Only some of these are dispatchable. */
  kind: string;
  due: string | null;
  estimateMin: number | null;
  model: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  kind: "rig" | "service" | "client" | "other";
  status: "active" | "paused" | "done";
  /** Which life this belongs to. Null when the registry has not classified it. */
  sphere: "work" | "personal" | null;
  /** Who the project is for, verbatim from the registry ("Orbit Acme"). */
  client: string | null;
  /**
   * A new interactive terminal could actually start here: the project resolves
   * to a real directory on this box (its declared path, or rigs/<id>). The
   * new-terminal picker offers only spawnable projects; the server refuses the
   * rest with a clear error instead of a spawn that dies on the cd.
   */
  spawnable: boolean;
  /**
   * Closed over everything ever scoped in bd (audit-trail beads excluded),
   * 0..1. Null when the project has no beads: unknown, never a fake 0%.
   */
  completion: number | null;
  /** The phase in motion: epic of the first in-progress (else next ready) bead. */
  activeEpic: { id: string; title: string; done: number; total: number } | null;
  /** the owner's own valuation, verbatim from ops/projects.json `worth`. */
  worth: string | null;
  /** Money IN logged against this project in the ledger, all-time. Null: no ledger wired. */
  earned: { mxnCents: number; usdCents: number } | null;
  /**
   * Tokens agents spent on this project in the last 30 days, and what they
   * would have cost at API list prices (see ProjectUsage.costUsd). Null when
   * the usage collector has nothing to say, so the tile reads "no usage data"
   * rather than a $0 that looks like a measurement.
   */
  tokens30d: number | null;
  costUsd30d: number | null;
  /** When work began: the earliest bead ever filed. Null when no beads. */
  startedAt: string | null;
  goal: string | null;
  targetDate: string | null;
  counts: { open: number; inProgress: number; blocked: number; closed7d: number };
  /**
   * 30 entries, oldest first, one per UTC day, ending today. Counts per day rather
   * than a running total: this is a rate, and a cumulative line can only ever rise,
   * which made a dead project look identical to a finished one.
   */
  activity30d: number[];
  /**
   * What was counted. "commits" wherever the project has a checkout (git log on the
   * box, which mirrors GitHub main); "beads" for a project with no repo, where
   * closed ledger items are the only movement there is to show.
   */
  activitySource: "commits" | "beads";
  /** The commit window did not reach 30 days back, so the early days read low. */
  activityTruncated: boolean;
  lastMergeAt: string | null;
  lastDeploy: { state: "ok" | "failed" | "building" | "unknown"; at: string | null; url: string | null } | null;
  needsYou: number;
  nextUp: { id: string; title: string } | null;
  attention: "needs-you" | "blocked" | "late" | "quiet" | "ok";
  error?: string | null;       // why a card is degraded (bd unreachable, registry problem)
}

export interface MachineSnapshot {
  host: string;
  uptimeS: number;
  cpuPct: number;
  cores: number;
  load: [number, number, number];
  mem: { totalMb: number; usedMb: number; pct: number };
  swap: { totalMb: number; usedMb: number; pct: number };
  tempC: number | null;
  disks: { mount: string; totalGb: number; freeGb: number; pct: number }[];
  topRss: { pid: number; name: string; rssMb: number }[];
  cpuSeries24h: number[];      // one sample per 5 min, up to 288
  /** Rolling history kept by the console, since the producer keeps none. */
  series: MachineSeries | null;
  /** Disk and backup health, from the reports two root jobs write on the box. */
  health: MachineHealth;
}

export type HealthLevel = "ok" | "warn" | "crit";

/** Each half is null when its job has never reported on this box. */
export interface MachineHealth {
  disk: DiskHealth | null;
  backup: BackupHealth | null;
}

/** One S.M.A.R.T. reading of the system disk. Figures the drive did not report are null. */
export interface DiskHealth {
  level: HealthLevel;
  /** Why the level is not ok, in words; empty when it is. */
  problems: string[];
  at: string | null;
  device: string;
  model: string;
  passed: boolean | null;
  tempC: number | null;
  /** Share of rated endurance consumed. */
  usedPct: number | null;
  sparePct: number | null;
  /** The drive's own floor for spare capacity. */
  spareThresholdPct: number | null;
  powerOnHours: number | null;
  unsafeShutdowns: number | null;
  mediaErrors: number | null;
}

export interface BackupHealth {
  level: HealthLevel;
  problems: string[];
  /** Where the snapshots go, as a label. */
  target: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** The last attempt's outcome in the job's own words, e.g. "ok" or "skipped: george unreachable". */
  lastResult: string;
}

/** Aligned arrays, oldest first. `temp` is null where the box has no sensor. */
export interface MachineSeries {
  at: string[];
  cpu: number[];
  mem: number[];
  /** Load average normalised by core count, so 1.0 means saturated. */
  load: number[];
  temp: (number | null)[];
}

/** One upcoming event. Every string here was written by somebody else. */
export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** How you answered, or null when it is not an invitation. */
  response: "accepted" | "declined" | "tentative" | "needsAction" | null;
  /** https only; anything else was dropped rather than rendered as a link. */
  meetLink: string | null;
  organizer: string;
  location: string;
}

export interface CalendarReport {
  ok: boolean;
  reason: string | null;
  generatedAt: string;
  events: CalendarEvent[];
}

/** Repos on disk the registry has not been told about, and listed paths that have gone. */
export interface DiscoveredReport {
  found: { id: string; path: string; snippet: string }[];
  missing: { id: string; path: string }[];
}

/**
 * What one project spent, over the usage collector's project window.
 *
 * Attributed by the cwd each transcript records: a rig path, a worktree read
 * back to its rig, or the session registry. Work whose cwd resolves to no
 * project lands under the id "unattributed" rather than being spread across
 * the others, because a made-up split reads exactly like a fact.
 */
export interface ProjectUsage {
  /** A project id from ops/projects.json, a rig name, or "unattributed". */
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The API list-price equivalent of those tokens, in USD. the owner works on a
   * subscription, so this is what the work would have cost through the API,
   * not an invoice. Label it that way wherever it is shown.
   */
  costUsd: number;
  sessions: number;
}

export interface UsageSummary {
  tokensToday: number;
  tokensWeek: number;
  outputTokensToday: number;
  byModelWeek: { model: string; input: number; output: number; cacheRead: number }[];
  /** Per-project spend, costliest first. Empty when nothing was attributed. */
  byProject: ProjectUsage[];
  /** The window `byProject` covers, in days (30). */
  byProjectDays: number;
  sessionsToday: number;
  /** Orchestrator calls and their share of HQ usage (hq-4npjr.7); null before the first summary. */
  orchestrator?: OrchestratorUsage | null;
  planUsage: {
    fiveHourPct: number | null;
    weeklyPct: number | null;
    /** Every window /usage shows (5 h, week, week per model), from the plan-usage timer. */
    limits: PlanLimit[];
    /** When the timer last read the numbers. */
    updatedAt: string | null;
    /** Why the last read failed; the numbers above are then the last good ones. */
    error: string | null;
  };
}

export interface OrchestratorUsageWindow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  models: { model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
}

export interface OrchestratorUsage {
  today: OrchestratorUsageWindow;
  week: OrchestratorUsageWindow;
  /** Orchestrator share of all HQ usage over 7 days (0 to 1), null when unknown. */
  shareOfHq: number | null;
  /** The alert threshold on that share. */
  threshold: number;
  planWeeklyPct: number | null;
  at: string;
}

export interface PlanLimit {
  kind: string;
  /** "5 h", "Week", "Week, Fable". */
  label: string;
  percent: number | null;
  /** "normal" or the endpoint's warning level. */
  severity: string;
  resetsAt: string | null;
  /** The window that is binding right now. */
  active: boolean;
}

export interface CollectorStatus {
  name: string;
  updatedAt: string | null;
  ttlS: number;
  error: string | null;        // last error, null when healthy
  durationMs: number | null;
}

export interface Alert {
  id: string;
  severity: Severity;
  title: string;
  detail: string | null;
  createdAt: string;
  source: string;              // e.g. "meta-close", "activation", "cert", "collector"
  ackable: boolean;
}

// One stream answering "what happened while I was away" (design section 4.1).
// Phase 1 folds the v1 Operations and Recent-changes panels into it: op
// records, git log per rig, asks and answers, and alert error reports.
export type ActivityType =
  | "commit" | "merge"                                  // git log per rig
  | "dispatch" | "finish" | "snooze" | "capture" | "op" // console operations
  | "ask" | "answer"                                    // requests
  | "error";                                            // alerts

export interface ActivityEvent {
  id: string;                  // stable across refreshes, used for dedupe and keys
  ts: string;                  // ISO
  type: ActivityType;
  rig: string | null;
  session: string | null;
  bead: string | null;
  title: string;               // one line, already truncated server-side
  detail: string | null;       // author, answer text, error tail
  sev: Severity | null;        // errors and failed ops carry one
}

// Stack (design 4.3): inventory + evidence, windows applied by record
// timestamp. Verdicts are HINTS a human confirms with keep/revert.
export type StackKind = "tool" | "cli" | "skill" | "hook" | "mcp" | "mcp-profile" | "agent" | "domain" | "automation";
export type StackVerdict = "value" | "friction" | "low-use" | "unused" | "stale" | "quiet";

export interface StackWindowStats { uses: number; sessions: number; errors: number }

export interface StackItem {
  id: string;                   // "<kind>:<name>", stable
  name: string;
  kind: StackKind;
  windows: Record<"7" | "30" | "90", StackWindowStats>;
  lastUsed: string | null;      // ISO of the newest stamped record
  unstamped: number;            // evidence without timestamps, shown as all-time
  blocks90: number;             // hooks: blocks surfaced in the 90-day window
  topBlockReason: string | null;
  tokens90: number;             // coarse: tokens of sessions that used it (labelled "attributed")
  inventory: boolean;           // discovered by the inventory scan (not just seen in use)
  stale: string | null;         // why the item points nowhere
  detail: string | null;        // kind-specific line (hook events, skill scope)
  acquisitions: { id: string; title: string }[];
  verdictHint: StackVerdict;
}

export interface StackReport {
  generatedAt: string;
  windows: number[];
  items: StackItem[];
  error?: string | null;
}

// Services / jobs / automations (design 4.4, P2.3/P2.4/P2.8). Policy lives in
// the guard-protected ops/projects/console/*.json; empty sections mean the
// policy files do not exist yet, a *Error string means one is invalid.
// Flow (bead hq-3y18, design 2026-08-24 section 4.3): lead time, time in
// status and rework per rig, straight off the beads ledgers. Numbers for the
// retro, never triggers. Audit-trail beads (egress-ledger, session-eval) are
// excluded at the collector.
export interface FlowWindow {
  closed: number;               // real-work beads closed in the window
  medianLeadS: number | null;   // created -> closed, median seconds
  p90LeadS: number | null;
  blockedShare: number | null;  // blocked / (blocked + in_progress) time
  reopened: number;             // closed -> open/in_progress transitions
  reworkShare: number | null;   // reopened / closed
}

export interface FlowWeek {
  weekStart: string;            // YYYY-MM-DD (Monday, UTC)
  medianLeadS: number | null;
  closed: number;
}

export interface FlowRig {
  rig: string;
  windows: Record<"7" | "30" | "90", FlowWindow>;
  weekly: FlowWeek[];           // oldest first, for a sparkline
}

export interface FlowReport {
  generatedAt: string;
  rigs: FlowRig[];
}

// ---------- understudy ----------
// The decision model in shadow mode (tools/understudy, proposal 26): it
// predicts every console question when it arrives and is graded when the owner
// answers. Nothing here acts for him; these are the scores of watching.

export interface UnderstudyPoint {
  ts: string;
  answered: number;             // corpus size when the snapshot was taken
  stamped: number;              // predictions made so far
  graded: number;               // predictions whose answer has arrived
  accuracy: number | null;
  brier: number | null;
  skill: number | null;
}

export interface UnderstudyLive {
  stamped: number;
  graded: number;
  abstentions: number;
  accuracy: number | null;      // null until anything is graded
  brier: number | null;         // mean squared error of confidence; 0 is perfect
  skill: number | null;         // vs always guessing the base rate; 0 = no better
}

export interface UnderstudyBacktest {
  n: number;                    // answered decisions in the corpus
  coverage: number;             // share it was willing to answer at all
  accuracy: number | null;
  brier: number | null;
  skill: number | null;
}

export interface UnderstudyReport {
  generatedAt: string;
  corpus: { total: number; answered: number; open: number };
  live: UnderstudyLive;
  backtest: UnderstudyBacktest;
  history: UnderstudyPoint[];   // oldest first, for the trend
}

export interface ServiceRow {
  id: string;
  label: string;
  kind: "systemd-user" | "systemd-system" | "docker" | "tmux";
  unit: string;
  restartable: boolean;
  logs: boolean;
  state: string;               // active | inactive | failed | unavailable | ...
  detail?: string | null;
  since?: string | null;
  restarts?: number;
}

export interface JobRow {
  id: string;
  label: string;
  kind: string;
  heartbeat: string;
  source: string;              // "mtime" | "json:<field>"
  cadenceS: number;
  lastRun: string | null;
  state: "ok" | "stale" | "missing" | "malformed" | "future";
  missed: boolean;
  detail?: string | null;
}

export interface MailAutomation {
  flags: { disabled: boolean; logOnly: boolean };
  heartbeats: { id: string; cadenceS: number | null; lastRun: string | null; state: string }[];
  recentRuns: { file: string; tail: string }[];
}

export interface ServicesReport {
  generatedAt: string;
  services: ServiceRow[];
  servicesError: string | null;
  jobs: JobRow[];
  jobsError: string | null;
  automations: { mail: MailAutomation };
}

// Money (design 4.5, P2.6/P2.10). Integer cents; currencies are never
// combined; the series range is whatever usage.py actually has.
export interface MoneyEntry {
  id: string;
  ts: string;
  amountCents: number;         // POSITIVE = money out (a cost), NEGATIVE = money in
  currency: "MXN" | "USD";
  category: string;
  note: string;
  client: string | null;       // who this is for; drives the client rollup
  vendor: string | null;       // who was paid; a tool or a service
  project: string | null;      // which project it belongs to; drives effort attribution
}

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

/** A scheduled repeating payment. A SCHEDULE, never money that has moved. */
export interface MoneyCommitment {
  id: string;
  label: string;
  amountCents: number;         // POSITIVE = a subscription or tool, NEGATIVE = a retainer coming in
  currency: "MXN" | "USD";
  category: string;
  cadence: Cadence;
  startsOn: string;            // yyyy-mm-dd
  endsOn: string | null;
  client: string | null;
  vendor: string | null;
  project: string | null;
  monthlyCents: number;        // normalised to a month whatever the cadence
  nextDueOn: string | null;    // null once it has ended
}

/** What a goal is about: money in for a month, money out held under a cap for a month, or the running net reached. */
export type GoalKind = "in" | "out" | "net";

/**
 * A target the Money tab measures the ledger against. Never money itself: the
 * server stores it, the web computes the progress from the ledger rows.
 */
export interface MoneyGoal {
  id: string;
  label: string;
  kind: GoalKind;
  targetCents: number;         // always positive; the kind says which way
  currency: "MXN" | "USD";
  month: string | null;        // yyyy-mm for in/out; null means every month (the current one is measured)
  by: string | null;           // yyyy-mm-dd deadline for net; null means no deadline
  client: string | null;       // in/out only: count this client's rows alone
  createdAt: string;
}

export interface MoneyGoalInput {
  label: string;
  kind: GoalKind;
  targetCents: number;
  currency: "MXN" | "USD";
  month?: string | null;
  by?: string | null;
  client?: string | null;
}

export interface MoneyFlow {
  currency: "MXN" | "USD";
  inCents: number;
  outCents: number;
  netCents: number;
}

export interface MoneyRunRate extends MoneyFlow {
  count: number;
}

export interface MoneyClient {
  client: string;
  projects: string[];          // learned from the tags on payments, not configured
  commitmentCount: number;
  tokens: number;              // agent effort across this client's projects
  sessions: number;
  money: { currency: "MXN" | "USD"; inCents: number; outCents: number; monthlyCents: number }[];
}

export interface MoneyReport {
  generatedAt: string;
  rangeDays: number;
  series: { day: string; input: number; output: number; cacheRead: number; sessions: number }[];
  ledger: MoneyEntry[];        // visible entries, newest first, capped at 500
  totals: { month: string; currency: string; cents: number }[];
  commitments: MoneyCommitment[];
  runRate: MoneyRunRate[];     // committed monthly position, a forecast
  flows: MoneyFlow[];          // what actually moved
  clients: MoneyClient[];
  goals: MoneyGoal[];          // targets; progress is computed in the web from `ledger`
  fx: MoneyFx | null;          // display-only folding rate; the ledger never converts
  apiSpend: MoneyApiSpend | null; // live Codex/OpenAI spend; null when the collector is absent
}

/**
 * Live API spend read from OpenAI's org costs endpoint. NOT ledger data: it is
 * a vendor's live readout, held apart so an invoice later recorded in the
 * ledger for the same spend cannot silently double-count. `configured` false
 * means no admin credential is set and the card says so.
 */
export interface MoneyApiSpend {
  source: "openai";
  configured: boolean;
  currency: "USD";
  days: { day: string; cents: number }[]; // daily buckets, ascending, integer cents
  monthCents: number;                     // this calendar month's total
  error: string | null;                   // classified, never provider text
}

/**
 * The rate the web uses to fold USD figures into MXN for the combined view.
 * Metadata about DISPLAY, never about the record: every stored amount and every
 * server-side sum stays in its own currency. Null when no rate has ever been
 * fetched, and the tab then shows per-currency figures rather than inventing one.
 */
export interface MoneyFx {
  base: "MXN";
  mxnPerUsd: number;
  asOf: string;                // the rate's own date (ECB reference), yyyy-mm-dd
  stale: boolean;              // true when this is a cached rate the API could not refresh
}

// Uptime Kuma monitors (design 4.4, P2.5 credential-free half): Kuma keeps
// probing, the console only displays what it already knows.
export interface MonitorRow {
  id: string;
  name: string;
  group: string;
  state: "up" | "down" | "pending" | "maintenance" | "unknown";
  lastCheck: string | null;
  pingMs: number | null;
  uptime24: number | null;    // percent, one decimal
}

export interface MonitorsReport {
  generatedAt: string;
  source: string | null;      // the status page URL, for the panel's link
  monitors: MonitorRow[];
  error: string | null;       // unreachable or unconfigured; never a fake "all up"
}

// Cloud deploys (design 4.4). Tokens live only in the server's environment;
// a provider without one reports configured:false rather than an error.
export interface DeployRow {
  id: string;
  provider: "vercel" | "n8n";
  name: string;
  state: "ok" | "failed" | "building" | "unknown";
  detail: string | null;
  at: string | null;
  url: string | null;
}

export interface DeploysReport {
  generatedAt: string;
  deploys: DeployRow[];
  providers: { provider: string; configured: boolean; error: string | null; partial?: boolean }[];
}

/** The Capri voice ear's live state, written by the ear to
 * state/console/ear-state.json and pushed to the dashboard indicator.
 * "offline" is synthesized by the server when the file is missing or stale
 * (the ear heartbeats "idle" every ~20s). "muted" means the ear is RUNNING but
 * holding no microphone (the owner turned it off, e.g. a laptop in public), which
 * is deliberately distinct from offline. */
export type EarPhase = "offline" | "muted" | "idle" | "wake" | "listening" | "thinking" | "speaking";
export interface EarState {
  state: EarPhase;
  at: string | null;      // ISO time of the last transition/heartbeat
  text?: string | null;   // the last thing heard, while thinking/speaking
  online: boolean;
  /** Long-task progress, 0 to 1, or null for work of unknown length. Null is
   * meaningful: the indicator shows an ember rather than inventing a number,
   * because a fill that guesses is a lie told confidently. Emitted at most
   * twice a second; the client rate-limits the fill so a jump pours. */
  progress?: number | null;
  /** Whose voice the ear verified. Absent means the check is not running. */
  speaker?: "yours" | "unknown" | "enrolling";
}

// ---------- Board ----------
// One row per project, read as a checklist (server/src/projects/board.js).
export interface BoardItem {
  id: string;
  title: string;
  status: Bead["status"];
  priority: number;
  kind: string;
  closedAt: string | null;
}
export interface BoardProject {
  id: string;
  name: string;
  sphere: "work" | "personal" | null;
  client: string | null;
  status: "active" | "paused" | "done";
  goal: string | null;
  attention: ProjectSummary["attention"];
  completion: number | null;
  needsYou: number;
  counts: ProjectSummary["counts"];
  lastCommit: { subject: string; at: string | null } | null;
  /** The phase in motion and its child rollup; null when the project has no epics. */
  epic: { id: string; title: string; done: number; total: number } | null;
  /** "epic": the checklist is that epic's children. "recent": no epic, so done is the last fortnight's closes and todo is every open bead. */
  scope: "epic" | "recent";
  /** What is moving now (in_progress), else what bd ready offers, else null. */
  next: { id: string; title: string; status: "in_progress" | "ready" } | null;
  blocked: BoardItem[];
  done: BoardItem[];
  todo: BoardItem[];
  doneTotal: number;
  todoTotal: number;
  error: string | null;
}
export interface BoardReport {
  generatedAt: string;
  projects: BoardProject[];
}

// ---------- Errors (bead hq-hsl2.3; server/src/errors.js) ----------
export type IncidentStatus = "escalated" | "fixing" | "watching" | "fixed" | "logged" | "resolved" | "unknown";
export interface IncidentPane {
  id: string | null;           // tmux pane id (%N) on owner's default tmux server
  target: string | null;
  socket: string | null;       // non-null means a non-default tmux server: not attachable
  alive: boolean;
  attachable: boolean;
  reason: string | null;       // why it is not attachable
}
export interface Incident {
  id: string;
  fp: string | null;
  project: string | null;
  title: string;
  host: string | null;
  openedTs: number | null;     // epoch seconds
  updatedTs: number | null;
  status: IncidentStatus;
  rawStatus: string | null;    // the file's status when it is outside the contract
  repeats: number;
  lastRepeatTs: number | null;
  mid: string | null;
  body: string | null;
  fixer: {
    tmuxTarget: string | null; tmuxSocket: string | null; promptPath: string | null; logPath: string | null;
    startedTs: number | null; endedTs: number | null; rc: number | null; tmuxWindowId: string | null;
  } | null;
  result: { marker: "FIXED" | "ESCALATE" | "NONE"; summary: string | null; receipt: string | null; rc: number | null } | null;
  bead: string | null;
  note: string | null;
  resolvedTs: number | null;
  mailPending: boolean;        // an outbox item has done:false
  conditionSinceTs: number | null; // failing since
  lastSeenTs: number | null;
  loopdeadAlertTs: number | null;
  policy: string | null;       // why it is only being watched
  pane: IncidentPane | null;   // fixing incidents only
}
export interface FpVolume {
  fp: string;
  project: string | null;
  title: string | null;
  total: number | null;        // events in the window; null when only fps.last_ts is known
  buckets: number[] | null;    // one per hour, oldest first; null without fp_events
  lastTs: number | null;
  count: number | null;        // lifetime count from fps
}
export interface ErrorsReport {
  generatedAt: string;
  dir: string;                 // "ok" | "missing" | an unreadable reason
  incidents: Incident[];       // newest first
  malformed: { file: string; error: string }[];
  omitted: number;             // history (fixed/logged/resolved) dropped by the cap; actionable is never capped
  counts: Record<IncidentStatus, number>;
  volume: { source: "fp_events" | "fps" | "none"; since: number | null; hours: number; fps: FpVolume[]; error: string | null };
}

// ---------- reports (hq-o6wn.4; the store is ops/reports/publish.py) ----------
export type ReportKind = "error" | "digest" | "fixed" | "logged" | "escalate" | "reply" | "security" | "stack" | "retro";

export interface ReportHeader {
  id: string;
  kind: ReportKind;
  title: string;
  project: string;
  created: string;             // ISO 8601
  severity: "P0" | "P1" | "P2" | "info" | string;
  source: string;
  hasHtml: boolean;
  read: boolean;
}

export interface ReportDetail extends ReportHeader {
  body_md: string;
  body_html: string | null;    // already sanitized on the server: allowlisted tags, no styles, no images
}

export interface ReportsPage {
  total: number;               // rows matching the filter
  unread: number;              // unread across the whole store
  offset: number;
  limit: number;
  items: ReportHeader[];       // newest first
}

/** total and unread are null with an error when read.json is unreadable. */
export interface ReportsSummary {
  total: number | null;
  unread: number | null;
  error?: string;
}

export interface ConsoleState {
  generatedAt: string;
  version: { release: string; protocol: number };
  owner: string;               // login the server trusts
  sessions: Session[];
  requests: Request[];
  ready: ReadyBead[];
  projects: ProjectSummary[];
  machine: MachineSnapshot | null;
  usage: UsageSummary | null;
  alerts: Alert[];
  activity: ActivityEvent[];
  stack: StackReport | null;
  flow: FlowReport | null;
  understudy: UnderstudyReport | null;
  services: ServicesReport | null;
  money: MoneyReport | null;
  calendar: CalendarReport | null;
  discovered: DiscoveredReport | null;
  monitors: MonitorsReport | null;
  deploys: DeploysReport | null;
  ear: EarState | null;
  board: BoardReport | null;
  /** Optional so an older server (or a mock) without the slice still type-checks. */
  errors?: ErrorsReport | null;
  /** Optional so an older server (or a mock) without the summary still type-checks. */
  reports?: ReportsSummary | null;
  collectors: CollectorStatus[];
  badges: { now: number; nowSeverity: Severity | null; projects: number; stack: number; machines: number; reports?: number };
}

// Orchestrator panels on Now (hq-4npjr.5). GET /api/orchestrator -> OrchestratorReport.
// POST /api/orchestrator/load {id} | /api/orchestrator/unload {id} -> {ok, id} (id = upload id).
export type ApprovedKind = "merge" | "review" | "answer" | "snooze" | "wake" | "dispatch" | "forward" | "fix" | "block";
export interface ApprovedRow {
  ts: string;
  kind: ApprovedKind;
  text: string;
  why: string | null;
  bead: string | null;
  rig: string | null;
}
export interface LoadedFile { id: string; name: string; size: number; at: string }
export interface OrchestratorReport {
  approved: ApprovedRow[];      // newest first
  approvedToday: number;
  eventsToday: number | null;   // null until the event runner has written its file
  updates: Record<string, { at: string; text: string }>;
  loaded: LoadedFile[];
}

// ---------- REST ----------
// GET  /api/state                          -> ConsoleState
// GET  /api/state/:collector               -> { slice, data } envelope for one slice (sessions|requests|ready|projects|machine|usage|alerts|activity)
// GET  /api/reports?kind=&unread=1&limit=50&offset=0 -> ReportsPage (400 unknown kind; limit 1..200)
// GET  /api/reports/:id                     -> ReportDetail (404 unknown); reading does not mark it read
// POST /api/reports/:id/read                -> { ok, total, unread } (404 unknown, 409 read-only)
// POST /api/reports/read-all {kind?}        -> { ok, marked, total, unread }
// WS   state slice "reports"                -> ReportsSummary, pushed when the count changes
// POST /api/errors/:id/resolve             -> { ok, id, status:"resolved", from } (404 unknown, 409 already resolved, 422 malformed file)
// POST /api/ws-token                        -> { token, expiresInS }   (one-use, 30 s, bound to the peer ADDRESS; the browser upgrades on a new TCP connection so the port cannot be bound; CONSOLE_WS_TOKEN_STRICT_PORT=1 binds the full tuple for tests)
// POST /api/answer   {rid, text}            -> Op
// POST /api/resolve  {rid, reason?}         -> Op
// POST /api/done     {rid}                  -> Op   (run cards)
// POST /api/skip     {rid, reason}          -> Op
// POST /api/req-snooze {rid, until}         -> Op
// POST /api/req-unsnooze {rid}              -> Op
// POST /api/req-clear {rid}                 -> Op (ctl clear: an undelivered answer leaves the board)
// POST /api/sink     {rid, top?}            -> Op
// POST /api/dispatch {rig, bead, model}     -> Op
// POST /api/dispatch-batch {rig, beads[], model} -> Op
// POST /api/session/:id/(focus|snooze|kill|finish|finish-check|name) -> Op
// POST /api/phase    {bead, phase, done}    -> Op
// POST /api/capture  {rig, title, body?}    -> Op   (bd create)
// POST /api/stack-keep   {item, bead?, note?} -> Op  (bd comment on the acquisition bead, or a new stack-verdict bead)
// POST /api/stack-revert {item, bead?, note?} -> Op  (same; the UI shows the recorded revert command, nothing executes)
// GET  /api/service/:id/logs?n=50            -> { id, lines } (allowlisted, logs-enabled entries only)
// POST /api/service-restart {service, op?}    -> Op  (allowlisted restartable entries; send op for idempotent retries)
// POST /api/mail-switch {switch: disabled|log-only, on: bool, op?} -> Op
// POST /api/money/entry  {op, amountCents, currency, category, note?} -> MoneyEntry (201; 200 on an op-key replay)
// POST /api/money/delete {op, target} -> { ok, target } (404 unknown, 409 already deleted)
// POST /api/upload  (multipart, one file; headers X-Upload-Id, X-Upload-Size, X-Upload-Sha256) -> UploadResult
// GET  /api/uploads?date=YYYY-MM-DD         -> UploadEntry[]
// POST /api/alerts/:id/ack                  -> { ok: boolean }   (no process runs, so no Op)
// GET  /api/op/:id                          -> Op
// GET  /healthz                              -> { ok, release, protocol, checks: {...} }
// All POST require header X-Console-Key (per-boot CSRF key injected into index.html as window.__CONSOLE_BOOT_KEY__).
// Every action POST accepts an optional idempotency key `op` in the JSON body; a replay returns the stored Op with 200 instead of 202.
// Skip semantics: POST /api/skip records "skipped: <reason>" as the ANSWER so a waiting worker continues (design section 5); /api/resolve dismisses without text.

export interface Op {
  id: string;
  verb: string;
  state: "queued" | "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  output: string | null;       // filtered stdout/stderr tail
  error: string | null;
  meta?: Record<string, string> | null; // id-shaped context (rig/bead/session/rid), for the activity stream
  /**
   * Set on a completed `finish-check`: an approval stamped over THIS op and the exact
   * gate text it produced. `finish {confirm: true}` will only run when handed it back
   * alongside `approvedOp`, so a click always answers a specific, recent reading.
   */
  seal?: string | null;
  /**
   * What this operation does to the world, from the server's effect declaration:
   * read (changes nothing), local (HQ's own bookkeeping), destructive (loses or spends
   * something), outward (reaches past this box). Recorded so activity can say what an
   * operation WAS rather than only what it was called.
   */
  effect?: "read" | "local" | "destructive" | "outward" | null;
}

export interface UploadResult {
  id: string;
  path: string;                // absolute path on hqbox
  size: number;
  sha256: string;
  committedAt: string;
  duplicateOf?: string;        // set when an existing committed row was returned
}

export interface UploadEntry {
  id: string; name: string; path: string; size: number; sha256: string; committedAt: string; keep: boolean; expiresAt: string | null;
  /**
   * `hqconsole://upload/<id>`: the stable way to cite this file. Safe to write into a
   * bead, a note, a seed or the vault, because it survives the bytes being swept and
   * resolving it back to a path goes through a gate that re-checks state, expiry and
   * containment at the moment of use. `path` is the convenience copy for the card.
   */
  ref: string;
}

// ---------- WebSocket ----------
// Client connects to wss://host/ws with Sec-WebSocket-Protocol: "hq-console-v1, tok.<token>".
// Server validates token (one-use, unexpired, bound to the peer address that minted it) and exact Origin header.
export const WS_PROTOCOL = "hq-console-v1";
export const PROTOCOL_VERSION = 1;

// Capri, the meta terminal (proposal 19). GET /api/meta/status.
export interface MetaStatus {
  enabled: boolean;
  passkeys: number;
  bootstrap: boolean;                                   // no credential registered yet
  /** Proposal 31: false when root waived the passkey on this single-user box
   *  (the tailnet origin is the gate). Absent or true means passkey required. */
  requirePasskey?: boolean;
  live: { sid: string; startedAt: string; lastInputAt?: string; attachers?: number } | null;
  unreconciled: string[];
  lastClose: { sid: string; closedAt?: string; endedBy?: string; integrity?: unknown; reconcile?: unknown } | null;
  runnerDown?: boolean;
}
export interface PasskeyInfo { id: string; label: string; createdAt: string; lastUsedAt: string | null }

export type ServerMessage =
  /**
   * First message on every socket. `state` is null when the compile itself
   * failed (`error` says why); a slice whose collector row in
   * `state.collectors` has `updatedAt: null` with an `error` never succeeded,
   * so its value is an empty placeholder, not an observation. Clients merge
   * rather than replace (web/src/data/hello.ts): a restarted server's cold
   * hello used to overwrite a populated page with those placeholders, which
   * read as the whole console wiping itself.
   */
  | { t: "hello"; release: string; protocol: number; owner: string; state: ConsoleState | null; error?: string }
  | { t: "state"; slice: keyof ConsoleState; data: unknown; generatedAt: string }   // full slice replace
  | { t: "alert"; alert: Alert }
  | { t: "op"; op: Op }
  | { t: "term.open"; sid: string; replay: string; cols: number; rows: number; writable: boolean }
  | { t: "term.data"; sid: string; data: string }
  | { t: "term.exit"; sid: string; code: number | null }
  | { t: "term.size"; sid: string; cols: number; rows: number }   // the program's size changed (another viewer resized it)
  | { t: "term.error"; sid: string; error: string }
  | { t: "meta.inject"; sid: string; id: string; text: string }   // route 3 voice draft for the Capri tab (proposal 25)
  | { t: "capri"; event: "wake" | "done"; at: string; id?: string }   // Capri wake word from George: focus the orchestrator input (hq-ymxzt.2); a wake carries an id the page acks
  | { t: "pong"; ts: number };

export type ClientMessage =
  | { t: "subscribe"; slices: (keyof ConsoleState)[] }
  | { t: "term.attach"; sid: string; cols: number; rows: number; capability?: string }  // capability: Capri (meta) only, one-use
  | { t: "term.detach"; sid: string }
  | { t: "term.input"; sid: string; data: string }        // interactive/meta only; ignored for workers
  | { t: "term.resize"; sid: string; cols: number; rows: number }
  /** Console terminals only (runner-owned): a one-row PTY wiggle so tmux and the
   *  program repaint the whole screen. Needs an attachment; refusals are silent. */
  | { t: "term.redraw"; sid: string }
  /** Capri (hq-ymxzt.3): whether this page put the cursor in the orchestrator input for wake `id`. */
  | { t: "capri.ack"; id: string; focused: boolean }
  | { t: "ping"; ts: number };

// ---------- Phase 1 additions ----------
// Projects
// GET  /api/projects                          -> ProjectSummary[]  (same as state.projects)
// GET  /api/projects/:id                      -> ProjectDetail
// GET  /api/projects/:id/beads?status=open|in_progress|blocked|closed|deferred  -> Bead[]   (no status: every status)
// POST /api/projects/:id/beads/:bead {due: "YYYY-MM-DD"}   -> Bead   (bd update --due through the wrapper)
// GET  /api/projects/:id/timeline             -> TimelineItem[] (projection, see design 4.2)
// GET  /api/projects/:id/flow?epic=<id>       -> FlowGraph (no epic: epics plus unparented beads)
// GET  /api/projects/:id/truths               -> TruthsDoc
// POST /api/projects/:id/truths  {rev, entries: TruthEntry[]}   -> TruthsDoc (409 on stale rev)
// GET  /api/projects/:id/doc?name=knowledge|hub|decisions        -> { name, markdown, path, updatedAt }
export interface Bead {
  id: string; title: string; status: "open" | "in_progress" | "blocked" | "closed" | "deferred";
  priority: number; labels: string[]; type: string; parent: string | null; deps: string[];
  due: string | null; deferUntil: string | null; estimateMin: number | null;
  createdAt: string; closedAt: string | null; assignee: string | null;
}
export interface Commit { sha: string; at: string; author: string; subject: string }
export interface ProjectDetail {
  summary: ProjectSummary;
  beads: { open: number; inProgress: number; blocked: number; closed: number; deferred?: number; byLabel: Record<string, number> };
  error?: string | null;
  epics: { id: string; title: string; due: string | null; children: number; closed: number }[];
  commits: Commit[];               // last 20 on the default branch
  docs: { knowledge: boolean; hub: boolean; decisions: boolean };   // availability
  sessionEval: { at: string; session: string; verdict: string; summary: string }[];
  truthsRev: number;
}
export interface TimelineItem {
  id: string; title: string; kind: "bead" | "epic";
  status: Bead["status"]; start: string; end: string;   // ISO, projected for open items
  projected: boolean; due: string | null; late: boolean;
  deps: string[]; critical: boolean; parent: string | null;
}
// Flow chart (bead hq-c4pl0.1). state: done closed; waiting an open request
// names it; blocked; active in progress; deferred; upcoming anything else.
// An epic rolls up from its children. A stub is a dep outside the scope.
export type FlowState = "done" | "active" | "waiting" | "blocked" | "upcoming" | "deferred";
export interface FlowNode {
  id: string; title: string; kind: "epic" | "bead" | "stub";
  status: Bead["status"]; state: FlowState; parent: string | null;
  childCount: number; doneCount: number;
}
export interface FlowEdge { from: string; to: string }   // from must close before to
export interface FlowGraph { project: string; epic: string | null; epicTitle: string | null; nodes: FlowNode[]; edges: FlowEdge[] }
// Authored process charts (bead hq-c4pl0.4): <vault>/01 Projects/<rig>/flows/<name>.mmd
// GET /api/projects/:id/flows -> ProcessChartInfo[] (newest first); GET .../flows/:name -> ProcessChartSource
export interface ProcessChartInfo { name: string; title: string; updatedAt: string | null }
export interface ProcessChartSource { name: string; source: string }
export type TruthKind = "term" | "truth" | "assumption" | "constraint";
export interface TruthEntry {
  id: string; kind: TruthKind; text: string; confirmed: boolean;
  added: string; source: string | null;    // ISO, free text (bead id, person)
}
export interface TruthsDoc { project: string; rev: number; updatedAt: string | null; entries: TruthEntry[] }

// Uploads
// POST /api/upload  multipart, ONE file field "file"; headers X-Upload-Id (uuid), X-Upload-Size, X-Upload-Sha256
//   -> 201 UploadResult | 200 UploadResult (retry of a committed id, same size+hash) | 409 (id in progress or content mismatch) | 410 (deleted id) | 413 | 503 + Retry-After (concurrency cap) | 507 (quota/free space)
// GET  /api/uploads?date=YYYY-MM-DD           -> UploadEntry[]
// POST /api/uploads/:id/keep  {keep: boolean} -> UploadEntry
// POST /api/uploads/:id/delete                -> { ok: true }

// Terminals (server proxies to hq-runner over its unix socket; see runner/PROTOCOL.md)
// Session.attachable/writable come from the runner's list; term.* WS messages are unchanged.
// POST /api/session/new  {kind: "interactive", rig?: string, cwd?: string} -> Op (spawns via the runner as owner)
