// Money: live token usage with the day chart, the plan gauge, and the manual
// per-currency ledger (bead hq-9fri, design 4.5). Integer cents; MXN and USD
// are never combined; deletes are tombstones with op-key idempotency.

import { useMemo, useState } from "react";
import type { MoneyReport, UsageSummary } from "@shared/api";
import { api } from "../data/client";
import { useOpRunner } from "../now/ops";
import { toastError, toastInfo } from "../now/toast";
import { useOpKey } from "../machines/model";
import { CATEGORIES, LEDGER_PREVIEW, asNet, chartDays, currenciesIn, fmtCents, foldedMonthNet, ledgerCsv, ledgerPreview, monthTiles, parseAmount, projectEffort, rangeOptions, slugifyTag } from "../money/model";
import { Goals } from "../money/Goals";
import { TokensChart } from "../money/TokensChart";
import { Commitments } from "../money/Commitments";
import { Clients } from "../money/Clients";
import { Flows, FoldedFlows } from "../money/Flows";
import { ApiSpend } from "../money/ApiSpend";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip, PageHeader, RigSigil, StatTile, Table, TableWrap, Td, Th, cx, inputClass } from "../ui/primitives";
import { fmtAge, fmtCount, pct } from "../ui/format";

function EntryForm({ onAdded }: { onAdded: () => void }) {
  const run = useOpRunner();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [category, setCategory] = useState<string>("hosting");
  const [note, setNote] = useState("");
  // The three tags that make the client and effort views possible. Without them
  // on THIS form the whole rollup is unreachable through the normal way of
  // recording a payment, which is the only way most payments get recorded.
  const [client, setClient] = useState("");
  const [vendor, setVendor] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  // Fingerprint the CANONICAL payload, not the raw text (lucy fix-verify:
  // "1" and "1.00" are the same 100-cent charge and must reuse one op key).
  const entryKey = useOpKey(
    `${parseAmount(amount) ?? "none"}|${currency}|${category}|${note}|${client}|${vendor}|${project}`,
  );

  async function submit(): Promise<void> {
    const cents = parseAmount(amount);
    if (cents === null) {
      toastError("amount must be a non-zero number like 249.99 (negative = income/refund)");
      return;
    }
    // Fold human tags into the slugs the server stores ("Orbit Acme" means
    // orbit-acme); only input with nothing usable in it still bounces.
    const tags: Record<string, string | undefined> = {};
    for (const [field, value] of [["client", client], ["vendor", vendor], ["project", project]] as const) {
      const slug = slugifyTag(value);
      if (slug === "") {
        toastError(`${field} needs at least one letter or number`);
        return;
      }
      // Never truncate to fit: two long distinct names must not merge silently.
      if (slug !== null && slug.length > 40) {
        toastError(`keep ${field} under 40 characters`);
        return;
      }
      tags[field] = slug ?? undefined;
    }
    setBusy(true);
    try {
      // The key is held across retries; it resets only once an entry lands, so
      // a dropped response and a re-click cannot double-charge.
      const result = await run("ledger entry", () =>
        api.moneyEntry(entryKey.current(), cents, currency, category, note, {
          client: tags.client,
          vendor: tags.vendor,
          project: tags.project,
        }),
      );
      if (result.ok) {
        entryKey.reset();
        toastInfo(`recorded ${fmtCents(cents, currency)}${client.trim() ? ` for ${client.trim()}` : ""}`);
        setAmount("");
        setNote("");
        onAdded();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="sr-only" htmlFor="money-amount">
        Amount
      </label>
      <input
        id="money-amount"
        className={cx(inputClass, "w-28")}
        placeholder="249.99"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label className="sr-only" htmlFor="money-currency">
        Currency
      </label>
      <select
        id="money-currency"
        className="rounded-sub border border-line bg-panel px-1.5 py-1 text-[12px] text-ink"
        value={currency}
        onChange={(e) => setCurrency(e.target.value as "MXN" | "USD")}
      >
        <option>MXN</option>
        <option>USD</option>
      </select>
      <label className="sr-only" htmlFor="money-category">
        Category
      </label>
      <select
        id="money-category"
        className="rounded-sub border border-line bg-panel px-1.5 py-1 text-[12px] text-ink"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {CATEGORIES.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor="money-note">
        Note
      </label>
      <input
        id="money-note"
        className={cx(inputClass, "min-w-40 flex-1")}
        placeholder="note (optional)"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
        Add
      </Button>
      <div className="flex w-full flex-wrap items-center gap-1.5">
        <label className="sr-only" htmlFor="money-client">
          Client
        </label>
        <input
          id="money-client"
          className={cx(inputClass, "min-w-28 flex-1")}
          placeholder="client (optional)"
          value={client}
          maxLength={40}
          onChange={(e) => setClient(e.target.value)}
        />
        <label className="sr-only" htmlFor="money-vendor">
          Vendor
        </label>
        <input
          id="money-vendor"
          className={cx(inputClass, "min-w-28 flex-1")}
          placeholder="vendor (optional)"
          value={vendor}
          maxLength={40}
          onChange={(e) => setVendor(e.target.value)}
        />
        <label className="sr-only" htmlFor="money-project">
          Project
        </label>
        <input
          id="money-project"
          className={cx(inputClass, "min-w-28 flex-1")}
          placeholder="project (optional)"
          value={project}
          maxLength={40}
          onChange={(e) => setProject(e.target.value)}
        />
      </div>
    </div>
  );
}

function DeleteButton({ id }: { id: string }) {
  const run = useOpRunner();
  const deleteKey = useOpKey(id);
  const [busy, setBusy] = useState(false);

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      const result = await run("delete entry", () => api.moneyDelete(deleteKey.current(), id));
      if (result.ok) {
        deleteKey.reset();
        toastInfo("entry deleted");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
      Delete
    </Button>
  );
}

export function MoneyTab({ usage, money }: { usage: UsageSummary | null; money: MoneyReport | null }) {
  const ranges = rangeOptions(money);
  const [range, setRange] = useState<number>(ranges.includes(30) ? 30 : (ranges[ranges.length - 1] ?? 7));
  const [showAll, setShowAll] = useState(false);
  const days = useMemo(() => chartDays(money, range), [money, range]);
  const nowIso = new Date().toISOString();
  const tiles = monthTiles(money, nowIso);
  const currencies = currenciesIn(money);
  // Headline figures read as NET (income minus spend): see asNet in the model.
  const foldedNet = foldedMonthNet(money, nowIso);
  const monthNet = foldedNet === null ? null : asNet(foldedNet);
  const beforeFolding = tiles.map((t) => fmtCents(asNet(t.cents), t.currency)).join(" and ");
  const ledger = ledgerPreview(money?.ledger ?? [], showAll);

  function exportCsv(): void {
    const csv = ledgerCsv(money?.ledger ?? []);
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hq-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHeader
        title="Money"
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Tokens today"
          value={usage ? fmtCount(usage.tokensToday) : "-"}
          detail={usage ? `${fmtCount(usage.outputTokensToday)} output, ${usage.sessionsToday} sessions` : "no usage collector"}
        />
        <StatTile
          label="Plan usage"
          value={usage?.planUsage.fiveHourPct != null ? pct(usage.planUsage.fiveHourPct) : "-"}
          detail={usage?.planUsage.weeklyPct != null ? `${pct(usage.planUsage.weeklyPct)} weekly` : "5 h window"}
        />
        {money?.fx ? (
          // One folded figure: money is money, whatever currency it moved in.
          // Green when ahead, red when behind, and the sign agrees with the color.
          <StatTile
            label="This month, net"
            value={
              <span className={(monthNet ?? 0) >= 0 ? "text-ok" : "text-bad"}>
                {fmtCents(monthNet ?? 0, "MXN")}
              </span>
            }
            detail={tiles.length > 0 ? `income minus spend, folded; ${beforeFolding} before folding` : "no ledger entries yet"}
          />
        ) : tiles.length > 0 ? (
          tiles.slice(0, 2).map((t) => (
            <StatTile
              key={t.currency}
              label={`This month, ${t.currency}`}
              value={
                <span className={asNet(t.cents) >= 0 ? "text-ok" : "text-bad"}>{fmtCents(asNet(t.cents), t.currency)}</span>
              }
              detail="manual ledger, income minus spend"
            />
          ))
        ) : (
          <StatTile label="This month" value="0" detail="no ledger entries yet" />
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHead
            title="Tokens per day"
            chip={money ? <Chip tone="mute">{money.rangeDays}d available</Chip> : <Chip tone="mute">loading</Chip>}
            actions={
              <span className="flex gap-1.5">
                {ranges.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={cx(
                      "rounded-sub px-2 py-0.5 text-[12px]",
                      range === d ? "bg-accent/20 text-accent" : "bg-chip text-mute",
                    )}
                    aria-pressed={range === d}
                    onClick={() => setRange(d)}
                  >
                    {d}d
                  </button>
                ))}
              </span>
            }
          />
          <CardBody className="flex flex-col gap-4">
            <TokensChart days={days} />
            {/* the owner: "tokens spent per project, if we can find that out". We
                can: usage.py attributes every transcript to a project by its
                working directory, including a worktree spawned for a bead. This
                also fills the space the taller ledger card used to leave blank. */}
            <div className="border-t border-line pt-3">
              <div className="mb-2 flex items-baseline gap-2 text-[10px] uppercase tracking-[0.16em] text-mute">
                <span>Tokens by project</span>
                <span className="ml-auto normal-case tracking-normal">last {usage?.byProjectDays ?? 30} days, input plus output</span>
              </div>
              {(() => {
                const rows = projectEffort(usage);
                if (rows.length === 0) return <p className="m-0 text-[13px] text-mute">No project has spent tokens in the window yet.</p>;
                const peak = Math.max(...rows.map((r) => r.tokens), 1);
                return (
                  <div className="flex flex-col gap-1.5">
                    {rows.map((r) => (
                      <div key={r.project} className="flex items-center gap-2">
                        <span className="flex w-36 shrink-0 items-center gap-1.5 truncate text-[12px] text-ink" title={r.project}>
                          {/^\d+ more$/.test(r.project) ? null : <RigSigil id={r.project} size={12} />}
                          {r.project}
                        </span>
                        <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
                          <span className="block h-full rounded-full bg-[var(--chart-2)]" style={{ width: `${(r.tokens / peak) * 100}%` }} />
                        </span>
                        <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-mute">{Math.round(r.share * 100)}%</span>
                        <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-ink">{fmtCount(r.tokens)}</span>
                        <span className="w-36 shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-mute" title="what those tokens would cost at API list price; the plan is a subscription, so this is not an invoice">
                          {r.sessions} sessions, {r.costUsd.toFixed(0)} USD list
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHead
            title="Ledger"
            chip={<Chip tone="mute">{money?.ledger.length ?? 0} entries</Chip>}
            actions={
              <ButtonRow>
                <Button size="sm" onClick={exportCsv} disabled={!money || money.ledger.length === 0}>
                  CSV
                </Button>
              </ButtonRow>
            }
          />
          <CardBody className="px-0 pt-0 pb-0">
            <div className="border-b border-line px-3.5 py-2.5">
              <EntryForm onAdded={() => undefined} />
            </div>
            {money && money.totals.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-b border-line px-3.5 py-2 text-[12px]">
                {/* Net per month, same reading as the tile: positive means ahead. */}
                {money.totals.slice(0, 6).map((t) => (
                  <Chip key={`${t.month}-${t.currency}`} tone={asNet(t.cents) >= 0 ? "ok" : "bad"}>
                    {t.month}: {fmtCents(asNet(t.cents), t.currency)}
                  </Chip>
                ))}
              </div>
            ) : null}
            {!money || money.ledger.length === 0 ? (
              <p className="m-0 px-3.5 py-3 text-[13px] text-mute">
                Nothing recorded yet. Hosting, API subscriptions, domains, and revenue all go here.
              </p>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th numeric>Amount</Th>
                      <Th>Category</Th>
                      <Th>Note</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.rows.map((e) => (
                      <tr key={e.id}>
                        {/* The day, not "59 d 18 h ago": a date is read, an age is computed.
                            The UTC day on purpose: it is the day the month chips and totals
                            count the entry under, and auto-posted rows sit at noon UTC. */}
                        <Td>
                          <span className="tabular-nums" title={`${fmtAge(e.ts)} ago (UTC day, as the month totals count it)`}>
                            {e.ts.slice(0, 10)}
                          </span>
                        </Td>
                        <Td numeric>
                          <span className={e.amountCents < 0 ? "text-ok" : undefined}>
                            {fmtCents(e.amountCents, e.currency)}
                          </span>
                        </Td>
                        <Td>
                          <Chip tone="mute">{e.category}</Chip>
                        </Td>
                        <Td>
                          <span className="block max-w-[28ch] truncate" title={e.note}>
                            {e.note}
                          </span>
                        </Td>
                        <Td>
                          <DeleteButton id={e.id} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {/* Collapsed by default: the auto-posted rows make the full list long on
                    purpose, and the dashboard is read at a glance, expanded on request. */}
                {money.ledger.length > LEDGER_PREVIEW ? (
                  <div className="border-t border-line px-3.5 py-2">
                    <Button size="sm" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                      {showAll ? "show latest only" : `show all ${money.ledger.length} entries`}
                    </Button>
                  </div>
                ) : null}
              </TableWrap>
            )}
          </CardBody>
        </Card>
      </div>

      {/* The LEDGER never combines currencies; the VIEW folds them when a rate
          is available, because money in and money out is one story whichever
          currency each payment moved in. Without a rate the tab falls back to
          one card per currency rather than inventing one. */}
      {money?.fx ? (
        <div className="mt-4">
          <FoldedFlows report={money} />
        </div>
      ) : currencies.length > 0 ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {currencies.map((currency) => (
            <Flows key={currency} report={money} currency={currency} />
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {/* No refresh call here on purpose. The write routes call
            collectors.refresh("money") and the new slice is pushed down the
            console socket, so the card re-renders from the store. Fetching state
            here as well and discarding it, which is what this used to do, only
            looked like a refresh. */}
        <Goals money={money} today={nowIso} onChanged={() => undefined} />
        <Commitments money={money} today={new Date().toISOString()} onChanged={() => undefined} />
        <Clients money={money} />
        <ApiSpend report={money} />
      </div>
    </>
  );
}
