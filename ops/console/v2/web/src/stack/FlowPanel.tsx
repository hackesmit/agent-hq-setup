// Flow: lead time, blocked share and rework per rig (bead hq-3y18). Lives on
// the Stack tab because it is the same idea as the stack table (measure, let a
// human decide) applied to the work instead of the tooling. Read-only: these
// are numbers for the retro, never triggers.

import type { FlowReport } from "@shared/api";
import { Card, CardHead, Sparkline, Table, TableWrap, Td, Th, cx } from "../ui/primitives";
import { flowHint, flowRows, type FlowWindowKey } from "./flow";

export function FlowPanel({ flow, window }: { flow: FlowReport | null; window: FlowWindowKey }) {
  const rows = flowRows(flow, window);
  const hint = flowHint(flow, window);
  return (
    <Card className="mt-4">
      <CardHead
        title="Flow"
        chip={
          <span className="text-[11px] text-faint">
            last {window}d; lead is created to closed; audit beads excluded
          </span>
        }
      />
      {hint ? (
        <p className="m-0 border-b border-line bg-warn/10 px-3.5 py-2 text-[12px] text-warn" role="note">
          {hint}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="m-0 px-3.5 py-3 text-[13px] text-mute">No flow data yet: the collector has not run.</p>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>rig</Th>
                <Th numeric>closed</Th>
                <Th numeric>lead (med)</Th>
                <Th numeric>lead (p90)</Th>
                <Th numeric>blocked</Th>
                <Th numeric>reopened</Th>
                <Th numeric>rework</Th>
                <Th>lead trend, 6w</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rig} className={cx(row.closed === 0 && "opacity-50")}>
                  <Td>
                    <span className="font-medium">{row.rig}</span>
                  </Td>
                  <Td numeric>{row.closed}</Td>
                  <Td numeric>{row.medianLead}</Td>
                  <Td numeric>{row.p90Lead}</Td>
                  <Td numeric>
                    <span className={cx(row.blockedRaw != null && row.blockedRaw >= 0.5 && "text-warn")}>
                      {row.blockedShare}
                    </span>
                  </Td>
                  <Td numeric>{row.reopened}</Td>
                  <Td numeric>{row.reworkShare}</Td>
                  <Td>
                    <div className="w-36">
                      {row.trendWeeks >= 2 ? (
                        <Sparkline points={row.trend} label={`${row.rig} weekly median lead`} height={24} />
                      ) : (
                        <span className="text-[11px] text-faint">not enough weeks</span>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
