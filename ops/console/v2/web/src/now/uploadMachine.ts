// Upload queue state machine.
//
// One file per request (design doc section 6), so N dropped files are N independent rows
// with N client-generated ids. A row walks queued -> hashing -> uploading -> done, and any
// failure that the server says is worth another attempt keeps the SAME id, because the id
// is the idempotency key: retrying with it is what turns a lost response into a no-op
// instead of a duplicate file.
//
// Kept pure and reducer-shaped so the interesting part (which errors are retryable, what a
// 410 means, how the queue drains) is testable without a browser.

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_PER_DROP = 20;
export const MAX_CONCURRENT = 2;

export type UploadPhase = "queued" | "hashing" | "uploading" | "done" | "error";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  phase: UploadPhase;
  hashedBytes: number;
  sentBytes: number;
  sha256: string | null;
  path: string | null;
  duplicate: boolean;
  error: string | null;
  retryable: boolean;
  /** A gone row can never be retried with the same id: the bytes were deleted or expired. */
  gone: boolean;
  attempts: number;
  startedAt: number;
}

export type UploadEvent =
  | { t: "queue"; id: string; name: string; size: number; at: number }
  | { t: "hash.start"; id: string }
  | { t: "hash.progress"; id: string; bytes: number }
  | { t: "hash.done"; id: string; sha256: string }
  | { t: "send.start"; id: string }
  | { t: "send.progress"; id: string; bytes: number }
  | { t: "done"; id: string; path: string; duplicate: boolean }
  | { t: "fail"; id: string; error: string; retryable: boolean; gone: boolean }
  | { t: "retry"; id: string }
  | { t: "remove"; id: string }
  | { t: "clear-done" };

export interface UploadFailure {
  error: string;
  retryable: boolean;
  gone: boolean;
}

/**
 * Map a server response onto something the owner can act on. The statuses come straight from
 * the contract: 409 id in progress or content mismatch, 410 the bytes are gone, 413 too
 * big, 507 the inbox is out of quota or hqbox is out of disk.
 */
export function mapUploadError(status: number, detail?: string | null): UploadFailure {
  const extra = detail && detail.trim() ? `: ${detail.trim().slice(0, 200)}` : "";
  switch (status) {
    case 0:
      return { error: `network dropped before the upload finished${extra}`, retryable: true, gone: false };
    case 400:
      return { error: `the server rejected the request${extra}`, retryable: false, gone: false };
    case 403:
      return { error: `the console rejected the upload (stale boot key?)${extra}`, retryable: true, gone: false };
    case 409:
      return {
        error: `this upload id is already streaming, or the same id was used for different content${extra}`,
        retryable: true,
        gone: false,
      };
    case 410:
      return {
        error: `this upload was deleted or expired on hqbox; send it again as a new file${extra}`,
        retryable: false,
        gone: true,
      };
    case 413:
      return { error: `larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per-file limit${extra}`, retryable: false, gone: false };
    case 507:
      return {
        error: `hqbox has no room: the inbox quota or the free-space floor would be crossed${extra}`,
        retryable: true,
        gone: false,
      };
    default:
      if (status >= 500) return { error: `server error ${status}${extra}`, retryable: true, gone: false };
      return { error: `upload failed with ${status}${extra}`, retryable: false, gone: false };
  }
}

/** A file the browser refuses to queue at all, with the reason. */
export function rejectReason(file: { name: string; size: number }): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${Math.round(file.size / 1024 / 1024)} MB, over the 200 MB per-file limit`;
  }
  if (file.size === 0) return `${file.name} is empty`;
  return null;
}

export function newItem(id: string, name: string, size: number, at: number): UploadItem {
  return {
    id,
    name,
    size,
    phase: "queued",
    hashedBytes: 0,
    sentBytes: 0,
    sha256: null,
    path: null,
    duplicate: false,
    error: null,
    retryable: false,
    gone: false,
    attempts: 0,
    startedAt: at,
  };
}

function map(items: readonly UploadItem[], id: string, fn: (item: UploadItem) => UploadItem): UploadItem[] {
  let touched = false;
  const next = items.map((item) => {
    if (item.id !== id) return item;
    touched = true;
    return fn(item);
  });
  return touched ? next : [...items];
}

export function uploadReduce(items: readonly UploadItem[], event: UploadEvent): UploadItem[] {
  switch (event.t) {
    case "queue":
      if (items.some((item) => item.id === event.id)) return [...items];
      return [...items, newItem(event.id, event.name, event.size, event.at)];
    case "hash.start":
      return map(items, event.id, (item) => ({ ...item, phase: "hashing", hashedBytes: 0, error: null }));
    case "hash.progress":
      return map(items, event.id, (item) =>
        item.phase === "hashing" ? { ...item, hashedBytes: Math.min(event.bytes, item.size) } : item,
      );
    case "hash.done":
      return map(items, event.id, (item) => ({
        ...item,
        sha256: event.sha256,
        hashedBytes: item.size,
      }));
    case "send.start":
      return map(items, event.id, (item) => ({
        ...item,
        phase: "uploading",
        sentBytes: 0,
        error: null,
        attempts: item.attempts + 1,
      }));
    case "send.progress":
      return map(items, event.id, (item) =>
        item.phase === "uploading" ? { ...item, sentBytes: Math.min(event.bytes, item.size) } : item,
      );
    case "done":
      return map(items, event.id, (item) => ({
        ...item,
        phase: "done",
        path: event.path,
        duplicate: event.duplicate,
        sentBytes: item.size,
        error: null,
        retryable: false,
      }));
    case "fail":
      return map(items, event.id, (item) => ({
        ...item,
        phase: "error",
        error: event.error,
        retryable: event.retryable && !event.gone,
        gone: event.gone,
      }));
    case "retry":
      return map(items, event.id, (item) =>
        item.phase === "error" && item.retryable
          ? { ...item, phase: "queued", error: null, sentBytes: 0, retryable: false }
          : item,
      );
    case "remove":
      return items.filter((item) => item.id !== event.id);
    case "clear-done":
      return items.filter((item) => item.phase !== "done");
    default:
      return [...items];
  }
}

/** Rows that are occupying one of the two streaming slots. */
export function activeCount(items: readonly UploadItem[]): number {
  return items.filter((item) => item.phase === "hashing" || item.phase === "uploading").length;
}

/** The next rows to start, respecting the concurrency limit. */
export function nextToStart(items: readonly UploadItem[], limit: number = MAX_CONCURRENT): UploadItem[] {
  const free = Math.max(0, limit - activeCount(items));
  if (free === 0) return [];
  return items.filter((item) => item.phase === "queued").slice(0, free);
}

/** 0 to 1 across both stages: hashing is the first half, sending the second. */
export function itemProgress(item: UploadItem): number {
  if (item.phase === "done") return 1;
  if (item.size <= 0) return 0;
  const hashed = Math.min(1, item.hashedBytes / item.size);
  const sent = Math.min(1, item.sentBytes / item.size);
  if (item.phase === "queued") return 0;
  if (item.phase === "hashing") return hashed * 0.5;
  return 0.5 + sent * 0.5;
}

export function summarise(items: readonly UploadItem[]): { active: number; done: number; failed: number } {
  return {
    active: activeCount(items) + items.filter((item) => item.phase === "queued").length,
    done: items.filter((item) => item.phase === "done").length,
    failed: items.filter((item) => item.phase === "error").length,
  };
}
