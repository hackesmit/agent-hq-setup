// Money tab model (bead hq-9fri): pure helpers for the chart layout, currency
// formatting, honest range options, and the CSV export. Integer cents only.

import type { MoneyClient, MoneyCommitment, MoneyEntry, MoneyFx, MoneyGoal, MoneyReport, ProjectUsage } from "@shared/api";

export const CATEGORIES = ["hosting", "api", "tools", "domains", "revenue", "other"] as const;

export function fmtCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac} ${currency}`;
}

/** Parse a user amount ("249.99") into integer cents, or null when invalid. */
export function parseAmount(text: string): number | null {
  const m = String(text).trim().match(/^(-?)(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] || "0").padEnd(2, "0"));
  if (cents === 0) return null;
  return m[1] === "-" ? -cents : cents;
}

/**
 * Fold a human tag ("Orbit Acme") into the slug the server stores
 * ("orbit-acme"). The server's rule is /^[a-z0-9][a-z0-9-]{0,39}$/ and it
 * refuses anything else, so the form folds what the person MEANT rather than
 * bouncing their capitalisation back at them. Returns null for an empty field
 * and "" for input with nothing usable in it, which the form reports inline.
 */
export function slugifyTag(text: string): string | null {
  const raw = String(text).trim();
  if (!raw) return null;
  return raw
    .toLowerCase()
    // Transliterate accents rather than deleting them: José means jose, and
    // stripping the marked letter whole would quietly rename the client.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Deliberately NOT truncated to the server's 40-char cap: two long distinct
  // names must never silently merge into one slug. The form bounces over-length
  // input inline instead, and the server enforces the cap regardless.
}

/** Only ranges the payload can actually serve (lucy: no promised-but-empty 90d). */
export function rangeOptions(report: MoneyReport | null): number[] {
  const have = report?.rangeDays ?? 0;
  return [7, 30, 90].filter((d) => d <= Math.max(have, 7));
}

export interface ChartDay {
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  total: number; // input + output: the two comparable magnitudes on the axis
}

export function chartDays(report: MoneyReport | null, days: number): ChartDay[] {
  if (!report) return [];
  return report.series.slice(-days).map((d) => ({
    day: d.day,
    input: d.input,
    output: d.output,
    cacheRead: d.cacheRead,
    total: d.input + d.output,
  }));
}

/** Current-month totals per currency, for the stat tiles. */
export function monthTiles(report: MoneyReport | null, nowIso: string): { currency: string; cents: number }[] {
  const month = nowIso.slice(0, 7);
  return (report?.totals ?? []).filter((t) => t.month === month).map((t) => ({ currency: t.currency, cents: t.cents }));
}

export function ledgerCsv(entries: MoneyEntry[]): string {
  // A leading =, +, -, @, tab or CR makes a spreadsheet evaluate the cell as a
  // formula (CSV injection); prefix those with an apostrophe so the note stays
  // text (lucy red-team).
  const esc = (raw: string) => {
    // A plain number is left alone. It starts with a minus often enough that
    // prefixing it would turn every negative amount into text in the spreadsheet,
    // which is a worse bug than the one being prevented, and a bare number cannot
    // be a formula anyway.
    const numeric = /^-?\d+(\.\d+)?$/.test(raw);
    const v = !numeric && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  // Every field, not just the note. The other four are server-generated or pinned
  // by a regex today, so this changes nothing about the output -- but it means the
  // spreadsheet's safety stops depending on a validation rule in a different
  // process that a future change could loosen without anyone looking here.
  const rows = entries.map((e) =>
    [e.ts, (e.amountCents / 100).toFixed(2), e.currency, e.category, e.note].map((f) => esc(String(f))).join(","),
  );
  return ["ts,amount,currency,category,note", ...rows].join("\n") + "\n";
}

// ---- commitments, run rate, and what a client is worth ---------------------

export const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;

/** How a cadence reads in a sentence, not as an enum. */
export const CADENCE_LABEL: Record<(typeof CADENCES)[number], string> = {
  weekly: "every week",
  monthly: "every month",
  quarterly: "every quarter",
  yearly: "every year",
};

/**
 * Commitments split by direction, because they answer two different questions.
 * Subscriptions and tools are what leaves; retainers are what arrives. Showing
 * them in one list forces the reader to do the sign arithmetic themselves.
 *
 * The ledger's sign convention, which is older than this code and is not being
 * changed under it: POSITIVE is money out (a cost), NEGATIVE is money in.
 */
export function splitCommitments(report: MoneyReport | null): {
  outgoing: MoneyCommitment[];
  incoming: MoneyCommitment[];
} {
  const all = report?.commitments ?? [];
  return {
    outgoing: all.filter((c) => c.amountCents > 0),
    incoming: all.filter((c) => c.amountCents <= 0),
  };
}

/** Commitments falling due within `days`, soonest first. */
export function dueWithin(report: MoneyReport | null, days: number, todayIso: string): MoneyCommitment[] {
  const today = todayIso.slice(0, 10);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return (report?.commitments ?? [])
    .filter((c) => c.nextDueOn !== null && c.nextDueOn <= horizon)
    .sort((a, b) => (a.nextDueOn! < b.nextDueOn! ? -1 : 1));
}

/**
 * Cost per million tokens for a client, or null when we cannot say.
 *
 * Null rather than zero is the whole point: a client with no project tagged has
 * unknown effort, not free effort, and a zero here would read as the latter.
 */
export function costPerMillion(client: MoneyClient, currency: string): number | null {
  if (!client.tokens) return null;
  const row = client.money.find((m) => m.currency === currency);
  if (!row) return null;
  const net = row.inCents - row.outCents;
  if (net <= 0) return null;
  return Math.round(net / (client.tokens / 1_000_000));
}

/** A short human count for tokens: 1.2M, 940k, 130. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** Days until a date, negative when it is already past. */
export function daysUntil(dateIso: string | null, todayIso: string): number | null {
  if (!dateIso) return null;
  const a = Date.parse(`${dateIso}T00:00:00Z`);
  const b = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

// ---- what the money actually did, month by month -------------------------

export interface MonthFlow {
  month: string; // yyyy-mm
  inCents: number;
  outCents: number;
  netCents: number;
}

/**
 * Income against spending, per month, for one currency.
 *
 * Built from the visible entries rather than from `totals`, because totals carry
 * the NET for a month and the whole point here is to see the two directions
 * apart. Currencies are never combined, so this takes one and reports it.
 */
export function monthlyFlows(report: MoneyReport | null, currency: string, months = 6): MonthFlow[] {
  const acc = new Map<string, MonthFlow>();
  for (const e of report?.ledger ?? []) {
    if (e.currency !== currency) continue;
    const month = String(e.ts).slice(0, 7);
    if (month.length !== 7) continue;
    const row = acc.get(month) ?? { month, inCents: 0, outCents: 0, netCents: 0 };
    // The ledger's convention: positive is money out, negative is money in.
    if (e.amountCents > 0) row.outCents += e.amountCents;
    else row.inCents += -e.amountCents;
    acc.set(month, row);
  }
  for (const row of acc.values()) row.netCents = row.inCents - row.outCents;
  return [...acc.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).slice(-months);
}

export interface CategorySlice {
  category: string;
  outCents: number;
  share: number; // 0..1 of the total going out
  rest?: true; // the folded tail, marked structurally so a view never guesses from the label
}

/** Where the money goes, largest first. Income is excluded: this is spending. */
export function spendByCategory(report: MoneyReport | null, currency: string, top = 6): CategorySlice[] {
  const acc = new Map<string, number>();
  let total = 0;
  for (const e of report?.ledger ?? []) {
    if (e.currency !== currency || e.amountCents <= 0) continue;
    acc.set(e.category, (acc.get(e.category) ?? 0) + e.amountCents);
    total += e.amountCents;
  }
  if (total === 0) return [];
  const rows = [...acc.entries()]
    .map(([category, outCents]) => ({ category, outCents, share: outCents / total }))
    .sort((a, b) => b.outCents - a.outCents);
  if (rows.length <= top) return rows;
  // Everything past the top few as one honest remainder rather than a long tail
  // of slivers nobody can read.
  const head = rows.slice(0, top);
  const restCents = rows.slice(top).reduce((n, r) => n + r.outCents, 0);
  return [...head, { category: `${rows.length - top} more`, outCents: restCents, share: restCents / total, rest: true }];
}

/**
 * The committed monthly position as a fraction of what comes in.
 *
 * This is the figure worth a band: spending a third of your income on recurring
 * commitments is comfortable, spending all of it is not, and the number alone
 * does not say which. Null when nothing recurring comes in, because a ratio
 * against zero income is not a large number, it is not a number.
 */
export function commitmentPressure(report: MoneyReport | null, currency: string): number | null {
  const rate = (report?.runRate ?? []).find((r) => r.currency === currency);
  if (!rate || rate.inCents <= 0) return null;
  return rate.outCents / rate.inCents;
}

// ---- folding USD into MXN for the one combined view ------------------------
//
// the owner: "mxn and usd should just be auto converted, not treated like
// different elements; mxn coming in and usd leaving is still money in and out."
// The LEDGER still never combines currencies: every stored amount and every
// server aggregate stays exact in its own currency. Folding happens here, at
// display time, using the rate the server ships on the slice, and every folded
// card says which rate it used. No rate means these helpers return null and
// the tab falls back to the per-currency views rather than inventing a rate.
//
// Precision rule: sum each currency exactly in integer cents FIRST, convert the
// USD aggregate once, round once. Converting entry by entry would round in the
// same direction many times over.

/** Fold integer cents in `currency` into MXN cents, or null without a rate. */
export function foldCents(cents: number, currency: string, fx: MoneyFx | null): number | null {
  if (currency === "MXN") return cents;
  if (currency === "USD" && fx) return Math.round(cents * fx.mxnPerUsd);
  return null;
}

/** Per-month income against spending across BOTH currencies, in MXN. */
export function foldedMonthlyFlows(report: MoneyReport | null, months = 6): MonthFlow[] | null {
  const fx = report?.fx ?? null;
  if (!fx) return null;
  const acc = new Map<string, { mxnIn: number; mxnOut: number; usdIn: number; usdOut: number }>();
  for (const e of report?.ledger ?? []) {
    const month = String(e.ts).slice(0, 7);
    if (month.length !== 7) continue;
    const row = acc.get(month) ?? { mxnIn: 0, mxnOut: 0, usdIn: 0, usdOut: 0 };
    const usd = e.currency === "USD";
    // The ledger's convention: positive is money out, negative is money in.
    if (e.amountCents > 0) row[usd ? "usdOut" : "mxnOut"] += e.amountCents;
    else row[usd ? "usdIn" : "mxnIn"] += -e.amountCents;
    acc.set(month, row);
  }
  return [...acc.entries()]
    .map(([month, r]) => {
      const inCents = r.mxnIn + (foldCents(r.usdIn, "USD", fx) ?? 0);
      const outCents = r.mxnOut + (foldCents(r.usdOut, "USD", fx) ?? 0);
      return { month, inCents, outCents, netCents: inCents - outCents };
    })
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .slice(-months);
}

export interface FoldedCategory {
  category: string;
  cents: number; // MXN, always positive: `direction` names which way it moved
  share: number; // 0..1 of this direction's folded total
  rest?: true; // the folded tail, marked structurally so a view never guesses from the label
}

/**
 * Where the money comes from ("in": revenue by type) or goes ("out": costs by
 * type), folded into MXN, largest first, tail collapsed into one remainder.
 */
export function categoryFlows(report: MoneyReport | null, direction: "in" | "out", top = 6): FoldedCategory[] | null {
  const fx = report?.fx ?? null;
  if (!fx) return null;
  const acc = new Map<string, { mxn: number; usd: number }>();
  for (const e of report?.ledger ?? []) {
    const out = e.amountCents > 0;
    if ((direction === "out") !== out) continue;
    const row = acc.get(e.category) ?? { mxn: 0, usd: 0 };
    row[e.currency === "USD" ? "usd" : "mxn"] += Math.abs(e.amountCents);
    acc.set(e.category, row);
  }
  const rows = [...acc.entries()]
    .map(([category, r]) => ({ category, cents: r.mxn + (foldCents(r.usd, "USD", fx) ?? 0) }))
    .filter((r) => r.cents > 0)
    .sort((a, b) => b.cents - a.cents);
  const total = rows.reduce((n, r) => n + r.cents, 0);
  if (total === 0) return [];
  const shared = rows.map((r) => ({ ...r, share: r.cents / total }));
  if (shared.length <= top) return shared;
  const head = shared.slice(0, top);
  const rest = shared.slice(top).reduce((n, r) => n + r.cents, 0);
  return [...head, { category: `${shared.length - top} more`, cents: rest, share: rest / total, rest: true }];
}

/** The committed monthly position across both currencies, in MXN. */
export function foldedRunRate(report: MoneyReport | null): (MonthFlow & { count: number }) | null {
  const fx = report?.fx ?? null;
  if (!fx) return null;
  let inCents = 0;
  let outCents = 0;
  let count = 0;
  for (const r of report?.runRate ?? []) {
    const inFolded = foldCents(r.inCents, r.currency, fx);
    const outFolded = foldCents(r.outCents, r.currency, fx);
    if (inFolded === null || outFolded === null) return null; // an unknown currency must not fold partially
    inCents += inFolded;
    outCents += outFolded;
    count += r.count;
  }
  return { month: "", inCents, outCents, netCents: inCents - outCents, count };
}

/** Commitment pressure across both currencies: folded out over folded in. */
export function foldedPressure(report: MoneyReport | null): number | null {
  const rate = foldedRunRate(report);
  if (!rate || rate.inCents <= 0) return null;
  return rate.outCents / rate.inCents;
}

/** This month's folded net movement, for the stat tile. Null without a rate. */
export function foldedMonthNet(report: MoneyReport | null, nowIso: string): number | null {
  const fx = report?.fx ?? null;
  if (!fx) return null;
  const month = nowIso.slice(0, 7);
  let net = 0;
  for (const t of report?.totals ?? []) {
    if (t.month !== month) continue;
    const folded = foldCents(t.cents, t.currency, fx);
    if (folded === null) return null;
    net += folded;
  }
  return net;
}

/**
 * A continuous day axis for the API-spend bars: every calendar day of the
 * window, zero-filled. The server sends only days with spend, and two bars
 * with a quiet month between them must not sit side by side pretending to be
 * consecutive days (lucy).
 */
export function spendDays(
  spend: { days: { day: string; cents: number }[] } | null,
  todayIso: string,
  window = 30,
): { day: string; cents: number }[] {
  const byDay = new Map((spend?.days ?? []).map((d) => [d.day, d.cents]));
  const end = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end)) return [];
  return Array.from({ length: window }, (_, i) => {
    const day = new Date(end - (window - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { day, cents: byDay.get(day) ?? 0 };
  });
}

/**
 * The currencies this report has anything to say about.
 *
 * Falls back to one rather than none. An empty ledger returning an empty list
 * meant the charts simply did not exist until the first entry was recorded, so a
 * feature that was asked for could not be found. One card in its empty state says
 * what it will show; zero cards says nothing at all.
 */
export function currenciesIn(report: MoneyReport | null): string[] {
  const seen = new Set<string>();
  for (const e of report?.ledger ?? []) seen.add(e.currency);
  for (const c of report?.commitments ?? []) seen.add(c.currency);
  return seen.size > 0 ? [...seen].sort() : ["MXN"];
}

// ---- reading the tab at a glance ------------------------------------------

/**
 * The ledger stores positive as money OUT. A tile that says "1,629.96 MXN" with
 * "spend minus income" underneath makes the reader do the inversion every time,
 * so every headline figure on the tab reads the other way round: positive is
 * what you came out ahead by. The stored rows are never touched; only the sign
 * on the way to the screen.
 */
export function asNet(ledgerCents: number): number {
  // Never negative zero: a month that netted nothing reads "0.00", not "-0.00".
  return ledgerCents === 0 ? 0 : -ledgerCents;
}

/** Entries shown before the reader asks for the rest. */
export const LEDGER_PREVIEW = 8;

/**
 * The auto-posted salaries and subscriptions make the ledger long by design,
 * and a long table is not a glance. Show the latest few and let the rest unfold
 * on request. Returns what to render and how many stay hidden.
 */
export function ledgerPreview<T>(entries: T[], showAll: boolean, preview = LEDGER_PREVIEW): { rows: T[]; hidden: number } {
  if (showAll || entries.length <= preview) return { rows: entries, hidden: 0 };
  return { rows: entries.slice(0, preview), hidden: entries.length - preview };
}

/**
 * How a month reads: earning more than it spends, or not.
 *
 * The month that is still running is never judged: six days into October the
 * monthly costs have posted and most of the income has not, and painting that
 * red every month until the retainers land is noise, not a signal.
 */
export function monthTone(row: MonthFlow, isCurrent = false): "ok" | "warn" | "bad" | "mute" {
  if (isCurrent) return "mute";
  if (row.netCents >= 0) return "ok";
  // Out by less than a quarter of what came in is a normal month with a big
  // invoice in it; out by more than that is the shape of a problem.
  if (row.inCents > 0 && -row.netCents <= row.inCents * 0.25) return "warn";
  return "bad";
}

// ---- shapes beyond bars: a running line, ring slices, and short figures -----

/** A net figure short enough to sit under a bar or inside a ring: 24k, -1.6k, 850. */
export function fmtShortCents(cents: number, signed = true): string {
  const units = cents / 100;
  const abs = Math.abs(units);
  const sign = units < 0 ? "-" : signed ? "+" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1_000)}k`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

