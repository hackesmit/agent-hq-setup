// A realistic ConsoleState for development, taken from the approved mockup
// (docs/superpowers/specs/2026-08-18-console-v2-directions.html) so the shell can be
// read and reviewed before the collectors exist.
//
// Used when VITE_MOCK=1, or when /api/state is unreachable during dev. It is never a
// fallback in production: a failed fetch against a real server surfaces as an error,
// because inventing sessions and requests that do not exist would be worse than a blank
// panel. Timestamps are computed relative to load so ages read sensibly.

import type {
  ActivityEvent,
  Alert,
  DeploysReport,
  MoneyReport,
  MonitorsReport,
  ServicesReport,
  StackItem,
  StackReport,
  CollectorStatus,
  ConsoleState,
  MachineSnapshot,
  ProjectSummary,
  ReadyBead,
  Request,
  Session,
  UsageSummary,
} from "@shared/api";

export const MOCK_ENABLED = import.meta.env.VITE_MOCK === "1";

function ago(minutes: number, base: number): string {
  return new Date(base - minutes * 60_000).toISOString();
}

/** Per-day counts, not a running total: quiet days have to come out as zero. */
function series(seed: number, n: number, step: number): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(Math.round((s / 2147483648) * step));
  }
  return out;
}

function cpuSeries(seed: number, n: number): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(6 + Math.round((s / 2147483648) * 48));
  }
  return out;
}

function sessions(now: number): Session[] {
  return [
    // The orchestrator chat terminal (hq-4npjr.5): Now puts it on top.
    {
      id: "s-orch",
      kind: "interactive",
      rig: "hq",
      bead: null,
      model: "claude-opus-5-5",
      branch: null,
      worktree: "/home/owner/hq",
      state: "running",
      startedAt: new Date(now - 3 * 3600e3).toISOString(),
      lastActivityAt: new Date(now - 20e3).toISOString(),
      phases: [],
      wakeAt: null,
      runner: "tmux",
      focusable: false,
      attachable: false,
      writable: false,
      name: "orchestrator",
      task: null,
      turn: "idle",
      turnAt: null,
    },
    {
      id: "w-3f2a",
      kind: "worker",
      rig: "fintrack-portfolio",
      bead: "dh-41",
      model: "Opus 4.8",
      branch: "bead/dh-41-checkout-webhook",
      worktree: "/home/owner/hq-fintrack-dh41",
      state: "waiting",
      startedAt: ago(74, now),
      lastActivityAt: ago(41, now),
      phases: [
        { name: "read", done: true },
        { name: "plan", done: true },
        { name: "migrate", done: true },
        { name: "tests", done: false },
        { name: "summary", done: false },
      ],
      wakeAt: null,
      runner: "tmux",
      attachable: true,
      focusable: true,
      writable: false,
      name: null,
      task: null,
      turn: null,
      turnAt: null,
    },
    {
      id: "w-91c0",
      kind: "worker",
      rig: "acme-dashboard",
      bead: "xd-207",
      model: "Opus 4.7",
      branch: "bead/xd-207-error-drain",
      worktree: "/home/owner/hq-acme-xd207",
      state: "running",
      startedAt: ago(28, now),
      lastActivityAt: ago(0, now),
      phases: [
        { name: "read", done: true },
        { name: "plan", done: true },
        { name: "implement", done: true },
        { name: "tests", done: true },
        { name: "review", done: false },
        { name: "summary", done: false },
      ],
      wakeAt: null,
      runner: "tmux",
      attachable: true,
      focusable: true,
      writable: false,
      name: null,
      task: null,
      // mid-turn: the working cue
      turn: "working",
      turnAt: ago(1, now),
    },
    {
      id: "w-77be",
      kind: "worker",
      rig: "chesski",
      bead: "ck-81",
      model: "Opus 4.8",
      branch: "bead/ck-81-drill-engine",
      worktree: "/home/owner/hq-chesski-ck81",
      state: "finishable",
      startedAt: ago(190, now),
      lastActivityAt: ago(9, now),
      phases: [
        { name: "read", done: true },
        { name: "implement", done: true },
        { name: "tests", done: true },
        { name: "review", done: true },
      ],
      wakeAt: null,
      runner: "tmux",
      attachable: true,
      focusable: true,
      writable: false,
      name: null,
      task: null,
      turn: null,
      turnAt: null,
    },
    {
      id: "i-0a41",
      kind: "interactive",
      rig: null,
      bead: null,
      model: "Opus 4.8",
      branch: null,
      worktree: "/home/owner/hq",
      state: "idle",
      startedAt: ago(320, now),
      lastActivityAt: ago(52, now),
      phases: [],
      wakeAt: null,
      runner: "pty",
      attachable: true,
      focusable: true,
      writable: true,
      name: null,
      task: null,
      turn: null,
      turnAt: null,
    },
    {
      // its turn ended at the prompt: finished and killable, the red border
      id: "i-5d12",
      kind: "interactive",
      rig: "lodgeco-system",
      bead: null,
      model: "Opus 4.8",
      branch: null,
      worktree: "/home/owner/hq/rigs/lodgeco-system",
      state: "running",
      startedAt: ago(90, now),
      lastActivityAt: ago(4, now),
      phases: [],
      wakeAt: null,
      runner: "pty",
      attachable: true,
      focusable: true,
      writable: true,
      name: null,
      task: null,
      turn: "idle",
      turnAt: ago(4, now),
    },
  ];
}

