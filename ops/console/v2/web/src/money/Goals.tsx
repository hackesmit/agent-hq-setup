// Goals: targets the ledger is measured against.
//
// the owner, 2026-10-06: "can you allow me to add goals into the money section?"
// Three kinds, each one sentence: bring in at least X (a month, or every
// month, optionally from one client); keep spending under X; reach a running
// net of X (optionally by a date). The server stores the goal, this card
// computes the progress from the ledger rows the page already has, and each
// goal is a meter (one ratio against a limit) with its figure beside it.
import { useState } from "react";
import type { GoalKind, MoneyGoal, MoneyReport } from "@shared/api";
import { api } from "../data/client";
import { useOpRunner } from "../now/ops";
import { useOpKey } from "../machines/model";
import { toastInfo } from "../now/toast";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip, cx, inputClass } from "../ui/primitives";
import { LEDGER_VISIBLE_CAP, fmtCents, goalProgress, goalSentence, parseAmount, slugifyTag } from "./model";

const TONE_INK: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", mute: "text-mute" };
const TONE_BG: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", mute: "bg-accent" };

const KIND_LABEL: Record<GoalKind, string> = {
  in: "bring in at least",
  out: "keep spending under",
  net: "reach a running net of",
};

function GoalRow({ goal, report, today, onRemove, busy }: { goal: MoneyGoal; report: MoneyReport | null; today: string; onRemove: (g: MoneyGoal) => void; busy: boolean }) {
  const p = goalProgress(report, goal, today);
  const pct = Math.round(Math.min(1, p.ratio) * 100);
  const reading =
    goal.kind === "out"
      ? p.met
        ? `${fmtCents(p.haveCents, goal.currency)} of a ${fmtCents(p.targetCents, goal.currency)} cap`
        : `${fmtCents(p.haveCents, goal.currency)}, over a ${fmtCents(p.targetCents, goal.currency)} cap`
      : `${fmtCents(p.haveCents, goal.currency)} of ${fmtCents(p.targetCents, goal.currency)}`;
  return (
    <div className="hq-arrive border-b border-line px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-semibold text-ink">{goal.label || goalSentence(goal)}</span>
        {goal.label ? <span className="text-[11px] text-mute">{goalSentence(goal)}</span> : null}
        <span className={cx("ml-auto tabular-nums text-[13px]", TONE_INK[p.tone])}>{reading}</span>
        {p.met === true ? <Chip tone="ok">{goal.kind === "out" ? "within cap" : "met"}</Chip> : null}
        {p.met === null ? <Chip tone="warn">unknown</Chip> : null}
        {p.daysLeft !== null ? (
          <Chip tone={p.daysLeft < 0 ? "bad" : "mute"}>{p.daysLeft < 0 ? `${-p.daysLeft}d past` : `${p.daysLeft}d left`}</Chip>
        ) : null}
        <Button size="sm" variant="danger" disabled={busy} onClick={() => onRemove(goal)} title="remove this goal; the record stays on disk">
          remove
        </Button>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-chip" role="img" aria-label={`${pct}% of ${goalSentence(goal)}`}>
        <div className={cx("h-full rounded-full", TONE_BG[p.tone])} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-mute">
        <span>{p.scope}</span>
        <span className="ml-auto tabular-nums">{Math.round(p.ratio * 100)}%</span>
        {p.uncounted > 0 ? (
          <span className="text-warn">
            {p.uncounted} row{p.uncounted === 1 ? "" : "s"} in the other currency not counted: no rate
          </span>
        ) : null}
        {p.partial ? <span className="text-warn">only the newest {LEDGER_VISIBLE_CAP} rows are in view, so older months may be short</span> : null}
      </div>
    </div>
  );
}

