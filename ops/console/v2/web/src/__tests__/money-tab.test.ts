// Money tab (bead hq-9fri): the pure model (a money surface, so parseAmount
// and formatting are exhaustively pinned) and render smokes.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { asNet, categoryFlows, chartDays, clientMonthlyFlows, convertCents, goalProgress, goalSentence, projectEffort, donutSlices, fmtShortCents, ledgerPreview, monthTone, ringPath, runningNet, commitmentPressure, currenciesIn, fmtCents, foldCents, foldedMonthNet, foldedMonthlyFlows, foldedPressure, foldedRunRate, ledgerCsv, monthlyFlows, monthTiles, parseAmount, rangeOptions, slugifyTag, spendByCategory } from "../money/model";
import type { MoneyReport } from "@shared/api";
import { TokensChart } from "../money/TokensChart";
import { FoldedFlows } from "../money/Flows";
import { Donut, capParts } from "../money/Charts";
import { Clients } from "../money/Clients";
import { Goals } from "../money/Goals";
import type { MoneyGoal } from "@shared/api";
import { mockState } from "../data/mock";
import { MoneyTab } from "../tabs/MoneyTab";

describe("money model", () => {
  it("parseAmount: integer cents only, no floats ever", () => {
    expect(parseAmount("249.99")).toBe(24999);
    expect(parseAmount("0.10")).toBe(10);
    expect(parseAmount("0.1")).toBe(10);
    expect(parseAmount("1500")).toBe(150000);
    expect(parseAmount("-42.50")).toBe(-4250);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("0.00")).toBeNull();
    expect(parseAmount("1.999")).toBeNull();
    expect(parseAmount("1,000")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("1e3")).toBeNull();
    expect(parseAmount("12345678")).toBeNull();
  });

  it("fmtCents renders exact cents with the currency label", () => {
    expect(fmtCents(24999, "MXN")).toBe("249.99 MXN");
    expect(fmtCents(-4250, "USD")).toBe("-42.50 USD");
    expect(fmtCents(5, "USD")).toBe("0.05 USD");
    expect(fmtCents(123456789, "MXN")).toBe("1,234,567.89 MXN");
  });

  it("range options never promise days the payload lacks", () => {
    expect(rangeOptions(null)).toEqual([7]);
    expect(rangeOptions({ rangeDays: 14 } as never)).toEqual([7]);
    expect(rangeOptions({ rangeDays: 30 } as never)).toEqual([7, 30]);
    expect(rangeOptions({ rangeDays: 90 } as never)).toEqual([7, 30, 90]);
  });

  it("chartDays keeps input+output on the axis and cacheRead off it", () => {
    const report = { series: [{ day: "2026-08-18", input: 10, output: 5, cacheRead: 9999, sessions: 1 }] } as never;
    const [d] = chartDays(report, 7);
    expect(d!.total).toBe(15);
    expect(d!.cacheRead).toBe(9999);
  });

  it("month tiles and CSV", () => {
    const report = { totals: [
      { month: "2026-08", currency: "MXN", cents: 100 },
      { month: "2026-07", currency: "MXN", cents: 999 },
      { month: "2026-08", currency: "USD", cents: -50 },
    ] } as never;
    expect(monthTiles(report, "2026-08-19T00:00:00Z")).toEqual([
      { currency: "MXN", cents: 100 },
      { currency: "USD", cents: -50 },
    ]);
    const csv = ledgerCsv([{ id: "m", ts: "t", amountCents: 150, currency: "MXN", category: "x", note: 'a,"b"', client: null, vendor: null, project: null }]);
    expect(csv).toContain('t,1.50,MXN,x,"a,""b"""');
  });
});

describe("slugifyTag folds human tags into what the server accepts", () => {
  // The server refuses anything outside /^[a-z0-9][a-z0-9-]{0,39}$/, and on
  // 2026-08-27 "Orbit Acme" in the client field made the add button look dead.
  const SERVER_RULE = /^[a-z0-9][a-z0-9-]{0,39}$/;

  it("folds case, spaces, separators and accents", () => {
    expect(slugifyTag("Orbit Acme")).toBe("orbit-acme");
    expect(slugifyTag("  the owner ")).toBe("owner");
    expect(slugifyTag("acme_dashboard")).toBe("acme-dashboard");
    expect(slugifyTag("A.B.  C")).toBe("a-b-c");
    expect(slugifyTag("--edge--")).toBe("edge");
    // transliterated, not deleted: the marked letter survives
    expect(slugifyTag("José Peña")).toBe("jose-pena");
  });

  it("empty means not set, unusable means bounce", () => {
    expect(slugifyTag("")).toBeNull();
    expect(slugifyTag("   ")).toBeNull();
    expect(slugifyTag("!!!")).toBe("");
    expect(slugifyTag("---")).toBe("");
  });

  it("never truncates: over-length slugs come back whole for the form to bounce", () => {
    // Two long distinct names must not silently merge into one 40-char slug
    // (lucy: attribution corruption); the form refuses them instead.
    expect(slugifyTag("x".repeat(60))).toHaveLength(60);
  });

  it("every in-cap result satisfies the server's rule exactly", () => {
    const cases = ["Orbit Acme", "x".repeat(40), `${"y".repeat(34)}-tail`, "9 Lives", "a", "José"];
    for (const c of cases) {
      const slug = slugifyTag(c);
      expect(slug).not.toBeNull();
      expect(slug).toMatch(SERVER_RULE);
    }
  });
});

