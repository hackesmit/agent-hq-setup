// Turning a stack selection into an evaluation worth dispatching.
//
// the owner: "for any item that we utilize, for example for Bash or Read, it sends
// out a terminal to evaluate how we utilize it and see if we can be doing it
// better."
//
// The distinction that matters: this is NOT the keep-or-revert decision the stack
// already carries. That asks whether a capability should exist. This asks whether
// the way it is being used is any good, which is a different question with a
// different answer, and conflating them would make the existing verdict noisier
// rather than the new question clearer.
//
// The evaluation must read evidence rather than opine, so the bead it produces
// carries the numbers the console already knows: how often the thing is used, over
// how many sessions, how often it blocked, when it was last touched. An agent
// handed those will check them against the code; an agent handed "evaluate Bash"
// will write an essay.

import type { StackItem } from "@shared/api";

/** One line of evidence per item, which is what stops the task being an essay. */
export function evidenceLine(item: StackItem): string {
  const w = item.windows["30"] ?? { uses: 0, sessions: 0, errors: 0 };
  const parts = [`${w.uses} uses across ${w.sessions} sessions in 30 days`];
  if (w.errors > 0) parts.push(`${w.errors} errors`);
  if (item.blocks90 > 0) {
    parts.push(`${item.blocks90} blocks in 90 days${item.topBlockReason ? ` (top: ${item.topBlockReason})` : ""}`);
  }
  if (item.unstamped > 0) parts.push(`${item.unstamped} undated records`);
  parts.push(item.lastUsed ? `last used ${item.lastUsed.slice(0, 10)}` : "never seen in use");
  if (item.stale) parts.push(`stale: ${item.stale}`);
  return `- ${item.name} (${item.kind}): ${parts.join(", ")}`;
}

export function evaluationTitle(items: StackItem[]): string {
  if (items.length === 1) return `Evaluate how we use ${items[0]!.name}`;
  if (items.length === 2) return `Evaluate how we use ${items[0]!.name} and ${items[1]!.name}`;
  return `Evaluate how we use ${items[0]!.name} and ${items.length - 1} other capabilities`;
}

/**
 * The bead body. It states the question, the evidence, and what would count as an
 * answer, because an evaluation with no definition of done produces an opinion.
 */
export function evaluationBody(items: StackItem[]): string {
  return [
    "Rig: hq",
    "Model: claude-opus-5",
    "",
    "Asked for from the console's Stack tab. This is a USAGE review, not a",
    "keep-or-revert decision: the question is whether the way we use these is any",
    "good, not whether they should exist. The stack already carries the second",
    "question separately.",
    "",
    "What the console already knows, which is where to start rather than what to",
    "conclude:",
    ...items.map(evidenceLine),
    "",
    "For each one, read the actual usage in this workspace before saying anything:",
    "where it is invoked, what it is being used INSTEAD of, what the friction notes",
    "and session-eval beads say about it, and whether the invocations cluster around",
    "one pattern that could be a script, a skill, or a hook.",
    "",
    "Definition of Done: one paragraph per capability saying how it is actually",
    "used, one concrete change that would make that better (or an explicit finding",
    "that the current use is right, which is a real answer), and the evidence for",
    "each claim. A recommendation with no invocation behind it is not a finding.",
    "",
    "Verification: docs-only -- diff/readback checked, unless a change ships with it",
  ].join("\n");
}