function requests(now: number): Request[] {
  return [
    {
      id: "r-1187",
      kind: "run",
      severity: "P0",
      state: "open",
      rig: "fintrack-portfolio",
      bead: "dh-41",
      session: "w-3f2a",
      createdAt: ago(41, now),
      ageSeconds: 41 * 60,
      question: "Supabase migration for the orders table needs your service key. I cannot run it from the worktree.",
      command: "cd ~/hq/rigs/fintrack-portfolio && supabase db push --linked",
      link: null,
      why: "The worktree has no service role key.",
      answer: null,
      settledAt: null,
      snoozedUntil: null,
      meta: {},
    },
    {
      id: "r-1188",
      kind: "decide",
      severity: "P1",
      state: "open",
      rig: "acme-dashboard",
      bead: "xd-207",
      session: "w-91c0",
      createdAt: ago(12, now),
      ageSeconds: 12 * 60,
      question: "Fly read token still does not exist; park the Fly source or stub it?",
      command: null,
      link: null,
      why: "Blocking the drain's third source. Parking keeps the two live sources shipping today.",
      answer: null,
      settledAt: null,
      snoozedUntil: null,
      meta: {},
    },
    {
      id: "r-1189",
      kind: "autofix",
      severity: "P2",
      state: "open",
      rig: "acme-dashboard",
      bead: null,
      session: null,
      createdAt: ago(122, now),
      ageSeconds: 122 * 60,
      question:
        "Vercel build failed on acme (missing env NEXT_PUBLIC_SUPABASE_URL in preview). Autofix opened branch autofix/3f9c and tests pass. Approve merge?",
      command: null,
      link: "https://vercel.com/your-gh-user/orbit-acme-dashboard",
      why: "Autofix loop, attempt 1 of 3 for this fingerprint.",
      answer: null,
      settledAt: null,
      snoozedUntil: null,
      meta: { branch: "autofix/3f9c", headSha: "9c31ab2", baseSha: "aabae8c" },
    },
    {
      id: "r-1184",
      kind: "info",
      severity: "P2",
      state: "resolved",
      rig: "hq",
      bead: "hq-d3y9",
      session: null,
      createdAt: ago(300, now),
      ageSeconds: 300 * 60,
      question: "git-sync heartbeat parked until patch 17 lands. No action needed.",
      command: null,
      link: null,
      why: null,
      answer: "ack",
      settledAt: null,
      snoozedUntil: null,
      meta: {},
    },
  ];
}

const ready: ReadyBead[] = [
  {
    rig: "acme-dashboard",
    id: "xd-211",
    title: "Rango de fechas persiste en localStorage",
    priority: 2,
    labels: ["ui"],
    kind: "task",
    due: "2026-08-20",
    estimateMin: 15,
    model: "Opus 4.7",
  },
  {
    rig: "chesski",
    id: "ck-88",
    title: "Endgame drill: K+P vs K",
    priority: 2,
    labels: ["engine"],
    kind: "task",
    due: null,
    estimateMin: 45,
    model: "Opus 4.8",
  },
  {
    rig: "gym-tracker",
    id: "gt-54",
    title: "Set counter off-by-one on delete",
    priority: 3,
    labels: ["bug"],
    kind: "task",
    due: null,
    estimateMin: 10,
    model: "Sonnet 5",
  },
  {
    rig: "fintrack-portfolio",
    id: "dh-42",
    title: "Order emails (Resend)",
    priority: 1,
    labels: ["redteam"],
    kind: "task",
    due: "2026-08-24",
    estimateMin: 60,
    model: "Opus 4.8",
  },
];