describe("folding USD into MXN is display-only, exact-first, and never invented", () => {
  const FX = { base: "MXN" as const, mxnPerUsd: 18.5, asOf: "2026-08-27", stale: false };
  const entry = (over: Record<string, unknown>) => ({
    id: "m-1", ts: "2026-08-15T12:00:00Z", amountCents: 100, currency: "MXN" as const,
    category: "tools", note: "", client: null, vendor: null, project: null, ...over,
  });
  const report = (over: Partial<MoneyReport>): MoneyReport => ({
    generatedAt: "2026-08-27T00:00:00Z", rangeDays: 0, series: [], ledger: [], totals: [],
    commitments: [], runRate: [], flows: [], clients: [], fx: FX, ...over,
  } as MoneyReport);

  it("foldCents: MXN passes through, USD converts at the rate, no rate means null", () => {
    expect(foldCents(100, "MXN", FX)).toBe(100);
    expect(foldCents(100, "USD", FX)).toBe(1850);
    expect(foldCents(100, "USD", null)).toBeNull();
    // rounds once, to the nearest cent
    expect(foldCents(3, "USD", { ...FX, mxnPerUsd: 18.505 })).toBe(56);
  });

  it("monthly flows sum each currency exactly before converting once", () => {
    // three 1-cent USD entries: converting each first would give 3*round(18.5)=57,
    // aggregate-first gives round(3*18.5)=56
    const r = report({
      ledger: [
        entry({ id: "m-1", amountCents: 1, currency: "USD" }),
        entry({ id: "m-2", amountCents: 1, currency: "USD" }),
        entry({ id: "m-3", amountCents: 1, currency: "USD" }),
        entry({ id: "m-4", amountCents: -1000 }), // 10 MXN in
      ],
    });
    const rows = foldedMonthlyFlows(r)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ month: "2026-08", inCents: 1000, outCents: 56, netCents: 944 });
    expect(foldedMonthlyFlows(report({ fx: null }))).toBeNull();
  });

  it("revenue by type and costs by type split by direction and fold both currencies", () => {
    const r = report({
      ledger: [
        entry({ id: "m-1", amountCents: -200000, category: "revenue" }),          // 2,000 MXN in
        entry({ id: "m-2", amountCents: -100, currency: "USD", category: "api" }), // 18.50 MXN in
        entry({ id: "m-3", amountCents: 5000, category: "hosting" }),              // 50 MXN out
        entry({ id: "m-4", amountCents: 100, currency: "USD", category: "tools" }),// 18.50 MXN out
      ],
    });
    const revenue = categoryFlows(r, "in")!;
    expect(revenue.map((x) => x.category)).toEqual(["revenue", "api"]);
    expect(revenue[0]!.cents).toBe(200000);
    expect(revenue[1]!.cents).toBe(1850);
    const costs = categoryFlows(r, "out")!;
    expect(costs.map((x) => x.category)).toEqual(["hosting", "tools"]);
    expect(costs.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1);
    expect(categoryFlows(report({ fx: null }), "out")).toBeNull();
  });

  it("the folded run rate combines both currencies and drives the folded pressure", () => {
    const r = report({
      runRate: [
        { currency: "MXN", inCents: 866667, outCents: 0, netCents: 866667, count: 1 },
        { currency: "USD", inCents: 0, outCents: 20000, netCents: -20000, count: 1 },
      ],
    });
    const folded = foldedRunRate(r)!;
    expect(folded.inCents).toBe(866667);
    expect(folded.outCents).toBe(370000); // 200 USD at 18.5
    expect(folded.netCents).toBe(496667);
    expect(folded.count).toBe(2);
    expect(foldedPressure(r)).toBeCloseTo(370000 / 866667);
    expect(foldedRunRate(report({ fx: null }))).toBeNull();
  });

  it("spendDays zero-fills the whole window so gaps stay visible", async () => {
    const { spendDays } = await import("../money/model");
    const days = spendDays({ days: [{ day: "2026-08-01", cents: 500 }, { day: "2026-08-27", cents: 300 }] }, "2026-08-27T12:00:00Z", 30);
    expect(days).toHaveLength(30);
    expect(days[days.length - 1]).toEqual({ day: "2026-08-27", cents: 300 });
    expect(days.find((d) => d.day === "2026-08-01")!.cents).toBe(500);
    expect(days.filter((d) => d.cents === 0)).toHaveLength(28);
    // consecutive calendar days, no gaps skipped
    expect(days[0]!.day).toBe("2026-07-29");
  });

  it("the month tile folds this month's totals and only this month's", () => {
    const r = report({
      totals: [
        { month: "2026-08", currency: "MXN", cents: -125100 },
        { month: "2026-08", currency: "USD", cents: 2000 },
        { month: "2026-07", currency: "MXN", cents: 999999 },
      ],
    });
    expect(foldedMonthNet(r, "2026-08-27T12:00:00Z")).toBe(-125100 + 37000);
    expect(foldedMonthNet(report({ fx: null }), "2026-08-27T12:00:00Z")).toBeNull();
  });
});

