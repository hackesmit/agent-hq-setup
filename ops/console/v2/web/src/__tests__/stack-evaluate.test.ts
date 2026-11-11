// The evaluation a stack selection produces. What is under test is that the task
// carries EVIDENCE: an agent handed numbers checks them against the code, and an
// agent handed "evaluate Bash" writes an essay.
import { describe, expect, it } from "vitest";
import type { StackItem } from "@shared/api";
import { evaluationBody, evaluationTitle, evidenceLine } from "../stack/evaluate";

const item = (over: Partial<StackItem> & { name: string }): StackItem => ({
  id: `tool:${over.name}`,
  kind: "tool",
  windows: { "7": { uses: 0, sessions: 0, errors: 0 }, "30": { uses: 0, sessions: 0, errors: 0 }, "90": { uses: 0, sessions: 0, errors: 0 } },
  lastUsed: null,
  unstamped: 0,
  blocks90: 0,
  topBlockReason: null,
  tokens90: 0,
  inventory: true,
  stale: null,
  detail: null,
  acquisitions: [],
  verdictHint: "keep",
  ...over,
} as StackItem);

describe("the evidence line", () => {
  it("carries the numbers rather than the name alone", () => {
    const line = evidenceLine(
      item({
        name: "Bash",
        windows: { "7": { uses: 1, sessions: 1, errors: 0 }, "30": { uses: 412, sessions: 33, errors: 7 }, "90": { uses: 0, sessions: 0, errors: 0 } },
        blocks90: 6,
        topBlockReason: "write containment",
        lastUsed: "2026-08-20T10:00:00Z",
      }),
    );
    expect(line).toContain("412 uses across 33 sessions in 30 days");
    expect(line).toContain("7 errors");
    expect(line).toContain("6 blocks in 90 days");
    expect(line).toContain("write containment");
    expect(line).toContain("last used 2026-08-20");
  });

  it("says never rather than implying zero use is the same as unused today", () => {
    expect(evidenceLine(item({ name: "Unused" }))).toContain("never seen in use");
  });

  it("mentions staleness, which is the case most worth evaluating", () => {
    expect(evidenceLine(item({ name: "Gone", stale: "points nowhere" }))).toContain("stale: points nowhere");
  });
});

describe("the task", () => {
  it("names one, two, or the count", () => {
    expect(evaluationTitle([item({ name: "Bash" })])).toBe("Evaluate how we use Bash");
    expect(evaluationTitle([item({ name: "Bash" }), item({ name: "Read" })])).toBe("Evaluate how we use Bash and Read");
    expect(evaluationTitle([item({ name: "Bash" }), item({ name: "Read" }), item({ name: "Grep" })])).toBe(
      "Evaluate how we use Bash and 2 other capabilities",
    );
  });

  it("separates itself from the keep-or-revert question and demands evidence", () => {
    const body = evaluationBody([item({ name: "Bash" })]);
    expect(body).toContain("USAGE review, not a");
    expect(body).toContain("keep-or-revert");
    expect(body).toContain("Definition of Done");
    // the thing that keeps it honest
    expect(body).toContain("A recommendation with no invocation behind it is not a finding");
    expect(body).toContain("Verification:");
    expect(body).toContain("Rig: hq");
  });

  it("puts every selected capability's evidence in the body", () => {
    const body = evaluationBody([item({ name: "Bash" }), item({ name: "Read" })]);
    expect(body).toContain("- Bash (tool)");
    expect(body).toContain("- Read (tool)");
  });
});