function projects(now: number): ProjectSummary[] {
  return [
    {
      id: "fintrack-portfolio",
      name: "fintrack-portfolio",
      kind: "rig",
      status: "active",
      sphere: null,
      client: null,
      spawnable: true,
      completion: 0.62,
      worth: "$45,000 MXN",
      earned: { mxnCents: 1250000, usdCents: 0 },
      tokens30d: 4_120_000,
      costUsd30d: 21.4,
      startedAt: "2026-06-02T00:00:00Z",
      activeEpic: { id: "dh-40", title: "Order emails", done: 3, total: 7 },
      goal: "Shop live for the fall drop.",
      targetDate: "2026-09-12",
      counts: { open: 14, inProgress: 2, blocked: 1, closed7d: 9 },
      activity30d: series(7, 30, 2),
      activitySource: "commits",
      activityTruncated: false,
      lastMergeAt: ago(120, now),
      lastDeploy: { state: "ok", at: ago(180, now), url: "https://fintrack-portfolio.example.com" },
      needsYou: 1,
      nextUp: { id: "dh-42", title: "Order emails (Resend)" },
      attention: "needs-you",
    },
    {
      id: "acme-dashboard",
      name: "acme-dashboard",
      kind: "rig",
      status: "active",
      sphere: null,
      client: null,
      spawnable: true,
      completion: 0.81,
      worth: null,
      earned: { mxnCents: 0, usdCents: 0 },
      tokens30d: 860_000,
      costUsd30d: 4.9,
      startedAt: "2026-05-12T00:00:00Z",
      activeEpic: null,
      goal: "Monthly report v2 for Orbit Acme.",
      targetDate: "2026-08-29",
      counts: { open: 21, inProgress: 1, blocked: 0, closed7d: 12 },
      activity30d: series(11, 30, 3),
      activitySource: "commits",
      activityTruncated: false,
      lastMergeAt: ago(22, now),
      lastDeploy: { state: "ok", at: ago(22, now), url: "https://orbit-acme-dashboard.vercel.app" },
      needsYou: 1,
      nextUp: { id: "xd-211", title: "Rango de fechas persiste en localStorage" },
      attention: "needs-you",
    },
    {
      id: "chesski",
      name: "chesski",
      kind: "rig",
      status: "active",
      sphere: null,
      client: null,
      spawnable: true,
      completion: 0.35,
      worth: null,
      earned: null,
      tokens30d: null,
      costUsd30d: null,
      startedAt: "2026-07-01T00:00:00Z",
      activeEpic: null,
      goal: "v0.3 endgame drills.",
      targetDate: null,
      counts: { open: 33, inProgress: 1, blocked: 0, closed7d: 6 },
      activity30d: series(3, 30, 1),
      activitySource: "commits",
      activityTruncated: false,
      lastMergeAt: ago(10, now),
      lastDeploy: null,
      needsYou: 0,
      nextUp: { id: "ck-88", title: "Endgame drill: K+P vs K" },
      attention: "ok",
    },
    {
      id: "hq-mail",
      name: "hq-mail",
      kind: "service",
      status: "active",
      sphere: null,
      client: null,
      spawnable: true,
      completion: null,
      worth: null,
      earned: null,
      tokens30d: null,
      costUsd30d: null,
      startedAt: null,
      activeEpic: null,
      goal: "Mail triage and the error autofix loop on hqbox.",
      targetDate: null,
      counts: { open: 5, inProgress: 0, blocked: 0, closed7d: 3 },
      activity30d: series(19, 30, 1),
      activitySource: "commits",
      activityTruncated: false,
      lastMergeAt: ago(400, now),
      lastDeploy: null,
      needsYou: 0,
      nextUp: { id: "hq-mail-12", title: "Turn LOG_ONLY off after the drain review" },
      attention: "blocked",
    },
  ];
}