describe("charts and tab", () => {
  it("the chart renders marks, legend, and the table fallback", () => {
    const html = renderToStaticMarkup(
      createElement(TokensChart, {
        days: [
          { day: "2026-08-18", input: 100, output: 50, cacheRead: 5000, total: 150 },
          { day: "2026-08-19", input: 200, output: 80, cacheRead: 7000, total: 280 },
        ],
      }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("var(--chart-1)");
    expect(html).toContain("var(--chart-2)");
    expect(html).toContain("input");
    expect(html).toContain("table view");
    expect(html).toContain("cache reads");
  });

  it("the tab renders the ledger, form, totals and honest empty states", () => {
    const state = mockState();
    const html = renderToStaticMarkup(createElement(MoneyTab, { usage: state.usage, money: state.money }));
    expect(html).toContain("Tokens per day");
    expect(html).toContain("Ledger");
    expect(html).toContain("hqbox vps");
    expect(html).toContain("249.00 MXN");
    expect(html).toContain("Delete");
    expect(html).toContain("CSV");
    const empty = renderToStaticMarkup(createElement(MoneyTab, { usage: null, money: null }));
    expect(empty).toContain("Nothing recorded yet");
    expect(empty).toContain("No usage series yet");
  });
});

describe("csv export escapes every field, without mangling the numbers", () => {
  const row = (over: Partial<Parameters<typeof ledgerCsv>[0][0]> = {}) =>
    ledgerCsv([{ id: "m", ts: "2026-08-20T00:00:00Z", amountCents: 150, currency: "MXN", category: "ops", note: "n", ...over } as never])
      .split("\n")[1]!;

  it("leaves a negative amount as a number rather than quoting it into text", () => {
    // The guard prefixes a leading minus to stop a spreadsheet evaluating the
    // cell. Applied naively to the amount column that turns every refund into a
    // string, which is a worse bug than the one being prevented.
    expect(row({ amountCents: -1234 })).toContain(",-12.34,");
    expect(row({ amountCents: -1234 })).not.toContain("'-12.34");
    expect(row({ amountCents: 1234 })).toContain(",12.34,");
  });

  it("still neutralises a formula wherever it appears, not only in the note", () => {
    expect(row({ category: "=cmd()" })).toContain("'=cmd()");
    expect(row({ currency: "@SUM(A1)" as never })).toContain("'@SUM(A1)");
    expect(row({ ts: "+1" })).toContain("'+1");
    expect(row({ note: "=1+1" })).toContain("'=1+1");
  });
});

describe("income against spending", () => {
  const entry = (over: Record<string, unknown>) =>
    ({ id: "m", ts: "2026-08-01T00:00:00Z", amountCents: 100, currency: "MXN", category: "tools", note: "", client: null, vendor: null, project: null, ...over }) as never;
  const report = (ledger: unknown[], extra: Record<string, unknown> = {}) =>
    ({ generatedAt: "", rangeDays: 0, series: [], ledger, totals: [], commitments: [], runRate: [], flows: [], clients: [], ...extra }) as never;

  it("splits a month into the two directions rather than reporting the net", () => {
    // `totals` carries the net, which is exactly what hides a month that earned a
    // lot and spent a lot. These are built from the entries for that reason.
    const rows = monthlyFlows(
      report([
        entry({ ts: "2026-07-03T00:00:00Z", amountCents: -100000 }),
        entry({ ts: "2026-07-20T00:00:00Z", amountCents: 40000 }),
        entry({ ts: "2026-08-02T00:00:00Z", amountCents: -50000 }),
      ]),
      "MXN",
    );
    expect(rows.map((r) => r.month)).toEqual(["2026-07", "2026-08"]);
    expect(rows[0]).toMatchObject({ inCents: 100000, outCents: 40000, netCents: 60000 });
    expect(rows[1]).toMatchObject({ inCents: 50000, outCents: 0, netCents: 50000 });
  });

  it("never mixes currencies into one chart", () => {
    const r = report([
      entry({ amountCents: -100, currency: "MXN" }),
      entry({ amountCents: -999, currency: "USD" }),
    ]);
    expect(monthlyFlows(r, "MXN")[0]!.inCents).toBe(100);
    expect(monthlyFlows(r, "USD")[0]!.inCents).toBe(999);
    expect(currenciesIn(r)).toEqual(["MXN", "USD"]);
    // and an empty ledger still offers one card, so the charts are discoverable
    // before the first entry rather than appearing out of nowhere after it
    expect(currenciesIn(report([]))).toEqual(["MXN"]);
    expect(currenciesIn(null)).toEqual(["MXN"]);
  });

  it("shows where spending goes and folds the tail into one honest remainder", () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ amountCents: (9 - i) * 1000, category: `c${i}` }));
    const rows = spendByCategory(report(many), "MXN");
    expect(rows).toHaveLength(7);
    expect(rows[0]!.category).toBe("c0");
    expect(rows[6]!.category).toBe("3 more");
    // the shares still add up to the whole
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 5);
  });

  it("excludes income from the spending breakdown", () => {
    const rows = spendByCategory(report([entry({ amountCents: -5000, category: "revenue" }), entry({ amountCents: 100, category: "tools" })]), "MXN");
    expect(rows.map((r) => r.category)).toEqual(["tools"]);
  });

  it("refuses to take a ratio against no income", () => {
    // A ratio against zero income is not a large number, it is not a number.
    expect(commitmentPressure(report([], { runRate: [{ currency: "MXN", inCents: 0, outCents: 5000, netCents: -5000, count: 1 }] }), "MXN")).toBe(null);
    expect(commitmentPressure(report([]), "MXN")).toBe(null);
    expect(
      commitmentPressure(report([], { runRate: [{ currency: "MXN", inCents: 10000, outCents: 4000, netCents: 6000, count: 2 }] }), "MXN"),
    ).toBeCloseTo(0.4, 5);
  });
});

