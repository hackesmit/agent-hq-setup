// Understudy: the decision model in shadow mode (bead hq-ufx9.4). Lives on the
// Stack tab with Flow because it is the same posture: measure, let a human
// decide. Every number here comes from predictions provably stamped before
// the owner answered; promoting any of it past watching is proposal 26, not a
// button on this card.

import type { UnderstudyReport } from "@shared/api";
import { Card, CardHead, Sparkline, StatTile } from "../ui/primitives";
import { backtestLine, gradedTrend, understudyHint, understudyTiles } from "./understudy";

export function UnderstudyPanel({ understudy }: { understudy: UnderstudyReport | null }) {
  const tiles = understudyTiles(understudy);
  const hint = understudyHint(understudy);
  const trend = gradedTrend(understudy);
  const backtest = backtestLine(understudy);
  return (
    <Card className="mt-4">
      <CardHead
        title="Understudy"
        chip={<span className="text-[11px] text-faint">shadow mode: it predicts, the owner decides; it acts on nothing</span>}
      />
      {tiles.length === 0 ? (
        <p className="m-0 px-3.5 py-3 text-[13px] text-mute">No report yet: the understudy collector has not run on this box.</p>
      ) : (
        <div className="p-3.5">
          {hint ? (
            <p className="m-0 mb-3 text-[12px] text-mute" role="note">
              {hint}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map((t) => (
              <StatTile key={t.label} label={t.label} value={t.value} detail={t.detail} />
            ))}
          </div>
          {trend.length >= 2 ? (
            <div className="mt-3">
              <span className="block text-[11px] uppercase tracking-[0.05em] text-mute">graded predictions over time</span>
              <Sparkline points={trend} label="graded predictions over time" height={28} />
            </div>
          ) : null}
          {backtest ? <p className="m-0 mt-3 text-[11px] text-faint">{backtest}</p> : null}
        </div>
      )}
    </Card>
  );
}
