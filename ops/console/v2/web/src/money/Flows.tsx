// Income against spending, where it comes from, where it goes, and where it
// has got to.
//
// the owner: "if you could add some useful statistical graphs for my income and
// spending... same kind of color coding as the machines tab, where we have it go
// from green to red, would be great, because there's a lot of screen space."
// And later: "only bar graphs? can we get some variety?"
//
// So each question gets the form that reads it best, per the dataviz method:
// what moved each month is paired BARS (two magnitudes side by side); where the
// money has got to is a LINE (a trend over time); where it comes from and goes
// is a RING each (part-to-whole, at most six parts); the committed position is a
// METER (one ratio against a limit). All per currency, because this ledger never
// combines them; the folded card is the one place both are read together.
//
// The green-to-red language is borrowed from the Machines tab rather than
// reinvented, so a band means the same thing on both pages. What differs is what
// counts as bad: a month where more went out than came in is worth noticing, not
// an emergency, so the bands are about pressure rather than failure.
import type { MoneyReport } from "@shared/api";
import { Card, CardBody, CardHead, Chip, cx } from "../ui/primitives";
import { ArcMeter, Donut, RunningNet } from "./Charts";
import {
  ALL_MONTHS,
  categoryFlows,
  commitmentPressure,
  fmtCents,
  fmtShortCents,
  foldedMonthlyFlows,
  foldedPressure,
  monthlyFlows,
  monthTone,
  runningNet,
  spendByCategory,
  type MonthFlow,
} from "./model";

const TONE_INK: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", mute: "text-mute" };