describe("reading the tab at a glance", () => {
  it("asNet flips the ledger's out-positive sign so a headline reads positive when ahead", () => {
    // 2,000 MXN of salary stored as -200000 (money in) reads as +2,000 on screen.
    expect(asNet(-200000)).toBe(200000);
    expect(asNet(20000)).toBe(-20000);
    expect(Object.is(asNet(0), -0)).toBe(false);
    expect(fmtCents(asNet(0), "MXN")).toBe("0.00 MXN");
    expect(fmtCents(asNet(-200000), "MXN")).toBe("2,000.00 MXN");
  });

  it("ledgerPreview shows the latest few and counts the rest, until asked for everything", () => {
    const entries = Array.from({ length: 33 }, (_, i) => ({ id: `m-${i}` }));
    const collapsed = ledgerPreview(entries, false);
    expect(collapsed.rows).toHaveLength(8);
    expect(collapsed.rows[0].id).toBe("m-0");
    expect(collapsed.hidden).toBe(25);
    const expanded = ledgerPreview(entries, true);
    expect(expanded.rows).toHaveLength(33);
    expect(expanded.hidden).toBe(0);
    // A short list never shows a pointless toggle.
    expect(ledgerPreview(entries.slice(0, 5), false)).toEqual({ rows: entries.slice(0, 5), hidden: 0 });
    expect(ledgerPreview(entries.slice(0, 8), false).hidden).toBe(0);
  });

  it("monthTone judges finished months and leaves the running one alone", () => {
    const ahead = { month: "2026-09", inCents: 2420000, outCents: 363000, netCents: 2057000 };
    const slightlyBehind = { month: "2026-08", inCents: 1000000, outCents: 1200000, netCents: -200000 };
    const behind = { month: "2026-07", inCents: 1000000, outCents: 1500000, netCents: -500000 };
    const young = { month: "2026-10", inCents: 200000, outCents: 363000, netCents: -163000 };
    expect(monthTone(ahead)).toBe("ok");
    expect(monthTone(slightlyBehind)).toBe("warn");
    expect(monthTone(behind)).toBe("bad");
    // Six days into October only the subscriptions have posted: not a verdict.
    expect(monthTone(young, true)).toBe("mute");
    expect(monthTone(young, false)).toBe("bad");
  });

  it("the tab renders the net tile green and collapses a long ledger behind one button", () => {
    const base = mockState().money as MoneyReport;
    const now = new Date().toISOString();
    const month = now.slice(0, 7);
    const ledger = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      ts: `${month}-03T12:00:00.000Z`,
      amountCents: -200000,
      currency: "MXN" as const,
      category: "revenue",
      note: `auto: salary ${i}`,
      client: "acme",
      vendor: null,
      project: null,
    }));
    const money: MoneyReport = { ...base, ledger, totals: [{ month, currency: "MXN", cents: -4000000 }], fx: null };
    const html = renderToStaticMarkup(createElement(MoneyTab, { usage: null, money }));
    expect(html).toContain("show all 20 entries");
    expect(html).toContain("auto: salary 0");
    expect(html).not.toContain("auto: salary 9");
    expect(html).toContain("40,000.00 MXN");
    expect(html).toContain("income minus spend");
    expect(html).not.toContain("spend minus income");
  });
});