const machine: MachineSnapshot = {
  host: "hqbox",
  uptimeS: 23 * 86_400 + 4 * 3600,
  cpuPct: 18,
  cores: 8,
  load: [0.8, 0.94, 1.1],
  mem: { totalMb: 32_768, usedMb: 13_414, pct: 41 },
  swap: { totalMb: 8192, usedMb: 260, pct: 3 },
  tempC: 64,
  disks: [
    { mount: "/", totalGb: 916, freeGb: 394, pct: 57 },
    { mount: "/var/lib/hqconsole", totalGb: 916, freeGb: 394, pct: 57 },
  ],
  topRss: [
    { pid: 2411, name: "node (console-server)", rssMb: 182 },
    { pid: 3120, name: "claude (w-91c0)", rssMb: 903 },
    { pid: 3388, name: "claude (w-3f2a)", rssMb: 764 },
    { pid: 1180, name: "dolt", rssMb: 311 },
  ],
  cpuSeries24h: cpuSeries(23, 288),
  health: {
    disk: {
      level: "ok", problems: [], at: new Date(Date.now() - 4 * 60_000).toISOString(), device: "/dev/nvme0", model: "SAMSUNG MZVLB512HAJQ",
      passed: true, tempC: 38, usedPct: 4, sparePct: 100, spareThresholdPct: 10, powerOnHours: 2981, unsafeShutdowns: 101, mediaErrors: 0,
    },
    backup: {
      level: "warn", problems: ["last snapshot is 61 hours old; last attempt: skipped: george unreachable"], target: "george",
      lastSuccessAt: new Date(Date.now() - 61 * 3_600_000).toISOString(), lastAttemptAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      lastResult: "skipped: george unreachable",
    },
  },
  series: (() => {
    // A few hours of plausible movement, so the traces and the trend
    // markers have something to draw in mock mode.
    const n = 90;
    const at: string[] = [];
    const cpu: number[] = [];
    const mem: number[] = [];
    const load: number[] = [];
    const temp: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      at.push(new Date(Date.now() - (n - i) * 15_000).toISOString());
      cpu.push(18 + Math.round(14 * Math.sin(i / 7)) + (i % 5));
      mem.push(36 + i * 0.12);
      load.push(0.2 + 0.08 * Math.sin(i / 5));
      temp.push(64 + Math.round(7 * Math.sin(i / 9)));
    }
    return { at, cpu, mem, load, temp };
  })(),
};

const usage: UsageSummary = {
  tokensToday: 61_400,
  tokensWeek: 1_284_000,
  outputTokensToday: 9_120,
  byModelWeek: [
    { model: "claude-opus-4-8", input: 612_000, output: 74_000, cacheRead: 2_410_000 },
    { model: "claude-opus-4-7", input: 388_000, output: 41_000, cacheRead: 1_120_000 },
    { model: "claude-sonnet-5", input: 121_000, output: 12_400, cacheRead: 260_000 },
    { model: "gpt-5.6 (lucy)", input: 96_000, output: 8_200, cacheRead: 0 },
  ],
  byProject: [
    { project: "hq", inputTokens: 41_000, outputTokens: 512_000, cacheReadTokens: 96_400_000, cacheWriteTokens: 2_900_000, costUsd: 86.4, sessions: 24 },
    { project: "fintrack-portfolio", inputTokens: 8_200, outputTokens: 96_000, cacheReadTokens: 3_900_000, cacheWriteTokens: 210_000, costUsd: 21.4, sessions: 6 },
    { project: "unattributed", inputTokens: 900, outputTokens: 12_000, cacheReadTokens: 410_000, cacheWriteTokens: 24_000, costUsd: 2.1, sessions: 2 },
  ],
  byProjectDays: 30,
  sessionsToday: 7,
  planUsage: {
    fiveHourPct: 38,
    weeklyPct: 61,
    limits: [
      { kind: "session", label: "5 h", percent: 38, severity: "normal", resetsAt: "2026-10-20T08:30:00Z", active: true },
      { kind: "weekly_all", label: "Week", percent: 61, severity: "normal", resetsAt: "2026-10-27T04:00:00Z", active: false },
      { kind: "weekly_scoped", label: "Week, Fable", percent: 12, severity: "normal", resetsAt: "2026-10-27T04:00:00Z", active: false },
    ],
    updatedAt: "2026-10-20T05:20:00Z",
    error: null,
  },
};

function alerts(now: number): Alert[] {
  return [
    {
      id: "a-201",
      severity: "P1",
      title: "hq-mail digest missed its 08:00 run",
      detail: "No heartbeat since 2026-08-17 20:00. The poll and drain timers are healthy.",
      createdAt: ago(72, now),
      source: "collector",
      ackable: true,
    },
  ];
}

