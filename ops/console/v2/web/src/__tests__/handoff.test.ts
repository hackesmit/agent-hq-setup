// Turning a finish refusal into a route forward. The gate itself is invariant 6
// and is not weakened here; what these cover is that a refusal names the thing
// that would satisfy it, which is what was missing when the owner pressed Finish and
// got "no approval marker" with the button locked and only Cancel left.
import { describe, expect, it } from "vitest";
import { APPROVAL_LIFE_MS, adviseOn, approvalIsFresh, finishBody, mayConfirmFinish, readGate } from "../now/handoff";

describe("a refusal that names the way out", () => {
  const block = (line: string) => ({ verdict: "block" as const, line });

  it("distinguishes the three things that actually block a finish", () => {
    expect(adviseOn(block("no approval marker"))?.blocker).toBe("unreviewed");
    expect(adviseOn(block("uncommitted changes in worktree (not reviewed)"))?.blocker).toBe("dirty");
    expect(adviseOn(block("approval sha abc123def456 != head 789abc012def"))?.blocker).toBe("stale-approval");
  });

  it("always says what would satisfy the gate, not just what failed", () => {
    for (const line of ["no approval marker", "uncommitted changes in worktree", "approval sha a != head b", "something new"]) {
      const advice = adviseOn(block(line));
      expect(advice).not.toBe(null);
      expect(advice!.next.length).toBeGreaterThan(10);
      expect(advice!.says.length).toBeGreaterThan(10);
    }
  });

  it("says nothing when the gate did not refuse", () => {
    expect(adviseOn({ verdict: "pass", line: "approved" })).toBe(null);
    expect(adviseOn({ verdict: "checking", line: "checking" })).toBe(null);
    expect(adviseOn({ verdict: "unknown", line: "no check has run yet" })).toBe(null);
  });
});

describe("finish approvals", () => {
  const pass = readGate("gate passed, nothing to report");
  const blocked = readGate("BLOCKED: the bead has no Verification receipt");
  const NOW = 1_700_000_000_000;
  const approval = { seal: "s1.123.abc", op: "op-1", issuedAt: NOW };

  it("needs BOTH a gate pass and a held approval", () => {
    expect(mayConfirmFinish(pass, approval, NOW)).toBe(true);
    // A pass with nothing held: the operator is reading something the server will not
    // accept a confirmation for, so offering the button would only produce a failed click.
    expect(mayConfirmFinish(pass, null, NOW)).toBe(false);
    // An approval cannot rescue a gate that did not pass.
    expect(mayConfirmFinish(blocked, approval, NOW)).toBe(false);
    expect(mayConfirmFinish(blocked, null, NOW)).toBe(false);
  });

  it("stops offering the click once the approval is too old to be accepted", () => {
    // The button used to stay enabled past the server's window, so the only way to
    // learn the approval had expired was to click and be refused.
    expect(mayConfirmFinish(pass, approval, NOW + APPROVAL_LIFE_MS - 1000)).toBe(true);
    expect(mayConfirmFinish(pass, approval, NOW + APPROVAL_LIFE_MS)).toBe(false);
    expect(approvalIsFresh(approval, NOW + APPROVAL_LIFE_MS + 60_000)).toBe(false);
    // A clock that jumped backwards must not resurrect one either.
    expect(approvalIsFresh(approval, NOW - 1000)).toBe(false);
  });

  it("sends the approval alongside the confirmation, never confirm alone", () => {
    const body = finishBody(approval);
    expect(body).toEqual({ confirm: true, seal: "s1.123.abc", approvedOp: "op-1" });
    // The server refuses a confirm with no approval; a body that lost either field would
    // fail at runtime, so both are asserted by name rather than by shape.
    expect(body.seal).toBe(approval.seal);
    expect(body.approvedOp).toBe(approval.op);
  });
});