describe("shapes beyond bars", () => {
  it("runningNet adds the months up oldest first and keeps each month's own net", () => {
    const rows = [
      { month: "2026-07", inCents: 100, outCents: 40, netCents: 60 },
      { month: "2026-08", inCents: 10, outCents: 90, netCents: -80 },
      { month: "2026-09", inCents: 50, outCents: 0, netCents: 50 },
    ];
    expect(runningNet(rows).map((p) => p.runningCents)).toEqual([60, -20, 30]);
    expect(runningNet(rows).map((p) => p.netCents)).toEqual([60, -80, 50]);
    expect(runningNet([])).toEqual([]);
    // Order is enforced, not assumed: the same months shuffled give the same line.
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(runningNet(shuffled).map((p) => [p.month, p.runningCents])).toEqual([
      ["2026-07", 60],
      ["2026-08", -20],
      ["2026-09", 30],
    ]);
  });

  it("the ring caps at six named parts and folds the rest gray by flag, not by label", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ category: `c${i}`, cents: 800 - i * 100, share: 0 }));
    const capped = capParts(eight);
    expect(capped).toHaveLength(7);
    expect(capped[6]).toMatchObject({ category: "2 more", cents: 200 + 100, rest: true });
    expect(capped.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1);
    // Already-folded input (the model's own "N more") passes through untouched.
    const six = [...eight.slice(0, 6), { category: "2 more", cents: 300, share: 0.1, rest: true as const }];
    expect(capParts(six)).toBe(six);
    // Two remainders, or a seventh named part beside one, merge into one gray row.
    const seven = [...eight.slice(0, 7), { category: "3 more", cents: 100, share: 0, rest: true as const }];
    expect(capParts(seven)[6]).toMatchObject({ category: "4 more", cents: 300, rest: true });
    // A real category that happens to be called "2 more" keeps its hue.
    const html = renderToStaticMarkup(createElement(Donut, { rows: [{ category: "2 more", cents: 60, share: 0.6 }, { category: "tools", cents: 40, share: 0.4 }], currency: "MXN", caption: "out" }));
    expect(html).toContain("var(--cat-1)");
    expect(html).toContain("var(--cat-2)");
    expect(html).not.toContain("var(--faint)");
    const eightHtml = renderToStaticMarkup(createElement(Donut, { rows: eight, currency: "MXN", caption: "out" }));
    expect(eightHtml).toContain("var(--faint)");
    expect(eightHtml).not.toContain("c7");
  });

  it("donutSlices are contiguous fractions that cover the circle, and negatives take no arc", () => {
    const s = donutSlices([70, 20, 10]);
    expect(s.map((x) => x.share)).toEqual([0.7, 0.2, 0.1]);
    expect(s[0]).toEqual({ start: 0, end: 0.7, share: 0.7 });
    expect(s[1]!.start).toBeCloseTo(0.7);
    expect(s[2]!.end).toBeCloseTo(1);
    expect(donutSlices([5, -3, 0]).map((x) => x.share)).toEqual([1, 0, 0]);
    expect(donutSlices([0, 0])).toEqual([]);
    expect(donutSlices([])).toEqual([]);
  });

  it("ringPath starts at twelve o'clock, flags large arcs, and draws a whole ring as two halves", () => {
    const quarter = ringPath(60, 60, 50, 30, 0, 0.25);
    expect(quarter.startsWith("M 60.00 10.00 A 50 50 0 0 1 110.00 60.00")).toBe(true);
    const threeQuarters = ringPath(60, 60, 50, 30, 0, 0.75);
    expect(threeQuarters).toContain("A 50 50 0 1 1");
    const whole = ringPath(60, 60, 50, 30, 0, 1);
    expect(whole.split("M ").length - 1).toBe(2);
    expect(whole).toContain("Z M");
  });

  it("fmtShortCents is short, signed by default, and unsigned for a total", () => {
    expect(fmtShortCents(2420000)).toBe("+24k");
    expect(fmtShortCents(-163000)).toBe("-1.6k");
    expect(fmtShortCents(85000)).toBe("+850");
    expect(fmtShortCents(6300000, false)).toBe("63k");
    expect(fmtShortCents(123456789)).toBe("+1.2M");
  });

  it("the folded card renders a line, rings with a legend, and a meter; a single type is a sentence", () => {
    const base = mockState().money as MoneyReport;
    const ledger = [
      { id: "a", ts: "2026-08-05T12:00:00.000Z", amountCents: -1500000, currency: "MXN" as const, category: "revenue", note: "", client: null, vendor: null, project: null },
      { id: "b", ts: "2026-09-05T12:00:00.000Z", amountCents: -1500000, currency: "MXN" as const, category: "revenue", note: "", client: null, vendor: null, project: null },
      { id: "c", ts: "2026-09-06T12:00:00.000Z", amountCents: 24900, currency: "USD" as const, category: "hosting", note: "", client: null, vendor: null, project: null },
      { id: "d", ts: "2026-09-07T12:00:00.000Z", amountCents: 120000, currency: "MXN" as const, category: "domains", note: "", client: null, vendor: null, project: null },
      { id: "e", ts: "2026-09-08T12:00:00.000Z", amountCents: 2000, currency: "USD" as const, category: "tools", note: "", client: null, vendor: null, project: null },
    ];
    const money: MoneyReport = { ...base, ledger, fx: { base: "MXN", mxnPerUsd: 18, asOf: "2026-10-05", stale: false } };
    const html = renderToStaticMarkup(createElement(FoldedFlows, { report: money, today: "2026-10-06T00:00:00.000Z" }));
    expect(html).toContain("<polyline"); // the running line
    expect(html).toContain("Where it stands");
    expect(html).toContain("var(--cat-1)"); // the costs ring, three parts
    expect(html).toContain("hosting");
    expect(html).toContain("all of it revenue"); // one revenue type is a sentence, not a ring
    expect(html).toContain("Commitment pressure");
  });
});