function activity(now: number): ActivityEvent[] {
  const ev = (
    id: string,
    minutes: number,
    type: ActivityEvent["type"],
    title: string,
    rest: Partial<ActivityEvent> = {},
  ): ActivityEvent => ({
    id,
    ts: ago(minutes, now),
    type,
    rig: null,
    session: null,
    bead: null,
    title,
    detail: null,
    sev: null,
    ...rest,
  });
  return [
    ev("op-mock-1", 4, "dispatch", "dispatch xd-207 on acme-dashboard", { rig: "acme-dashboard", bead: "xd-207" }),
    ev("ask-r-101", 9, "ask", "Run the ingestion backfill for July?", { rig: "acme-dashboard", sev: "P1" }),
    ev("answer-r-99", 21, "answer", "keep it", { rig: "gym-tracker", detail: "keep or revert the cache change?" }),
    ev("git-hq-aaaa11112222", 34, "merge", "Merge branch 'bead/hq-77' into main", { rig: "hq", detail: "owner" }),
    ev("git-chesski-bbbb33334444", 58, "commit", "engine: cap analysis depth on mobile", { rig: "chesski", detail: "owner" }),
    ev("alert-a-201", 72, "error", "hq-mail digest missed its 08:00 run", { sev: "P1" }),
    ev("op-mock-2", 95, "finish", "finish session t-4f2a", { session: "t-4f2a" }),
  ];
}

function stack(now: number): StackReport {
  const item = (
    id: string,
    kind: StackItem["kind"],
    uses: [number, number, number],
    verdictHint: StackItem["verdictHint"],
    rest: Partial<StackItem> = {},
  ): StackItem => ({
    id,
    name: id.split(":")[1] ?? id,
    kind,
    windows: {
      7: { uses: uses[0], sessions: Math.min(uses[0], 4), errors: 0 },
      30: { uses: uses[1], sessions: Math.min(uses[1], 9), errors: 0 },
      90: { uses: uses[2], sessions: Math.min(uses[2], 14), errors: 0 },
    },
    lastUsed: uses[2] > 0 ? ago(90, now) : null,
    unstamped: 0,
    blocks90: 0,
    topBlockReason: null,
    tokens90: uses[2] * 12000,
    inventory: true,
    stale: null,
    detail: null,
    acquisitions: [],
    verdictHint,
    ...rest,
  });
  return {
    generatedAt: ago(4, now),
    windows: [7, 30, 90],
    items: [
      item("cli:bd", "cli", [61, 204, 262], "value"),
      item("cli:lucy", "cli", [6, 14, 20], "value", { detail: "verdict mix on the bead trail" }),
      item("hook:hook-write-containment-guard", "hook", [0, 0, 0], "friction", {
        blocks90: 94,
        topBlockReason: "Blocked: redirect writes to /dev/null, outside the allowWrite roots",
      }),
      item("skill:code-review", "skill", [1, 3, 5], "low-use"),
      item("mcp:context7", "mcp", [0, 2, 4], "low-use", { acquisitions: [{ id: "hq-qkz9", title: "Acquisition: context7" }] }),
      item("cli:graphify", "cli", [0, 0, 1], "low-use"),
      item("skill:old-notes", "skill", [0, 0, 0], "stale", { stale: "no SKILL.md" }),
      item("domain:registry.npmjs.org", "domain", [2, 9, 22], "value"),
    ],
  };
}

function services(now: number): ServicesReport {
  return {
    generatedAt: ago(1, now),
    services: [
      { id: "hq-mail-poll", label: "hq-mail poll", kind: "systemd-user", unit: "hq-mail-poll.service", restartable: true, logs: true, state: "active", detail: "running", since: ago(3200, now), restarts: 0 },
      { id: "code-server", label: "code-server", kind: "systemd-user", unit: "code-server.service", restartable: true, logs: true, state: "failed", detail: "exit-code", since: null, restarts: 3 },
      { id: "monitoring", label: "monitoring compose", kind: "docker", unit: "uptime-kuma", restartable: true, logs: true, state: "running", since: ago(9000, now), restarts: 1 },
      { id: "tmux-hq", label: "tmux hq", kind: "tmux", unit: "hq", restartable: false, logs: true, state: "active", detail: "tmux session" },
    ],
    servicesError: null,
    jobs: [
      { id: "git-sync", label: "git-sync", kind: "loop", heartbeat: "state/heartbeat/git-sync", source: "mtime", cadenceS: 45, lastRun: ago(1, now), state: "ok", missed: false },
      { id: "retro", label: "weekly retro", kind: "timer", heartbeat: "state/heartbeat/retro", source: "mtime", cadenceS: 604800, lastRun: null, state: "missing", missed: true },
    ],
    jobsError: null,
    automations: {
      mail: {
        flags: { disabled: false, logOnly: true },
        heartbeats: [
          { id: "poll", cadenceS: 900, lastRun: ago(4, now), state: "ok" },
          { id: "digest", cadenceS: 86400, lastRun: ago(2000, now), state: "stale" },
        ],
        recentRuns: [{ file: "2026-08-19T05.json", tail: "fetched 3, rejected 0, spawned 1" }],
      },
    },
  };
}

