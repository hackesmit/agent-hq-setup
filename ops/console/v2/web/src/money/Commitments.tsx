// Subscriptions, tools and retainers: the money that repeats.
//
// Held apart from the ledger on purpose. The ledger records what MOVED; a
// commitment records what is SCHEDULED to move. They answer different questions
// and adding them together turns a forecast into a balance, so they never share
// a total anywhere in this tab.
//
// Sign convention is the ledger's and predates this file: a POSITIVE amount is
// money going out (a subscription, a tool), a NEGATIVE amount is money coming in
// (a retainer). Nothing here re-signs a stored value; the direction is named in
// the interface instead, which is where a reader can actually see it.
import { useState } from "react";
import type { MoneyCommitment, MoneyReport } from "@shared/api";
import { api } from "../data/client";
import { useOpRunner } from "../now/ops";
import { useOpKey } from "../machines/model";
import { toastInfo } from "../now/toast";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip, cx, inputClass } from "../ui/primitives";
import { CADENCES, CADENCE_LABEL, daysUntil, fmtCents, foldedRunRate, parseAmount, slugifyTag, splitCommitments } from "./model";
import { CATEGORIES } from "./model";

function DueChip({ commitment, today }: { commitment: MoneyCommitment; today: string }) {
  const days = daysUntil(commitment.nextDueOn, today);
  if (days === null) return <Chip tone="mute">ended</Chip>;
  if (days <= 0) return <Chip tone="bad">due today</Chip>;
  if (days <= 3) return <Chip tone="warn">{days}d</Chip>;
  return <Chip tone="mute">{days}d</Chip>;
}

function Row({
  commitment,
  today,
  onCancel,
  busy,
}: {
  commitment: MoneyCommitment;
  today: string;
  onCancel: (c: MoneyCommitment) => void;
  busy: boolean;
}) {
  const outgoing = commitment.amountCents > 0;
  return (
    <div className="hq-arrive flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3.5 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {commitment.label || commitment.category}
        {commitment.vendor ? <span className="ml-1.5 text-mute">{commitment.vendor}</span> : null}
        {commitment.client ? <span className="ml-1.5 text-accent">{commitment.client}</span> : null}
      </span>
      <span className={cx("tabular-nums text-[13px]", outgoing ? "text-ink" : "text-ok")}>
        {fmtCents(Math.abs(commitment.amountCents), commitment.currency)}
      </span>
      <span className="text-[11px] text-mute">{CADENCE_LABEL[commitment.cadence]}</span>
      <span className="tabular-nums text-[11px] text-mute" title="normalised to a month">
        {fmtCents(Math.abs(commitment.monthlyCents), commitment.currency)}/mo
      </span>
      <DueChip commitment={commitment} today={today} />
      <Button
        size="sm"
        disabled={busy}
        title="stop counting this commitment; the record stays on disk"
        onClick={() => onCancel(commitment)}
      >
        stop
      </Button>
    </div>
  );
}