describe("a client's own running line", () => {
  const row = (id: string, ts: string, amountCents: number, currency: "MXN" | "USD", client: string | null) => ({
    id, ts, amountCents, currency, category: "revenue", note: "", client, vendor: null, project: null,
  });
  const base = mockState().money as MoneyReport;

  it("folds the client's months to MXN when a rate exists and ignores other clients", () => {
    const money: MoneyReport = {
      ...base,
      fx: { base: "MXN", mxnPerUsd: 20, asOf: "2026-10-05", stale: false },
      ledger: [
        row("a", "2026-08-05T12:00:00.000Z", -100000, "MXN", "acme"),
        row("b", "2026-09-05T12:00:00.000Z", -5000, "USD", "acme"), // 1,000.00 MXN in
        row("c", "2026-09-06T12:00:00.000Z", 20000, "MXN", "acme"),
        row("d", "2026-09-07T12:00:00.000Z", -999999, "MXN", "other"),
        row("e", "2026-09-08T12:00:00.000Z", 5000, "MXN", null),
      ],
    };
    const out = clientMonthlyFlows(money, "acme");
    expect(out).toMatchObject({ kind: "ok", currency: "MXN" });
    expect(out.kind === "ok" && out.rows).toEqual([
      { month: "2026-08", inCents: 100000, outCents: 0, netCents: 100000 },
      { month: "2026-09", inCents: 100000, outCents: 20000, netCents: 80000 },
    ]);
  });

  it("without a rate: one currency still draws in that currency, two currencies honestly draw nothing", () => {
    const one: MoneyReport = { ...base, fx: null, ledger: [row("a", "2026-09-05T12:00:00.000Z", -5000, "USD", "acme")] };
    expect(clientMonthlyFlows(one, "acme")).toEqual({ kind: "ok", rows: [{ month: "2026-09", inCents: 5000, outCents: 0, netCents: 5000 }], currency: "USD" });
    const two: MoneyReport = { ...base, fx: null, ledger: [row("a", "2026-09-05T12:00:00.000Z", -5000, "USD", "acme"), row("b", "2026-09-05T12:00:00.000Z", -5000, "MXN", "acme")] };
    expect(clientMonthlyFlows(two, "acme")).toEqual({ kind: "mixed" });
    expect(clientMonthlyFlows(two, "nobody")).toEqual({ kind: "no-rows" });
  });

  it("a running line sums every month it is given and only trims what is drawn (lucy)", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ month: `2026-0${i + 1}`, inCents: 1000, outCents: 0, netCents: 1000 }));
    const drawn = runningNet(seven, 6);
    expect(drawn).toHaveLength(6);
    expect(drawn[0]!.month).toBe("2026-02");
    expect(drawn[5]!.runningCents).toBe(7000); // January is in the total even though it is not drawn
    expect(runningNet(seven)).toHaveLength(7);
    // And the client helper never trims months itself.
    const money: MoneyReport = {
      ...base,
      fx: null,
      ledger: seven.map((m, i) => row(`m${i}`, `${m.month}-05T12:00:00.000Z`, -1000, "MXN", "acme")),
    };
    const out = clientMonthlyFlows(money, "acme");
    expect(out.kind === "ok" && out.rows.length).toBe(7);
  });

  it("the clients card draws a compact line per client from the ledger", () => {
    const money: MoneyReport = {
      ...base,
      fx: null,
      ledger: [row("a", "2026-08-05T12:00:00.000Z", -100000, "MXN", "acme"), row("b", "2026-09-05T12:00:00.000Z", -100000, "MXN", "acme")],
      clients: [{ client: "acme", projects: [], commitmentCount: 0, tokens: 0, sessions: 0, money: [{ currency: "MXN", inCents: 200000, outCents: 0, monthlyCents: 0 }] }],
    };
    const html = renderToStaticMarkup(createElement(Clients, { money }));
    expect(html).toContain("<polyline");
    expect(html).toContain("running net, oldest first");
    expect(html).toContain("2,000.00 MXN");
    expect(html).not.toContain("table view");
  });
});