export function Goals({ money, today, onChanged }: { money: MoneyReport | null; today: string; onChanged: () => void }) {
  const goals = money?.goals ?? [];
  const run = useOpRunner();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<GoalKind>("in");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [when, setWhen] = useState<"every" | "this" | "month">("every");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [by, setBy] = useState("");
  const [client, setClient] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addKey = useOpKey(`goal|${label}|${kind}|${amount}|${currency}|${when}|${month}|${by}|${client}`);
  const guard = <T,>(p: Promise<T>): Promise<T> => {
    setBusy(true);
    return p.finally(() => setBusy(false));
  };

  async function add() {
    const cents = parseAmount(amount);
    if (cents === null || cents < 0) {
      setError("Enter a target like 60000 or 1500.50");
      return;
    }
    const slug = slugifyTag(client);
    if (slug === "") {
      setError("client needs at least one letter or number");
      return;
    }
    if (slug && slug.length > 40) {
      setError("keep client under 40 characters");
      return;
    }
    setError(null);
    const body = {
      label: label.trim(),
      kind,
      targetCents: cents,
      currency,
      month: kind === "net" ? null : when === "every" ? null : when === "this" ? today.slice(0, 7) : month,
      by: kind === "net" && by ? by : null,
      client: kind === "net" ? null : (slug ?? null),
    };
    const result = await run(`goal ${label || KIND_LABEL[kind]}`, () =>
      guard(
        api.moneyGoal(addKey.current(), body).then((created) => {
          toastInfo(`goal set: ${goalSentence(created)}`);
          setLabel("");
          setAmount("");
          setClient("");
          setBy("");
          addKey.reset();
          setOpen(false);
          onChanged();
          return created;
        }),
      ),
    );
    if (!result.ok && result.error) setError(result.error);
  }

  function remove(g: MoneyGoal) {
    void run(`remove goal ${g.label || g.id}`, () =>
      guard(
        api.moneyGoalDelete(`goal-rm-${g.id}`, g.id).then((r) => {
          toastInfo(`goal removed`);
          onChanged();
          return r;
        }),
      ),
    );
  }

  const met = goals.filter((g) => goalProgress(money, g, today).met === true).length;

  return (
    <Card>
      <CardHead
        title="Goals"
        chip={<Chip tone={goals.length > 0 && met === goals.length ? "ok" : "mute"}>{goals.length === 0 ? "none set" : `${met} of ${goals.length} met`}</Chip>}
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
              Call it (optional)
              <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Cover the month" />
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              What
              <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as GoalKind)}>
                {(Object.keys(KIND_LABEL) as GoalKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="grid gap-1 text-[11px] text-mute">
              Target
              <input className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="60000" inputMode="decimal" />
            </label>
            <label className="grid gap-1 text-[11px] text-mute">
              Currency
              <select className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value as "MXN" | "USD")}>
                <option>MXN</option>
                <option>USD</option>
              </select>
            </label>
            {kind === "net" ? (
              <label className="grid gap-1 text-[11px] text-mute">
                By (optional)
                <input className={inputClass} type="date" value={by} onChange={(e) => setBy(e.target.value)} />
              </label>
            ) : (
              <>
                <label className="grid gap-1 text-[11px] text-mute">
                  When
                  <select className={inputClass} value={when} onChange={(e) => setWhen(e.target.value as "every" | "this" | "month")}>
                    <option value="every">every month</option>
                    <option value="this">this month only</option>
                    <option value="month">a given month</option>
                  </select>
                </label>
                {when === "month" ? (
                  <label className="grid gap-1 text-[11px] text-mute">
                    Month
                    <input className={inputClass} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
                  </label>
                ) : null}
                <label className="grid gap-1 text-[11px] text-mute">
                  Client (optional)
                  <input className={inputClass} value={client} onChange={(e) => setClient(e.target.value)} placeholder="acme" />
                </label>
              </>
            )}
          </div>
          {error ? <p className="m-0 text-[12px] text-bad">{error}</p> : null}
          <ButtonRow>
            <Button variant="primary" disabled={busy} onClick={() => void add()}>
              Set goal
            </Button>
          </ButtonRow>
        </CardBody>
      ) : null}
      <CardBody className="px-0 pb-0 pt-0">
        {goals.length === 0 ? (
          <p className="m-0 px-3.5 py-6 text-center text-[13px] text-mute">
            No goals yet. Set one and this card measures the ledger against it: income for the month, spending held under a
            cap, or a running net to reach.
          </p>
        ) : (
          goals.map((g) => <GoalRow key={g.id} goal={g} report={money} today={today} onRemove={remove} busy={busy} />)
        )}
      </CardBody>
    </Card>
  );
}
