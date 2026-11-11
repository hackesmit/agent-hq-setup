// hq-hsl2.3 lucy round 2, item 4: a timestamp no Date can hold must not break the tab.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErrorsReport, Incident } from "@shared/api";
import { ErrorsTab, ago, dateOf } from "../tabs/ErrorsTab";

function incident(over: Partial<Incident>): Incident {
  return {
    id: "i-1", fp: "fp", project: "hq", title: "t", host: "hqbox", openedTs: 1e300, updatedTs: null,
    status: "fixing", rawStatus: null, repeats: 0, lastRepeatTs: Number.NaN, mid: null, body: null,
    fixer: { tmuxTarget: "hq-errors:i-1", tmuxSocket: null, promptPath: null, logPath: null, startedTs: 1e300, endedTs: null, rc: null, tmuxWindowId: null },
    result: null, bead: null, note: null, resolvedTs: Infinity,
    mailPending: false, conditionSinceTs: -5, lastSeenTs: 1e300, loopdeadAlertTs: null, policy: null,
    pane: { id: "%3", target: "hq-errors:i-1", socket: null, alive: true, attachable: true, reason: null },
    ...over,
  };
}

describe("ErrorsTab with impossible timestamps", () => {
  it("dateOf and ago refuse values outside the Date range", () => {
    expect(dateOf(1e300)).toBeNull();
    expect(dateOf(Number.NaN)).toBeNull();
    expect(ago(1e300)).toBe("unknown");
    expect(dateOf(1_700_000_000)).not.toBeNull();
  });

  it("renders a fixing incident whose started_ts is 1e300", () => {
    const report: ErrorsReport = {
      generatedAt: "2026-10-19T00:00:00Z", dir: "ok", incidents: [incident({})], malformed: [], omitted: 0,
      counts: { escalated: 0, fixing: 1, watching: 0, fixed: 0, logged: 0, resolved: 0, unknown: 0 },
      volume: { source: "none", since: null, hours: 24, fps: [], error: null },
    };
    const html = renderToStaticMarkup(createElement(ErrorsTab, { errors: report }));
    expect(html).toContain("Fixing now");
    expect(html).toContain("unknown");
  });
});