describe("goals measure the ledger", () => {
  const base = mockState().money as MoneyReport;
  const row = (id: string, ts: string, amountCents: number, currency: "MXN" | "USD", client: string | null = null) => ({
    id, ts, amountCents, currency, category: "revenue", note: "", client, vendor: null, project: null,
  });
  const goal = (over: Partial<MoneyGoal>): MoneyGoal => ({
    id: "g-1", label: "", kind: "in", targetCents: 100000, currency: "MXN", month: null, by: null, client: null, createdAt: "2026-10-01T00:00:00.000Z", ...over,
  });
  const now = "2026-10-06T12:00:00.000Z";
  const ledger = [
    row("a", "2026-10-02T12:00:00.000Z", -40000, "MXN", "acme"),
    row("b", "2026-10-03T12:00:00.000Z", -1000, "USD", "other"), // 20,000 MXN at 20
    row("c", "2026-10-04T12:00:00.000Z", 30000, "MXN"),
    row("d", "2026-09-04T12:00:00.000Z", -500000, "MXN", "acme"),
  ];
  const fx = { base: "MXN" as const, mxnPerUsd: 20, asOf: "2026-10-05", stale: false };

  it("convertCents goes both ways through the rate and refuses without one", () => {
    expect(convertCents(1000, "USD", "MXN", fx)).toBe(20000);
    expect(convertCents(20000, "MXN", "USD", fx)).toBe(1000);
    expect(convertCents(5, "MXN", "MXN", null)).toBe(5);
    expect(convertCents(5, "USD", "MXN", null)).toBeNull();
  });

  it("an income goal for this month counts income only, folded, and says what it measured", () => {
    const money: MoneyReport = { ...base, ledger, fx };
    const p = goalProgress(money, goal({ targetCents: 100000 }), now);
    expect(p.haveCents).toBe(60000); // 40,000 + 20,000 folded; the 30,000 out is not income
    expect(p.ratio).toBeCloseTo(0.6);
    expect(p.met).toBe(false);
    expect(p.tone).toBe("warn");
    expect(p.scope).toContain("this month (2026-10)");
    expect(p.uncounted).toBe(0);
    // Scoped to a client, and to a named month.
    expect(goalProgress(money, goal({ client: "acme" }), now).haveCents).toBe(40000);
    expect(goalProgress(money, goal({ client: "acme", month: "2026-09", targetCents: 400000 }), now)).toMatchObject({ haveCents: 500000, met: true, tone: "ok" });
  });

  it("without a rate the other currency is counted out loud, never silently", () => {
    const money: MoneyReport = { ...base, ledger, fx: null };
    const p = goalProgress(money, goal({}), now);
    expect(p.haveCents).toBe(40000);
    expect(p.uncounted).toBe(1);
    // An income goal the counted rows already reach is met (they are a lower
    // bound); one they do not reach is unknown, not missed. A cap or a net with
    // uncounted rows is never called met on what was counted.
    expect(p.met).toBeNull();
    expect(goalProgress(money, goal({ targetCents: 40000 }), now).met).toBe(true);
    // A USD income row is not spending, so the cap has nothing uncounted; add a
    // USD spend and the cap becomes unknowable without a rate.
    expect(goalProgress(money, goal({ kind: "out", targetCents: 9999999 }), now).met).toBe(true);
    const withUsdSpend: MoneyReport = { ...money, ledger: [...ledger, row("e", "2026-10-05T12:00:00.000Z", 700, "USD")] };
    expect(goalProgress(withUsdSpend, goal({ kind: "out", targetCents: 9999999 }), now).met).toBeNull();
    expect(goalProgress(money, goal({ kind: "net", targetCents: 1 }), now)).toMatchObject({ met: null, tone: "mute" });
  });

  it("spending exactly the cap is within it, and the tone agrees", () => {
    const money: MoneyReport = { ...base, ledger, fx };
    expect(goalProgress(money, goal({ kind: "out", targetCents: 30000 }), now)).toMatchObject({ met: true, tone: "warn" });
    expect(goalProgress(money, goal({ kind: "out", targetCents: 29999 }), now)).toMatchObject({ met: false, tone: "bad" });
  });

  it("a net goal past its date is judged at the date: later income cannot meet it late", () => {
    const money: MoneyReport = { ...base, ledger, fx };
    // By 2026-10-01 only September's 500,000 had happened.
    const p = goalProgress(money, goal({ kind: "net", targetCents: 520000, by: "2026-10-01" }), now);
    expect(p.haveCents).toBe(500000);
    expect(p.met).toBe(false);
    expect(p.tone).toBe("bad");
    // The same goal with a date still ahead counts everything so far.
    expect(goalProgress(money, goal({ kind: "net", targetCents: 520000, by: "2026-12-31" }), now).haveCents).toBe(530000);
  });

  it("says when the page holds only the newest rows", () => {
    const many = Array.from({ length: 500 }, (_, i) => row(`r${i}`, "2026-10-01T12:00:00.000Z", -100, "MXN"));
    expect(goalProgress({ ...base, ledger: many, fx }, goal({}), now).partial).toBe(true);
    expect(goalProgress({ ...base, ledger, fx }, goal({}), now).partial).toBe(false);
  });

  it("a spending cap is met while under it and goes bad over it; a net goal sums every month and watches its date", () => {
    const money: MoneyReport = { ...base, ledger, fx };
    expect(goalProgress(money, goal({ kind: "out", targetCents: 50000 }), now)).toMatchObject({ haveCents: 30000, met: true, tone: "ok" });
    expect(goalProgress(money, goal({ kind: "out", targetCents: 20000 }), now)).toMatchObject({ haveCents: 30000, met: false, tone: "bad" });
    const net = goalProgress(money, goal({ kind: "net", targetCents: 1000000, by: "2026-12-31" }), now);
    expect(net.haveCents).toBe(40000 + 20000 - 30000 + 500000);
    expect(net.daysLeft).toBe(86);
    expect(net.met).toBe(false);
    const late = goalProgress(money, goal({ kind: "net", targetCents: 1000000, by: "2026-10-01" }), now);
    expect(late.tone).toBe("bad");
  });

  it("goalSentence reads each kind as one line", () => {
    expect(goalSentence(goal({ targetCents: 6000000 }))).toBe("Bring in at least 60,000.00 MXN each month");
    expect(goalSentence(goal({ kind: "out", targetCents: 500000, month: "2026-10", client: "acme" }))).toBe("Keep spending under 5,000.00 MXN in 2026-10 on acme");
    expect(goalSentence(goal({ kind: "net", targetCents: 20000000, by: "2026-12-31" }))).toBe("Reach a running net of 200,000.00 MXN by 2026-12-31");
  });

  it("the goals card renders progress and the empty state", () => {
    const money: MoneyReport = { ...base, ledger, fx, goals: [goal({ label: "Cover the month", targetCents: 100000 })] };
    const html = renderToStaticMarkup(createElement(Goals, { money, today: now, onChanged: () => undefined }));
    expect(html).toContain("Cover the month");
    expect(html).toContain("600.00 MXN of 1,000.00 MXN");
    expect(html).toContain("0 of 1 met");
    const empty = renderToStaticMarkup(createElement(Goals, { money: { ...money, goals: [] }, today: now, onChanged: () => undefined }));
    expect(empty).toContain("No goals yet");
  });
});

describe("tokens by project", () => {
  it("ranks projects by input plus output, shares of the total, tail folded past eight", () => {
    const byProject = Array.from({ length: 10 }, (_, i) => ({
      project: `p${i}`, inputTokens: 1000 * (10 - i), outputTokens: 100, cacheReadTokens: 999999, cacheWriteTokens: 0, costUsd: 1.5, sessions: 2,
    }));
    const rows = projectEffort({ byProject });
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ project: "p0", tokens: 10100, sessions: 2 });
    expect(rows[8]).toMatchObject({ project: "2 more", tokens: 3200, sessions: 4, costUsd: 3 });
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1);
    expect(projectEffort(null)).toEqual([]);
    expect(projectEffort({ byProject: [{ ...byProject[0]!, inputTokens: 0, outputTokens: 0 }] })).toEqual([]);
  });
});
