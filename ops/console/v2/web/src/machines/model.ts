// Machines tab model (bead hq-7icm): pure tone/label helpers for services,
// jobs and the mail automation, kept out of the component for testability.

import { useRef } from "react";
import type { JobRow, ServiceRow } from "@shared/api";

export type Tone = "ok" | "bad" | "warn" | "off";

export function serviceTone(row: ServiceRow): Tone {
  if (row.state === "active" || row.state === "running") return "ok";
  if (row.state === "failed" || row.state === "unavailable") return "bad";
  if (row.state === "inactive" || row.state === "exited") return "off";
  return "warn";
}

export function jobTone(row: JobRow): Tone {
  if (row.state === "ok") return "ok";
  if (row.state === "stale" || row.state === "missing") return "bad";
  return "warn"; // malformed | future
}

export function jobDetail(row: JobRow): string {
  const cadence =
    row.cadenceS >= 3600 ? `${Math.round(row.cadenceS / 3600)}h` : `${Math.round(row.cadenceS / 60) || 1}m`;
  const bits = [`every ${cadence}`];
  if (row.state !== "ok") bits.push(row.state);
  if (row.detail) bits.push(row.detail);
  return bits.join(", ");
}

/** One fresh idempotency key. */
export function opKey(): string {
  try {
    return `op-${crypto.randomUUID()}`;
  } catch {
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * A per-INTENT idempotency key that survives retries of the SAME payload but
 * regenerates when the payload changes (lucy fix-verify: a key retained per
 * mounted component reuses the $1 key for a corrected $2 submission, so the
 * server replays the $1 op while the UI reports $2). The fingerprint is the
 * canonical payload; current() mints a new key whenever it changes, and
 * reset() forces a fresh key after a definitive result.
 */
export function useOpKey(fingerprint: string): { current: () => string; reset: () => void } {
  const ref = useRef<{ key: string; fp: string } | null>(null);
  return {
    current: () => {
      if (!ref.current || ref.current.fp !== fingerprint) ref.current = { key: opKey(), fp: fingerprint };
      return ref.current.key;
    },
    reset: () => {
      ref.current = null;
    },
  };
}
