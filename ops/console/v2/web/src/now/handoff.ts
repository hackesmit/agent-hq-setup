// The handoff: what a merge would actually do, in a shape a person can decide from.
//
// Merging is the most consequential click in the console and it used to show a raw error
// string. These are the pure parts: reading the gate's own words into a verdict, and
// turning a diffstat into something proportional. Kept out of the component so the
// parsing is testable, because a gate that is misread as passing is the worst bug this
// surface can have.

export interface DiffFile {
  path: string;
  /** null for a binary file, which reports no line counts. */
  added: number | null;
  removed: number | null;
}

export interface Diffstat {
  branch: string;
  base: string;
  files: DiffFile[];
  added: number;
  removed: number;
  truncated?: boolean;
  note?: string;
}

export type Verdict = "checking" | "pass" | "block" | "unknown";

export interface GateReading {
  verdict: Verdict;
  /** One sentence, in the gate's own words where it gave one. */
  line: string;
}

/**
 * What the gate said. Deliberately conservative: anything that is not clearly a pass is
 * NOT reported as one. A false "blocked" costs a second look; a false "passed" merges
 * unreviewed work into main.
 */
export function readGate(gate: string | null): GateReading {
  if (gate === null) return { verdict: "unknown", line: "no check has run yet" };
  const text = gate.trim();
  if (!text) return { verdict: "unknown", line: "the check returned nothing" };
  if (text === "checking...") return { verdict: "checking", line: "checking" };

  // The gate answers in JSON when it has structure to report. Read that rather than
  // showing the operator a blob: {"ok": false, "reason": "..."} is a sentence in disguise.
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { ok?: unknown; reason?: unknown; error?: unknown };
      const reason = typeof j.reason === "string" ? j.reason : typeof j.error === "string" ? j.error : null;
      if (j.ok === true) return { verdict: "pass", line: reason || "the gate passed" };
      if (j.ok === false) return { verdict: "block", line: reason || "the gate refused, with no reason given" };
      if (reason) return { verdict: "unknown", line: reason };
    } catch {
      /* not the JSON we expected; fall through to reading it as prose */
    }
  }

  const lower = text.toLowerCase();
  const blocked = /refus|blocked|missing|no .*receipt|not allowed|conflict|dirty|fail/.test(lower);
  const passed = /gate passed|would merge|ready to finish|approved/.test(lower);

  // A line that says both is a block: the gate is describing what is still wrong.
  if (blocked) {
    const first = text.split("\n").find((l) => l.trim()) ?? text;
    return { verdict: "block", line: first.trim().slice(0, 240) };
  }
  if (passed) return { verdict: "pass", line: text.split("\n")[0].trim().slice(0, 240) };
  return { verdict: "unknown", line: text.split("\n")[0].trim().slice(0, 240) };
}

/** True only for a clear pass. Necessary for Finish, and since approvals, not sufficient. */
export function mayFinish(reading: GateReading): boolean {
  return reading.verdict === "pass";
}

/**
 * The approval a completed finish-check mints, held by the row while its reading is on
 * screen. `op` names the check; `seal` is opaque and only the server can read it.
 */
export interface FinishApproval {
  seal: string;
  op: string;
  /** When the server issued it, epoch ms. Used to stop offering a click it would refuse. */
  issuedAt: number;
}

/**
 * How long the server will honour an approval. Kept a little under the server's own
 * fifteen minutes so the button goes quiet before a click could fail, rather than after.
 */
export const APPROVAL_LIFE_MS = 14 * 60 * 1000;

/** True while the server would still accept this approval. */
export function approvalIsFresh(approval: FinishApproval | null, now: number = Date.now()): boolean {
  if (!approval) return false;
  const age = now - approval.issuedAt;
  return age >= 0 && age < APPROVAL_LIFE_MS;
}

/**
 * Whether Finish may be offered at all.
 *
 * Both halves, always. A gate pass with no approval means the operator is looking at a
 * reading the server will refuse a confirmation for, so offering the button would only
 * produce a click that fails. An approval with no pass is the older rule and still holds.
 */
