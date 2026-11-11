// The work strip on the Terminals page (the owner, 2026-10-20: "see my usage in all the
// windows, 5h, week, etc. ... If this is the general work page then I need to see all
// the relevant work metrics"). Every plan window /usage shows, then what the terminals
// and the request board are doing right now.

import type { ConsoleState, PlanLimit, Session } from "@shared/api";
import { Card, CardBody, cx } from "../ui/primitives";
import { fmtCount, fmtDuration, pct } from "../ui/format";
import { attentionOf, needsYou, useTermSeen } from "./attention";

/** Older than this, the plan numbers are shown as stale: the timer runs every 2 min. */
export const PLAN_STALE_MS = 10 * 60 * 1000;

export function resetsIn(iso: string | null, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  if (at <= now) return "resets now";
  return `resets in ${fmtDuration((at - now) / 1000)}`;
}

/** ok under 70, warn to 90, bad above, or whatever the endpoint itself flags. */
export function limitTone(limit: PlanLimit): "ok" | "warn" | "bad" {
  const value = limit.percent ?? 0;
  if (value >= 90 || /critical|exceeded|blocked/i.test(limit.severity)) return "bad";
  if (value >= 70 || /warn/i.test(limit.severity)) return "warn";
  return "ok";
}

export function planStale(updatedAt: string | null, error: string | null, now: number): string | null {
  if (error) return `last read failed (${error}); showing the last good numbers`;
  if (!updatedAt) return "no plan reading yet";
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return "no plan reading yet";
  if (now - at > PLAN_STALE_MS) return `numbers are ${fmtDuration((now - at) / 1000)} old`;
  return null;
}

export function terminalCounts(sessions: Session[], seen: Record<string, string>, now: number) {
  const counts = { needsYou: 0, working: 0, idle: 0 };
  for (const session of sessions) {
    const attention = attentionOf(session, seen[session.id] ?? null, now);
    if (!attention) continue;
    if (needsYou(attention)) counts.needsYou += 1;
    else if (attention === "working") counts.working += 1;
    else counts.idle += 1;
  }
  return counts;
}

const BAR: Record<"ok" | "warn" | "bad", string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };

function Meter({ limit, now }: { limit: PlanLimit; now: number }) {
  const tone = limitTone(limit);
  const value = limit.percent;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className={cx("text-ink", limit.active ? "font-semibold" : "")}>{limit.label}</span>
        <span className={cx("ml-auto font-mono", tone === "ok" ? "text-ink" : tone === "warn" ? "text-warn" : "text-bad")}>
          {value == null ? "-" : pct(value)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel2" role="meter" aria-label={limit.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? 0}>
        <div className={cx("h-full", BAR[tone])} style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-mute">{resetsIn(limit.resetsAt, now)}</div>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: string; tone?: "p1" | "ok" }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-[0.14em] text-mute">{label}</div>
      <div className={cx("font-mono text-[18px]", tone === "p1" ? "text-p1" : tone === "ok" ? "text-ok" : "text-ink")}>{value}</div>
    </div>
  );
}

/** `sessions` is the set the page shows panes for, so the counts match what is on screen. */
export function WorkStrip({ state, sessions, now = Date.now() }: { state: ConsoleState | null; sessions?: Session[]; now?: number }) {
  const seen = useTermSeen();
  const plan = state?.usage?.planUsage ?? null;
  const limits = plan?.limits ?? [];
  const stale = plan ? planStale(plan.updatedAt, plan.error, now) : "no plan reading yet";
  const counts = terminalCounts(sessions ?? state?.sessions ?? [], seen, now);
  const open = (state?.requests ?? []).filter((r) => r.state === "open").length;
  const ready = state?.ready?.length ?? 0;
  const tokens = state?.usage ? fmtCount(state.usage.tokensToday) : "-";

  return (
    <Card className="mb-4">
      <CardBody className="flex flex-col gap-3">
        <div className="grid gap-4 sm:grid-cols-3">
          {limits.length === 0 ? (
            <p className="m-0 text-[13px] text-mute sm:col-span-3">No plan windows yet. The plan-usage timer fills them every 2 minutes.</p>
          ) : (
            limits.map((limit) => <Meter key={`${limit.kind}:${limit.label}`} limit={limit} now={now} />)
          )}
        </div>
        {stale ? <p className="m-0 text-[11px] text-warn">Plan usage: {stale}.</p> : null}
        <div className="grid grid-cols-3 gap-4 border-t border-line pt-3 sm:grid-cols-6">
          <Count label="Needs you" value={String(counts.needsYou)} tone={counts.needsYou > 0 ? "p1" : undefined} />
          <Count label="Working" value={String(counts.working)} tone={counts.working > 0 ? "ok" : undefined} />
          <Count label="Idle" value={String(counts.idle)} />
          <Count label="Questions" value={String(open)} tone={open > 0 ? "p1" : undefined} />
          <Count label="Ready beads" value={String(ready)} />
          <Count label="Tokens today" value={tokens} />
        </div>
      </CardBody>
    </Card>
  );
}
