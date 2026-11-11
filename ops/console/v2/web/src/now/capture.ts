// Reading the new bead's id out of what `bd create` printed.
//
// The capture endpoint answers with an Op whose output is the CLI's own stdout tail, so
// the id is recovered from the text rather than invented client-side: if the parse fails
// the UI says "created" without a number instead of showing one that might be wrong.

const BEAD_ID = /\b([a-z]{2,4}-[a-z0-9]{2,10})\b/i;

export function parseBeadId(output: string | null | undefined): string | null {
  if (!output) return null;
  // Prefer an explicit "created xd-212" line when the CLI printed one.
  const created = /created[:\s]+([a-z]{2,4}-[a-z0-9]{2,10})/i.exec(output);
  if (created) return created[1]!.toLowerCase();
  const any = BEAD_ID.exec(output);
  return any ? any[1]!.toLowerCase() : null;
}