export function mayConfirmFinish(
  reading: GateReading,
  approval: FinishApproval | null,
  now: number = Date.now(),
): boolean {
  return mayFinish(reading) && approvalIsFresh(approval, now);
}

/**
 * The body of a confirmed finish. It lives here rather than inline in the row so that the
 * shape the server validates is covered by a test rather than by reading JSX.
 */
export function finishBody(approval: FinishApproval): { confirm: true; seal: string; approvedOp: string } {
  // issuedAt is deliberately not sent: the server reads the age out of the seal itself,
  // and a client-supplied timestamp would be one more thing it must not trust.
  return { confirm: true, seal: approval.seal, approvedOp: approval.op };
}

/** Proportional bar widths for one file, capped so one huge file does not flatten the rest. */
export function barWidths(file: DiffFile, biggest: number, max = 90): { add: number; del: number } {
  const scale = biggest > 0 ? max / biggest : 0;
  return {
    add: Math.max(file.added ? 2 : 0, Math.round((file.added ?? 0) * scale)),
    del: Math.max(file.removed ? 2 : 0, Math.round((file.removed ?? 0) * scale)),
  };
}

/** The biggest single-file churn in the set, for scaling the bars. */
export function biggestChurn(files: DiffFile[]): number {
  return files.reduce((max, f) => Math.max(max, (f.added ?? 0) + (f.removed ?? 0)), 0);
}

/** "4 files, +186 -23", or an honest word when there is nothing. */
export function diffSummary(stat: Diffstat | null): string {
  if (!stat) return "";
  if (stat.note) return stat.note;
  if (stat.files.length === 0) return "no changes against the base";
  const n = stat.files.length;
  return `${n} file${n === 1 ? "" : "s"}${stat.truncated ? "+" : ""}, +${stat.added} -${stat.removed}`;
}

/** The review command for this branch, which the console hands over rather than running. */
export function reviewCommand(rig: string | null, base: string, what: string): string {
  const rigPart = rig ? ` --rig ${rig}` : "";
  return `lucy${rigPart} --base ${base} ${JSON.stringify(what)}`;
}

// ---- what to do about a refusal -------------------------------------------

export type GateBlocker = "unreviewed" | "dirty" | "stale-approval" | "other";

export interface GateAdvice {
  blocker: GateBlocker;
  /** What is missing, in words, without the reader knowing the gate's internals. */
  says: string;
  /** The single next thing that would satisfy it. */
  next: string;
}

/**
 * Turn a refusal into a route forward.
 *
 * the owner hit this live: he pressed Finish, got "no approval marker", and the
 * button locked with only Cancel left. He had no way to know whether there was a
 * path forward at all. The gate itself is right and is invariant 6 doing its job,
 * so nothing here weakens it; what was missing is that a refusal named a
 * condition without naming the thing that satisfies it.
 */
export function adviseOn(reading: GateReading): GateAdvice | null {
  if (reading.verdict !== "block") return null;
  const line = reading.line.toLowerCase();

  if (line.includes("uncommitted")) {
    return {
      blocker: "dirty",
      says: "The worktree still has uncommitted changes, so what would merge is not what was reviewed.",
      next: "Open the session and commit, or discard, what is still loose. The work stays on disk either way.",
    };
  }
  if (line.includes("approval sha") || line.includes("!= head")) {
    return {
      blocker: "stale-approval",
      says: "This branch was approved, then moved. The approval names an older commit than the one that would merge.",
      next: "Review the new head and approve that, since the extra commits have not been looked at by anyone.",
    };
  }
  if (line.includes("approval")) {
    return {
      blocker: "unreviewed",
      says: "No reviewer has approved this branch yet, so the merge gate has nothing to check against.",
      next: "Run an adversarial review on the branch. When it approves, the marker lands on the bead and Finish opens.",
    };
  }
  return {
    blocker: "other",
    says: reading.line,
    next: "Open the session and look at the branch; the gate is reporting something this card does not recognise.",
  };
}