export interface RunningPoint {
  month: string;
  netCents: number;
  runningCents: number; // the nets added up, oldest month first
}

/**
 * The months' nets accumulated into one line: where the money has got to,
 * not what each month did. The bars already say the latter; this is the
 * trend a glance wants, and the one form on the tab that is a line.
 */
export function runningNet(rows: MonthFlow[], keep = Infinity): RunningPoint[] {
  let acc = 0;
  // Oldest first is enforced here, not assumed: a cumulative line over months
  // in the wrong order is a confidently drawn falsehood (lucy).
  const ordered = [...rows].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const all = ordered.map((r) => {
    acc += r.netCents;
    return { month: r.month, netCents: r.netCents, runningCents: acc };
  });
  // The sum runs over EVERY month handed in; `keep` only trims what is drawn.
  // Trimming the months first and then adding up would quietly drop the oldest
  // ones from the total, and the point of this line is the total (lucy).
  return Number.isFinite(keep) && all.length > keep ? all.slice(-keep) : all;
}

/** Every month in the visible ledger: the horizon a running sum must cover. */
export const ALL_MONTHS = 1200;

export interface Slice {
  start: number; // fraction of the circle, 0 at twelve o'clock, clockwise
  end: number;
  share: number;
}

/** Part-to-whole fractions for a ring. Negative or zero values take no arc. */
export function donutSlices(values: number[]): Slice[] {
  const total = values.reduce((n, v) => n + Math.max(0, v), 0);
  if (total <= 0) return [];
  let at = 0;
  return values.map((v) => {
    const share = Math.max(0, v) / total;
    const s = { start: at, end: at + share, share };
    at += share;
    return s;
  });
}