function money(now: number): MoneyReport {
  const days = 30;
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(now - (days - 1 - i) * 86_400_000);
    const bump = (i * 2654435761) % 97;
    return {
      day: d.toISOString().slice(0, 10),
      input: 120_000 + bump * 3_000,
      output: 40_000 + bump * 1_200,
      cacheRead: 2_000_000 + bump * 40_000,
      sessions: 3 + (bump % 5),
    };
  });
  return {
    generatedAt: ago(4, now),
    rangeDays: days,
    series,
    ledger: [
      { id: "m-1", ts: ago(60 * 26, now), amountCents: 24900, currency: "MXN", category: "hosting", note: "hqbox vps", client: null, vendor: "vultr", project: "hq" },
      { id: "m-2", ts: ago(60 * 50, now), amountCents: 2000, currency: "USD", category: "api", note: "resend", client: null, vendor: "resend", project: "hq-mail" },
      { id: "m-3", ts: ago(60 * 90, now), amountCents: -150000, currency: "MXN", category: "revenue", note: "fintrack print", client: "fintrack", vendor: null, project: "fintrack-portfolio" },
      { id: "m-4", ts: ago(60 * 120, now), amountCents: -480000, currency: "MXN", category: "revenue", note: "august retainer", client: "acme", vendor: null, project: "acme-dashboard" },
    ],
    totals: [
      { month: new Date(now).toISOString().slice(0, 7), currency: "MXN", cents: -125100 },
      { month: new Date(now).toISOString().slice(0, 7), currency: "USD", cents: 2000 },
    ],
    commitments: [
      { id: "m-c1", label: "Vultr, hqbox VPS", amountCents: 24900, currency: "MXN", category: "hosting", cadence: "monthly", startsOn: "2026-03-01", endsOn: null, client: null, vendor: "vultr", project: "hq", monthlyCents: 24900, nextDueOn: new Date(now + 5 * 86400000).toISOString().slice(0, 10) },
      { id: "m-c2", label: "Proton Pass", amountCents: 9600, currency: "USD", category: "tools", cadence: "yearly", startsOn: "2026-02-14", endsOn: null, client: null, vendor: "proton", project: null, monthlyCents: 800, nextDueOn: "2027-02-14" },
      { id: "m-c3", label: "acme retainer", amountCents: -480000, currency: "MXN", category: "revenue", cadence: "monthly", startsOn: "2026-04-01", endsOn: null, client: "acme", vendor: null, project: "acme-dashboard", monthlyCents: -480000, nextDueOn: new Date(now + 11 * 86400000).toISOString().slice(0, 10) },
      { id: "m-c4", label: "Claude Max", amountCents: 200 * 100, currency: "USD", category: "api", cadence: "monthly", startsOn: "2026-01-20", endsOn: null, client: null, vendor: "anthropic", project: null, monthlyCents: 20000, nextDueOn: new Date(now + 2 * 86400000).toISOString().slice(0, 10) },
    ],
    goals: [
      { id: "g-1", label: "Cover the month", kind: "in", targetCents: 6000000, currency: "MXN", month: null, by: null, client: null, createdAt: "2026-10-01T00:00:00.000Z" },
    ],
    runRate: [
      { currency: "MXN", inCents: 480000, outCents: 24900, netCents: 455100, count: 2 },
      { currency: "USD", inCents: 0, outCents: 20800, netCents: -20800, count: 2 },
    ],
    flows: [
      { currency: "MXN", inCents: 630000, outCents: 24900, netCents: 605100 },
      { currency: "USD", inCents: 0, outCents: 2000, netCents: -2000 },
    ],
    clients: [
      {
        client: "acme",
        projects: ["acme-dashboard", "acme-financial"],
        commitmentCount: 1,
        tokens: 4_820_000,
        sessions: 34,
        money: [{ currency: "MXN", inCents: 480000, outCents: 0, monthlyCents: -480000 }],
      },
      {
        client: "fintrack",
        projects: ["fintrack-portfolio"],
        commitmentCount: 0,
        tokens: 610_000,
        sessions: 6,
        money: [{ currency: "MXN", inCents: 150000, outCents: 0, monthlyCents: 0 }],
      },
    ],
    fx: { base: "MXN", mxnPerUsd: 18.7, asOf: new Date(now).toISOString().slice(0, 10), stale: false },
    apiSpend: {
      source: "openai",
      configured: true,
      currency: "USD",
      days: Array.from({ length: 14 }, (_, i) => ({
        day: new Date(now - (13 - i) * 86400000).toISOString().slice(0, 10),
        cents: 180 + ((i * 137) % 900),
      })),
      monthCents: 6420,
      error: null,
    },
  };
}