export function Commitments({ money, today, onChanged }: { money: MoneyReport | null; today: string; onChanged: () => void }) {
  const { outgoing, incoming } = splitCommitments(money);
  const run = useOpRunner();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [category, setCategory] = useState<string>("tools");
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>("monthly");
  const [startsOn, setStartsOn] = useState(today.slice(0, 10));
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [client, setClient] = useState("");
  const [vendor, setVendor] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);

  // One key per distinct commitment being described, so a double click is a
  // replay rather than a second subscription.
  const addKey = useOpKey(`${label}|${amount}|${currency}|${category}|${cadence}|${startsOn}|${direction}|${client}|${vendor}|${project}`);
  // The runner does not expose a busy flag, so the card tracks its own: a write
  // is in flight from the click until the promise settles either way.
  const [busy, setBusy] = useState(false);
  const guard = <T,>(p: Promise<T>): Promise<T> => {
    setBusy(true);
    return p.finally(() => setBusy(false));
  };

  async function add() {
    const cents = parseAmount(amount);
    if (cents === null) {
      setError("Enter an amount like 249.99");
      return;
    }
    if (cents < 0) {
      setError("Use the in/out control rather than a minus sign");
      return;
    }
    // Human tags fold into the slugs the server stores: "Orbit Acme" is meant
    // as orbit-acme, not as a validation failure. A field with nothing usable
    // in it is the one case that still has to bounce, and it bounces INLINE:
    // this form once reported refusals only through a toast that no other tab
    // rendered, which read as the button doing nothing.
    const tags: Record<string, string | undefined> = {};
    for (const [field, value] of [["client", client], ["vendor", vendor], ["project", project]] as const) {
      const slug = slugifyTag(value);
      if (slug === "") {
        setError(`${field} needs at least one letter or number`);
        return;
      }
      // Never truncate to fit: two long distinct names must not merge silently.
      if (slug !== null && slug.length > 40) {
        setError(`keep ${field} under 40 characters`);
        return;
      }
      tags[field] = slug ?? undefined;
    }
    setError(null);
    // The form asks for a direction in words and applies the sign itself, so
    // nobody has to remember that a positive number means money leaving.
    const signed = direction === "out" ? cents : -cents;
    const result = await run(`commitment ${label || category}`, () =>
      guard(
        api
        .moneyCommitment(addKey.current(), {
          label: label.trim(),
          amountCents: signed,
          currency,
          category,
          cadence,
          startsOn,
          client: tags.client,
          vendor: tags.vendor,
          project: tags.project,
        })
        .then((created) => {
          toastInfo(`${created.label || created.category} added, next due ${created.nextDueOn ?? "never"}`);
          setLabel("");
          setAmount("");
          setClient("");
          setVendor("");
          setProject("");
          addKey.reset();
          setOpen(false);
          onChanged();
          return created;
        }),
      ),
    );
    // The toast reports it too, but the refusal belongs next to the button that
    // was pressed; a server no must never look like nothing happened.
    if (!result.ok && result.error) setError(result.error);
  }

  function cancel(c: MoneyCommitment) {
    void run(`stop ${c.label || c.id}`, () =>
      guard(
        api.moneyCommitmentCancel(`cancel-${c.id}`, c.id).then((r) => {
          toastInfo(`${c.label || "commitment"} stopped`);
          onChanged();
          return r;
        }),
      ),
    );
  }

  const monthlyOut = money?.runRate.map((r) => ({ currency: r.currency, cents: r.outCents })) ?? [];

  return (
    <Card>
      <CardHead
        title="Repeating"
        chip={<Chip tone="mute">{outgoing.length + incoming.length} live</Chip>}
        actions={
          <ButtonRow>
            <Button size="sm" variant={open ? "primary" : "default"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "close" : "add"}
            </Button>
          </ButtonRow>
        }
      />
      {open ? (
        <CardBody className="hq-unfold grid gap-2 border-b border-line">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-mute">
              What is it
              <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Vultr, hqbox VPS" />
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              Amount each time
              <input className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="249.00" inputMode="decimal" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="grid gap-1 text-[11px] text-mute">
              Direction
              <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as "out" | "in")}>
                <option value="out">going out</option>
                <option value="in">coming in</option>
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              Currency
              <select className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value as "MXN" | "USD")}>
                <option>MXN</option>
                <option>USD</option>
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              How often
              <select className={inputClass} value={cadence} onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}>
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              Category
              <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              First payment
              <input className={inputClass} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="grid gap-1 text-[11px] text-mute">
              Client
              <input className={inputClass} value={client} onChange={(e) => setClient(e.target.value)} placeholder="acme" />
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              Vendor
              <input className={inputClass} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="vultr" />
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              Project
              <input className={inputClass} value={project} onChange={(e) => setProject(e.target.value)} placeholder="acme-dashboard" />
            </label>
          </div>
          {error ? <p className="m-0 text-[12px] text-bad">{error}</p> : null}
          <ButtonRow>
            <Button variant="primary" disabled={busy} onClick={() => void add()}>
              Add
            </Button>
          </ButtonRow>
        </CardBody>
      ) : null}

      <CardBody className="px-0 pb-0 pt-0">
        {monthlyOut.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-3.5 py-2 text-[11px] text-mute">
            {(() => {
              // One folded line when a rate exists: committed money is one
              // position, not a row per currency. The per-currency figures move
              // into the title so nothing is lost, only combined.
              const folded = foldedRunRate(money);
              if (folded) {
                const detail = (money?.runRate ?? [])
                  .map((r) => `${r.currency}: ${fmtCents(r.outCents, r.currency)} out, ${fmtCents(r.inCents, r.currency)} in`)
                  .join("; ");
                return (
                  <span title={detail}>
                    <span className="tabular-nums text-ink">{fmtCents(folded.outCents, "MXN")}</span> out
                    {folded.inCents > 0 ? (
                      <>
                        , <span className="tabular-nums text-ok">{fmtCents(folded.inCents, "MXN")}</span> in
                      </>
                    ) : null}
                    , net{" "}
                    <span className={folded.netCents >= 0 ? "tabular-nums text-ok" : "tabular-nums text-bad"}>
                      {fmtCents(folded.netCents, "MXN")}
                    </span>
                    <span className="ml-1">per month, committed, folded to MXN</span>
                  </span>
                );
              }
              return (money?.runRate ?? []).map((r) => (
                <span key={r.currency}>
                  {r.currency}: <span className="tabular-nums text-ink">{fmtCents(r.outCents, r.currency)}</span> out
                  {r.inCents > 0 ? (
                    <>
                      , <span className="tabular-nums text-ok">{fmtCents(r.inCents, r.currency)}</span> in
                    </>
                  ) : null}
                  <span className="ml-1">per month, committed</span>
                </span>
              ));
            })()}
          </div>
        ) : null}

        {outgoing.length === 0 && incoming.length === 0 ? (
          <p className="m-0 px-3.5 py-6 text-center text-[13px] text-mute">
            Nothing repeating yet. Add a subscription, a tool, or a retainer and it will show its next date and its cost
            per month here.
          </p>
        ) : null}

        {outgoing.length > 0 ? (
          <>
            <div className="px-3.5 pt-2.5 text-[10px] uppercase tracking-[0.16em] text-mute">Going out</div>
            {outgoing.map((c) => (
              <Row key={c.id} commitment={c} today={today} onCancel={cancel} busy={busy} />
            ))}
          </>
        ) : null}

        {incoming.length > 0 ? (
          <>
            <div className="px-3.5 pt-2.5 text-[10px] uppercase tracking-[0.16em] text-mute">Coming in</div>
            {incoming.map((c) => (
              <Row key={c.id} commitment={c} today={today} onCancel={cancel} busy={busy} />
            ))}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