/**
 * SVG path for one ring segment between two fractions of the circle. A segment
 * that is the whole circle is drawn as two halves, because an arc from a point
 * back to itself is a zero-length arc, not a circle.
 */
export function ringPath(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number): string {
  if (a1 - a0 >= 0.9999) {
    const mid = a0 + 0.5;
    return `${ringPath(cx, cy, rOuter, rInner, a0, mid)} ${ringPath(cx, cy, rOuter, rInner, mid, a0 + 1)}`;
  }
  const t0 = (a0 - 0.25) * 2 * Math.PI;
  const t1 = (a1 - 0.25) * 2 * Math.PI;
  const large = a1 - a0 > 0.5 ? 1 : 0;
  const p = (r: number, t: number) => `${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
  return `M ${p(rOuter, t0)} A ${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, t1)} L ${p(rInner, t1)} A ${rInner} ${rInner} 0 ${large} 0 ${p(rInner, t0)} Z`;
}

/**
 * One client's income against spending per month, for the line on their row.
 *
 * Folded into MXN when a rate exists, like every combined view. Without a rate
 * the client's months can still be drawn if everything tagged to them moved in
 * ONE currency; two currencies and no rate is not a line, it is two lines
 * pretending to be one, so this returns null and the row says why.
 */
export type ClientFlows =
  | { kind: "ok"; rows: MonthFlow[]; currency: string }
  | { kind: "no-rows" } // nothing tagged to this client in the visible ledger
  | { kind: "mixed" }; // two currencies and no rate to fold them

export function clientMonthlyFlows(report: MoneyReport | null, client: string): ClientFlows {
  const mine = (report?.ledger ?? []).filter((e) => e.client === client);
  if (mine.length === 0) return { kind: "no-rows" };
  const fx = report?.fx ?? null;
  const currencies = [...new Set(mine.map((e) => e.currency))];
  if (!fx && currencies.length > 1) return { kind: "mixed" };
  const currency = fx ? "MXN" : currencies[0]!;
  const acc = new Map<string, { in: number; out: number }>();
  for (const e of mine) {
    const month = String(e.ts).slice(0, 7);
    if (month.length !== 7) continue;
    const cents = fx ? foldCents(Math.abs(e.amountCents), e.currency, fx) : Math.abs(e.amountCents);
    if (cents === null) return { kind: "mixed" }; // an unknown currency must not fold partially
    const row = acc.get(month) ?? { in: 0, out: 0 };
    if (e.amountCents > 0) row.out += cents;
    else row.in += cents;
    acc.set(month, row);
  }
  // Every month, untrimmed: the running sum needs all of them (see runningNet).
  const rows = [...acc.entries()]
    .map(([month, r]) => ({ month, inCents: r.in, outCents: r.out, netCents: r.in - r.out }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  return { kind: "ok", rows, currency };
}

// ---- goals: a yardstick held against the ledger ------------------------------

/** Convert cents between the two currencies with the display rate, or null without one. */
export function convertCents(cents: number, from: string, to: string, fx: MoneyFx | null): number | null {
  if (from === to) return cents;
  if (!fx) return null;
  if (from === "USD" && to === "MXN") return Math.round(cents * fx.mxnPerUsd);
  if (from === "MXN" && to === "USD") return Math.round(cents / fx.mxnPerUsd);
  return null;
}

export interface GoalProgress {
  haveCents: number; // measured in the goal's currency
  targetCents: number;
  ratio: number; // have over target, may exceed 1
  /**
   * in and net: reached; out: at or under the cap. Null means UNKNOWN: rows in
   * the other currency could not be converted, so a cap or a net cannot be
   * called met on the rows that were counted (an income goal still can, since
   * the counted rows are a lower bound).
   */
  met: boolean | null;
  tone: "ok" | "warn" | "bad" | "mute";
  scope: string; // the sentence under the bar: what was measured, over what
  uncounted: number; // rows in another currency with no rate to convert them
  daysLeft: number | null; // for a net goal with a deadline
  partial: boolean; // the page holds only the newest rows, so older months may be missing
}

/** The ledger slice the page receives is capped server side at this many rows. */
export const LEDGER_VISIBLE_CAP = 500;

/**
 * How far a goal has got, from the ledger rows the page already holds.
 *
 * Rows in the goal's own currency always count. Rows in the other currency
 * count through the display rate, and are counted out loud when there is no
 * rate, because a goal quietly measured against half the ledger is not met,
 * it is misread.
 */
export function goalProgress(report: MoneyReport | null, goal: MoneyGoal, nowIso: string): GoalProgress {
  const fx = report?.fx ?? null;
  const today = nowIso.slice(0, 10);
  const month = goal.kind === "net" ? null : (goal.month ?? nowIso.slice(0, 7));
  // A net goal with a deadline that has passed is judged AT the deadline: what
  // came in afterwards cannot meet it late, and what went out afterwards cannot
  // undo it (lucy).
  const cutoff = goal.kind === "net" && goal.by && today > goal.by ? goal.by : null;
  let have = 0;
  let uncounted = 0;
  for (const e of report?.ledger ?? []) {
    if (goal.client && e.client !== goal.client) continue;
    if (month && String(e.ts).slice(0, 7) !== month) continue;
    if (cutoff && String(e.ts).slice(0, 10) > cutoff) continue;
    const out = e.amountCents > 0;
    if (goal.kind === "in" && out) continue;
    if (goal.kind === "out" && !out) continue;
    const cents = convertCents(Math.abs(e.amountCents), e.currency, goal.currency, fx);
    if (cents === null) {
      uncounted += 1;
      continue;
    }
    // net: in minus out, over every visible row
    have += goal.kind === "net" ? (out ? -cents : cents) : cents;
  }
  const ratio = goal.targetCents > 0 ? have / goal.targetCents : 0;
  // The cap is inclusive: spending exactly the cap is within it, and the tone
  // agrees (over is bad, close is a warning).
  let met: boolean | null = goal.kind === "out" ? have <= goal.targetCents : have >= goal.targetCents;
  if (uncounted > 0 && goal.kind !== "in") met = null;
  if (uncounted > 0 && goal.kind === "in" && !met) met = null; // the counted rows are only a lower bound
  let tone: GoalProgress["tone"];
  if (goal.kind === "out") tone = ratio > 1 ? "bad" : ratio >= 0.85 ? "warn" : "ok";
  else tone = ratio >= 1 ? "ok" : ratio >= 0.5 ? "warn" : "mute";
  if (met === null) tone = "mute";
  const daysLeft = goal.kind === "net" && goal.by ? daysUntil(goal.by, today) : null;
  if (daysLeft !== null && daysLeft < 0 && met === false) tone = "bad";
  const partial = (report?.ledger.length ?? 0) >= LEDGER_VISIBLE_CAP;
  const who = goal.client ? ` from ${goal.client}` : "";
  const when = month ? (goal.month ? `in ${month}` : `this month (${month})`) : "over every month in view";
  const scope =
    goal.kind === "in"
      ? `brought in${who} ${when}`
      : goal.kind === "out"
        ? `spent${who} ${when}, against the cap`
        : `running net ${when}${goal.by ? `, by ${goal.by}` : ""}`;
  return { haveCents: have, targetCents: goal.targetCents, ratio, met, tone, scope, uncounted, daysLeft, partial };
}

/** The sentence a goal reads as in a list. */
export function goalSentence(goal: MoneyGoal): string {
  const amount = fmtCents(goal.targetCents, goal.currency);
  const month = goal.month ? ` in ${goal.month}` : " each month";
  if (goal.kind === "in") return `Bring in at least ${amount}${month}${goal.client ? ` from ${goal.client}` : ""}`;
  if (goal.kind === "out") return `Keep spending under ${amount}${month}${goal.client ? ` on ${goal.client}` : ""}`;
  return `Reach a running net of ${amount}${goal.by ? ` by ${goal.by}` : ""}`;
}

// ---- tokens by project: what the agents spent, and on which rig ---------------

export interface ProjectEffort {
  project: string;
  tokens: number; // input plus output, the two the day chart draws
  costUsd: number; // list-price equivalent, not an invoice
  sessions: number;
  share: number; // of the listed total
}

/** The projects that spent the most, biggest first, the tail folded into one row. */
export function projectEffort(usage: { byProject: ProjectUsage[] } | null, top = 8): ProjectEffort[] {
  const rows = (usage?.byProject ?? [])
    .map((p) => ({ project: p.project, tokens: p.inputTokens + p.outputTokens, costUsd: p.costUsd, sessions: p.sessions }))
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((n, r) => n + r.tokens, 0);
  if (total === 0) return [];
  const withShare = (r: Omit<ProjectEffort, "share">) => ({ ...r, share: r.tokens / total });
  if (rows.length <= top) return rows.map(withShare);
  const head = rows.slice(0, top);
  const rest = rows.slice(top).reduce(
    (acc, r) => ({ project: acc.project, tokens: acc.tokens + r.tokens, costUsd: acc.costUsd + r.costUsd, sessions: acc.sessions + r.sessions }),
    { project: `${rows.length - top} more`, tokens: 0, costUsd: 0, sessions: 0 },
  );
  return [...head, rest].map(withShare);
}
