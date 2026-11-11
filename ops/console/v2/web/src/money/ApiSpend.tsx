// Live Codex/OpenAI API spend, next to the Claude token chart it mirrors.
//
// This is a vendor's live readout, NOT ledger data: the card never adds its
// figures into the ledger charts, so an invoice recorded later for the same
// spend cannot double-count. One series, so the title names it and no legend
// is needed; every bar carries its own day and amount on hover.
import type { MoneyReport } from "@shared/api";
import { Card, CardBody, CardHead, Chip } from "../ui/primitives";
import { fmtCents, foldCents, spendDays } from "./model";

const BAR_DAYS = 30;

export function ApiSpend({ report }: { report: MoneyReport | null }) {
  const spend = report?.apiSpend ?? null;
  if (!spend) return null;

  if (!spend.configured) {
    return (
      <Card>
        <CardHead title="Codex API spend" chip={<Chip tone="mute">not configured</Chip>} />
        <CardBody>
          <p className="m-0 text-[13px] text-mute">
            Live spend needs an OpenAI admin credential: set CONSOLE_OPENAI_ADMIN in the console server environment
            (ops/config/site.env on hqbox) and restart hq-console. Until then nothing is shown rather than guessed.
          </p>
        </CardBody>
      </Card>
    );
  }

  // Every calendar day of the window, zero-filled, so a quiet stretch shows as
  // a gap rather than two spend days sitting next to each other.
  const days = spendDays(spend, new Date().toISOString(), BAR_DAYS);
  const anySpend = days.some((d) => d.cents > 0);
  const peak = Math.max(...days.map((d) => d.cents), 1);
  const foldedMonth = foldCents(spend.monthCents, "USD", report?.fx ?? null);

  return (
    <Card>
      <CardHead
        title="Codex API spend"
        chip={
          spend.error ? (
            <Chip tone="warn">{spend.error}</Chip>
          ) : (
            <Chip tone="mute">live, {days.length}d</Chip>
          )
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-mute">This month</span>
          <span className="ml-auto tabular-nums text-[19px] font-semibold leading-none text-ink">
            {fmtCents(spend.monthCents, "USD")}
          </span>
          {foldedMonth !== null ? (
            <span className="tabular-nums text-[12px] text-mute">{fmtCents(foldedMonth, "MXN")}</span>
          ) : null}
        </div>
        {!anySpend ? (
          <p className="m-0 text-[13px] text-mute">
            {spend.error ? "The last read failed; the daily view returns with the next successful one." : "No API spend in the last month."}
          </p>
        ) : (
          <div className="flex items-end gap-[2px]" style={{ height: 72 }} role="img" aria-label="Codex API spend per day">
            {days.map((d) => (
              <div
                key={d.day}
                className="min-w-0 flex-1 rounded-t-[2px] bg-[var(--chart-3)]"
                style={{ height: d.cents > 0 ? `${Math.max(3, (d.cents / peak) * 100)}%` : "1px", opacity: d.cents > 0 ? 1 : 0.35 }}
                title={`${d.day}: ${fmtCents(d.cents, "USD")}`}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