function monitors(now: number): MonitorsReport {
  return {
    generatedAt: ago(1, now),
    source: "http://127.0.0.1:3001/status/hq",
    monitors: [
      { id: "1", name: "acme prod", group: "Sites", state: "up", lastCheck: ago(1, now), pingMs: 142, uptime24: 100 },
      { id: "2", name: "fintrack prod", group: "Sites", state: "up", lastCheck: ago(1, now), pingMs: 88, uptime24: 99.9 },
      { id: "3", name: "gym-tracker api", group: "Services", state: "down", lastCheck: ago(4, now), pingMs: null, uptime24: 72.5 },
      { id: "4", name: "n8n", group: "Services", state: "up", lastCheck: ago(2, now), pingMs: 210, uptime24: 99.2 },
    ],
    error: null,
  };
}

function deploys(now: number): DeploysReport {
  return {
    generatedAt: ago(2, now),
    deploys: [
      { id: "vercel:orbit-acme-dashboard", provider: "vercel", name: "orbit-acme-dashboard", state: "ok", detail: "production main", at: ago(22, now), url: "https://x.vercel.app" },
      { id: "vercel:fintrack-portfolio", provider: "vercel", name: "fintrack-portfolio", state: "failed", detail: "production master", at: ago(180, now), url: "https://d.vercel.app" },
      { id: "n8n:workflows", provider: "n8n", name: "n8n workflows", state: "ok", detail: "4 active of 6", at: ago(600, now), url: "https://orbitacme.app.n8n.cloud" },
    ],
    providers: [
      { provider: "vercel", configured: true, error: null },
      { provider: "n8n", configured: true, error: null },
    ],
  };
}

function collectors(now: number): CollectorStatus[] {
  const ok = (name: string, ttlS: number, ms: number): CollectorStatus => ({
    name,
    updatedAt: ago(1, now),
    ttlS,
    error: null,
    durationMs: ms,
  });
  return [
    ok("sessions", 5, 34),
    ok("requests", 5, 21),
    ok("ready", 30, 210),
    ok("projects", 60, 640),
    ok("machine", 10, 55),
    ok("usage", 300, 810),
    ok("deploys", 120, 430),
    {
      name: "jobs",
      updatedAt: ago(72, now),
      ttlS: 120,
      error: "hq-mail digest heartbeat is stale",
      durationMs: 120,
    },
    ok("stack", 900, 2_400),
    ok("money", 900, 90),
    ok("services", 60, 180),
  ];
}