function MonthBars({ rows, currency, currentMonth }: { rows: MonthFlow[]; currency: string; currentMonth: string }) {
  if (rows.length === 0) {
    return <p className="m-0 text-[13px] text-mute">No {currency} entries yet.</p>;
  }
  // One scale across both directions so the two bars are comparable. Scaling each
  // to its own maximum would make a small month look like a big one.
  const peak = Math.max(...rows.flatMap((r) => [r.inCents, r.outCents]), 1);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        {rows.map((row) => {
          const isCurrent = row.month === currentMonth;
          const tone = monthTone(row, isCurrent);
          const netLabel = `Net ${fmtCents(row.netCents, currency)}${isCurrent ? ", so far" : ""}`;
          return (
            <div key={row.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              {/* The bar box has a fixed pixel height of its own. A percentage bar
                  inside an auto-height flex column resolves to nothing, which is
                  how this chart drew six empty months with labels under them. */}
              <div className="flex w-full items-end justify-center gap-1" style={{ height: 110 }}>
                <div
                  className="w-1/2 rounded-t-[2px] bg-[var(--chart-2)]"
                  style={{ height: `${(row.inCents / peak) * 100}%` }}
                  title={`In ${fmtCents(row.inCents, currency)}`}
                />
                <div
                  className="w-1/2 rounded-t-[2px] bg-[var(--chart-1)]"
                  style={{ height: `${(row.outCents / peak) * 100}%` }}
                  title={`Out ${fmtCents(row.outCents, currency)}`}
                />
              </div>
              {/* The net is written under every month, not hidden in a hover: a
                  glance has to be able to read the number, not only the color. */}
              <span className={cx("text-[10px] tabular-nums", TONE_INK[tone])} title={netLabel}>
                {fmtShortCents(row.netCents)}
              </span>
              <span className="text-[10px] tabular-nums text-mute" title={netLabel}>
                {row.month.slice(5)}
                {isCurrent ? "*" : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mute">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-[var(--chart-2)]" /> in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-[var(--chart-1)]" /> out
        </span>
        <span className="ml-auto">net under each month; * is still running, so it is not judged yet</span>
      </div>
    </div>
  );
}

/**
 * A breakdown by type. Two or more parts make a ring; one part is not a
 * part-to-whole at all (a one-slice ring is a circle with a number in it), so it
 * is said in a sentence instead.
 */
function Breakdown({
  rows,
  currency,
  caption,
  empty,
}: {
  rows: { category: string; cents: number; share: number }[];
  currency: string;
  caption: string;
  empty: string;
}) {
  if (rows.length === 0) return <p className="m-0 text-[13px] text-mute">{empty}</p>;
  if (rows.length === 1) {
    const only = rows[0]!;
    return (
      <p className="m-0 text-[13px] text-ink">
        <span className="tabular-nums font-semibold">{fmtCents(only.cents, currency)}</span>
        <span className="text-mute">, all of it {only.category}</span>
      </p>
    );
  }
  return <Donut rows={rows} currency={currency} caption={caption} />;
}

/** The one forecast on this card, and it says so. */
function Pressure({ report, currency, folded = false }: { report: MoneyReport | null; currency: string; folded?: boolean }) {
  const ratio = folded ? foldedPressure(report) : commitmentPressure(report, currency);
  if (ratio === null) {
    return (
      <p className="m-0 text-[12px] text-mute">
        Nothing recurring coming in{folded ? "" : ` for ${currency}`}, so there is no ratio to take. Add a retainer and
        this becomes what share of it the subscriptions eat.
      </p>
    );
  }
  const tone = ratio < 0.5 ? "ok" : ratio < 0.85 ? "warn" : "bad";
  const shown = Math.round(ratio * 100);
  const reading =
    tone === "bad"
      ? `Committed spending takes ${shown}% of committed income`
      : tone === "warn"
        ? `Committed spending takes ${shown}% of committed income, worth watching`
        : `Committed spending takes ${shown}% of committed income, comfortable`;
  return (
    <div className="flex items-center gap-4" title={reading}>
      <ArcMeter pct={ratio * 100} tone={tone} label={reading} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.14em] text-mute">Commitment pressure</span>
        <span className={cx("text-[13px]", TONE_INK[tone])}>{reading}</span>
        <p className="m-0 text-[10px] text-mute">
          A forecast from the repeating list, never from what moved. Under half is comfortable.
        </p>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-mute">{children}</div>;
}

export function Flows({ report, currency, today = new Date().toISOString() }: { report: MoneyReport | null; currency: string; today?: string }) {
  const rows = monthlyFlows(report, currency);
  const spend = spendByCategory(report, currency).map((r) => ({ category: r.category, cents: r.outCents, share: r.share }));
  return (
    <Card>
      <CardHead title={`In and out, ${currency}`} chip={<Chip tone="mute">{rows.length} months</Chip>} />
      <CardBody className="flex flex-col gap-4">
        <MonthBars rows={rows} currency={currency} currentMonth={today.slice(0, 7)} />
        <div className="border-t border-line pt-3">
          <SectionLabel>Where it stands</SectionLabel>
          {/* summed over every visible month, six drawn: see runningNet */}
          <RunningNet points={runningNet(monthlyFlows(report, currency, ALL_MONTHS), 6)} currency={currency} />
        </div>
        <div className="border-t border-line pt-3">
          <SectionLabel>Where it goes</SectionLabel>
          <Breakdown rows={spend} currency={currency} caption="out" empty={`Nothing spent in ${currency} yet.`} />
        </div>
        <div className="border-t border-line pt-3">
          <Pressure report={report} currency={currency} />
        </div>
      </CardBody>
    </Card>
  );
}

/** The line every folded figure hangs from: which rate, from when, how fresh. */
export function FxNote({ report }: { report: MoneyReport | null }) {
  const fx = report?.fx ?? null;
  if (!fx) return null;
  return (
    <p className="m-0 text-[10px] text-mute">
      USD folded at {fx.mxnPerUsd.toFixed(2)} MXN (ECB {fx.asOf}
      {fx.stale ? ", cached; the rate API was unreachable" : ""}). The ledger itself stays exact per currency.
    </p>
  );
}

/**
 * The combined card: both currencies folded into MXN so money in and money out
 * read as one story, whatever currency each payment happened in. Bars for the
 * months beside the running line; a ring each for revenue by type and costs by
 * type; the meter last.
 */
export function FoldedFlows({ report, today = new Date().toISOString() }: { report: MoneyReport | null; today?: string }) {
  const rows = foldedMonthlyFlows(report) ?? [];
  const revenue = categoryFlows(report, "in") ?? [];
  const costs = categoryFlows(report, "out") ?? [];
  return (
    <Card>
      <CardHead title="In and out, everything in MXN" chip={<Chip tone="mute">{rows.length} months</Chip>} />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionLabel>What moved each month</SectionLabel>
            <MonthBars rows={rows} currency="MXN" currentMonth={today.slice(0, 7)} />
          </div>
          <div>
            <SectionLabel>Where it stands</SectionLabel>
            {/* summed over every visible month, six drawn: see runningNet */}
            <RunningNet points={runningNet(foldedMonthlyFlows(report, ALL_MONTHS) ?? [], 6)} currency="MXN" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="border-t border-line pt-3">
            <SectionLabel>Revenue by type</SectionLabel>
            <Breakdown rows={revenue} currency="MXN" caption="in" empty="Nothing coming in yet." />
          </div>
          <div className="border-t border-line pt-3">
            <SectionLabel>Costs by type</SectionLabel>
            <Breakdown rows={costs} currency="MXN" caption="out" empty="Nothing spent yet." />
          </div>
        </div>
        <div className="border-t border-line pt-3">
          <Pressure report={report} currency="MXN" folded />
        </div>
        <FxNote report={report} />
      </CardBody>
    </Card>
  );
}
