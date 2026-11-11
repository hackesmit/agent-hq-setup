// Route 3 voice-draft banner model (proposal 25, Option A). Pure helpers for the
// Capri draft banner, so the component stays a thin renderer.
//
// The banner NEVER auto-types into the terminal. It shows a spoken task and waits
// for the owner to click Send, which commits it through the normal passkey-attached
// input path exactly as if he typed it, with Capri's state in view. That human
// click is the safety property (cross-vendor review established that raw auto
// injection cannot be made safe from outside Claude).
//
// Drafts are a FIFO queue, not a single slot: two tasks spoken in quick
// succession both wait their turn (oldest shown first) rather than the second
// silently replacing the first.

export interface Draft {
  id: string;
  text: string;
}

/** Append an incoming draft to the queue, de-duped by id and ignoring empties. */
export function addDraft(queue: Draft[], incoming: Draft): Draft[] {
  const text = String(incoming?.text || "").trim();
  const id = String(incoming?.id || "");
  if (!text || !id) return queue;
  if (queue.some((d) => d.id === id)) return queue;
  return [...queue, { id, text }];
}

/** The draft currently shown (oldest first), or null when the queue is empty. */
export function headDraft(queue: Draft[]): Draft | null {
  return queue.length ? queue[0] : null;
}

/** Remove a draft by id (on Send or Dismiss). */
export function removeDraft(queue: Draft[], id: string): Draft[] {
  return queue.filter((d) => d.id !== id);
}

/** What Send commits: the text plus a submit newline. Only ever from a click. */
export function submitBytes(draft: Draft): string {
  return draft.text + "\r";
}

/** A short label, truncated so a long dictation stays one line. */
export function draftLabel(draft: Draft, max = 120): string {
  const t = draft.text;
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