export function mockState(nowMs: number = Date.now()): ConsoleState {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    version: { release: "dev-mock", protocol: 1 },
    owner: "owner",
    sessions: sessions(nowMs),
    requests: requests(nowMs),
    ready,
    projects: projects(nowMs),
    machine,
    usage,
    alerts: alerts(nowMs),
    activity: activity(nowMs),
    stack: stack(nowMs),
    flow: {
      generatedAt: new Date(nowMs).toISOString(),
      rigs: [
        {
          rig: "hq",
          windows: {
            7: { closed: 14, medianLeadS: 2500, p90LeadS: 190000, blockedShare: 0.12, reopened: 1, reworkShare: 0.07 },
            30: { closed: 67, medianLeadS: 2497, p90LeadS: 186215, blockedShare: 0.09, reopened: 2, reworkShare: 0.03 },
            90: { closed: 240, medianLeadS: 3100, p90LeadS: 240000, blockedShare: 0.14, reopened: 6, reworkShare: 0.025 },
          },
          weekly: [
            { weekStart: "2026-07-20", medianLeadS: 5400, closed: 22 },
            { weekStart: "2026-07-27", medianLeadS: 4100, closed: 25 },
            { weekStart: "2026-08-03", medianLeadS: 3600, closed: 19 },
            { weekStart: "2026-08-10", medianLeadS: 2900, closed: 24 },
            { weekStart: "2026-08-17", medianLeadS: 2600, closed: 28 },
            { weekStart: "2026-08-24", medianLeadS: 2497, closed: 9 },
          ],
        },
        {
          rig: "acme-dashboard",
          windows: {
            7: { closed: 0, medianLeadS: null, p90LeadS: null, blockedShare: null, reopened: 0, reworkShare: null },
            30: { closed: 3, medianLeadS: 8200, p90LeadS: 40000, blockedShare: 0.4, reopened: 1, reworkShare: 0.33 },
            90: { closed: 11, medianLeadS: 7400, p90LeadS: 52000, blockedShare: 0.35, reopened: 1, reworkShare: 0.09 },
          },
          weekly: [
            { weekStart: "2026-07-20", medianLeadS: null, closed: 0 },
            { weekStart: "2026-07-27", medianLeadS: 9000, closed: 2 },
            { weekStart: "2026-08-03", medianLeadS: 7000, closed: 3 },
            { weekStart: "2026-08-10", medianLeadS: null, closed: 0 },
            { weekStart: "2026-08-17", medianLeadS: 8200, closed: 3 },
            { weekStart: "2026-08-24", medianLeadS: null, closed: 0 },
          ],
        },
      ],
    },
    understudy: {
      generatedAt: new Date(nowMs).toISOString(),
      corpus: { total: 48, answered: 34, open: 9 },
      live: { stamped: 21, graded: 8, abstentions: 6, accuracy: 0.75, brier: 0.142, skill: 0.24 },
      backtest: { n: 34, coverage: 0.68, accuracy: 0.83, brier: 0.156, skill: 0.19 },
      history: [
        { ts: ago(6 * 1440, nowMs), answered: 22, stamped: 9, graded: 2, accuracy: 0.5, brier: 0.21, skill: 0.02 },
        { ts: ago(4 * 1440, nowMs), answered: 26, stamped: 13, graded: 4, accuracy: 0.75, brier: 0.18, skill: 0.11 },
        { ts: ago(2 * 1440, nowMs), answered: 31, stamped: 17, graded: 6, accuracy: 0.67, brier: 0.16, skill: 0.15 },
        { ts: ago(60, nowMs), answered: 34, stamped: 21, graded: 8, accuracy: 0.75, brier: 0.142, skill: 0.24 },
      ],
    },
    services: services(nowMs),
    money: money(nowMs),
    monitors: monitors(nowMs),
    deploys: deploys(nowMs),
    discovered: {
      found: [{ id: "brand-new", path: "/home/owner/hq/rigs/brand-new", snippet: '{\n  "id": "brand-new"\n}' }],
      missing: [],
    },
    calendar: {
      ok: true,
      reason: null,
      generatedAt: new Date(nowMs).toISOString(),
      events: [
        // One unanswered invite, which is the case this card exists for.
        { id: "c1", title: "acme weekly", startsAt: new Date(nowMs + 3 * 3600_000).toISOString(), endsAt: new Date(nowMs + 4 * 3600_000).toISOString(), allDay: false, response: "needsAction", meetLink: "https://meet.google.com/abc-defg-hij", organizer: "someone@example.com", location: "" },
        { id: "c2", title: "Kenji / Dan", startsAt: new Date(nowMs + 26 * 3600_000).toISOString(), endsAt: new Date(nowMs + 27 * 3600_000).toISOString(), allDay: false, response: "accepted", meetLink: null, organizer: "kenji@example.com", location: "" },
        { id: "c3", title: "Invoice day", startsAt: new Date(nowMs + 50 * 3600_000).toISOString(), endsAt: new Date(nowMs + 50 * 3600_000).toISOString(), allDay: true, response: null, meetLink: null, organizer: "", location: "" },
      ],
    },
    ear: { state: "listening", at: new Date(nowMs).toISOString(), text: "how are we doing on fintrack", online: true },
    board: null,
    collectors: collectors(nowMs),
    badges: { now: 3, nowSeverity: "P0", projects: 1, stack: 4, machines: 1 },
  };
}
