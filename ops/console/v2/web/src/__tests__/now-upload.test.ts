// The upload queue's state machine (bead hq-prru).
//
// What matters here is the retry contract: a retryable failure goes back to queued with
// the SAME id and the hash it already computed, and a 410 (the bytes were deleted or
// expired on hqbox) is never retryable with that id, because the id would answer "gone"
// forever. Also pinned: the two-slot concurrency limit and the status mapping.

import { describe, expect, it } from "vitest";
import {
  activeCount,
  itemProgress,
  MAX_CONCURRENT,
  MAX_FILE_BYTES,
  mapUploadError,
  newItem,
  nextToStart,
  rejectReason,
  summarise,
  uploadReduce,
  type UploadItem,
} from "../now/uploadMachine";

function queue(...names: string[]): UploadItem[] {
  return names.reduce<UploadItem[]>(
    (items, name, index) =>
      uploadReduce(items, { t: "queue", id: `id-${name}`, name, size: 1000 + index, at: 1000 }),
    [],
  );
}

function find(items: UploadItem[], id: string): UploadItem {
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
}

describe("uploadReduce", () => {
  it("walks one file from queued to done", () => {
    let items = queue("a.png");
    expect(find(items, "id-a.png").phase).toBe("queued");

    items = uploadReduce(items, { t: "hash.start", id: "id-a.png" });
    items = uploadReduce(items, { t: "hash.progress", id: "id-a.png", bytes: 500 });
    expect(find(items, "id-a.png")).toMatchObject({ phase: "hashing", hashedBytes: 500 });

    items = uploadReduce(items, { t: "hash.done", id: "id-a.png", sha256: "abc" });
    items = uploadReduce(items, { t: "send.start", id: "id-a.png" });
    items = uploadReduce(items, { t: "send.progress", id: "id-a.png", bytes: 400 });
    expect(find(items, "id-a.png")).toMatchObject({ phase: "uploading", sentBytes: 400, attempts: 1 });

    items = uploadReduce(items, { t: "done", id: "id-a.png", path: "/var/x/a.png", duplicate: false });
    expect(find(items, "id-a.png")).toMatchObject({ phase: "done", path: "/var/x/a.png", sentBytes: 1000 });
  });

  it("never queues the same id twice", () => {
    let items = queue("a");
    items = uploadReduce(items, { t: "queue", id: "id-a", name: "a", size: 5, at: 2000 });
    expect(items).toHaveLength(1);
  });

  it("keeps the id and the hash across a retry, and counts attempts", () => {
    let items = queue("a");
    items = uploadReduce(items, { t: "hash.done", id: "id-a", sha256: "deadbeef" });
    items = uploadReduce(items, { t: "send.start", id: "id-a" });
    items = uploadReduce(items, { t: "fail", id: "id-a", error: "network dropped", retryable: true, gone: false });
    expect(find(items, "id-a")).toMatchObject({ phase: "error", retryable: true, sha256: "deadbeef" });

    items = uploadReduce(items, { t: "retry", id: "id-a" });
    const retried = find(items, "id-a");
    expect(retried.phase).toBe("queued");
    expect(retried.id).toBe("id-a");
    expect(retried.sha256).toBe("deadbeef");
    expect(retried.error).toBeNull();

    items = uploadReduce(items, { t: "send.start", id: "id-a" });
    expect(find(items, "id-a").attempts).toBe(2);
  });

  it("refuses to retry a gone upload", () => {
    let items = queue("a");
    items = uploadReduce(items, { t: "fail", id: "id-a", error: "gone", retryable: true, gone: true });
    expect(find(items, "id-a")).toMatchObject({ retryable: false, gone: true });
    items = uploadReduce(items, { t: "retry", id: "id-a" });
    expect(find(items, "id-a").phase).toBe("error");
  });

  it("ignores progress for a row that is not in that stage", () => {
    let items = queue("a");
    items = uploadReduce(items, { t: "send.progress", id: "id-a", bytes: 900 });
    expect(find(items, "id-a").sentBytes).toBe(0);
  });

  it("clamps progress to the file size", () => {
    let items = queue("a");
    items = uploadReduce(items, { t: "hash.start", id: "id-a" });
    items = uploadReduce(items, { t: "hash.progress", id: "id-a", bytes: 999_999 });
    expect(find(items, "id-a").hashedBytes).toBe(1000);
  });

  it("removes one row and clears the finished ones", () => {
    let items = queue("a", "b", "c");
    items = uploadReduce(items, { t: "done", id: "id-b", path: "/x/b", duplicate: true });
    items = uploadReduce(items, { t: "remove", id: "id-a" });
    expect(items.map((item) => item.id)).toEqual(["id-b", "id-c"]);
    items = uploadReduce(items, { t: "clear-done" });
    expect(items.map((item) => item.id)).toEqual(["id-c"]);
  });

  it("ignores events for unknown ids without throwing", () => {
    const items = uploadReduce(queue("a"), { t: "done", id: "nope", path: "/x", duplicate: false });
    expect(items).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("starts at most two rows at a time", () => {
    let items = queue("a", "b", "c", "d");
    const first = nextToStart(items);
    expect(first.map((item) => item.id)).toEqual(["id-a", "id-b"]);

    for (const item of first) items = uploadReduce(items, { t: "hash.start", id: item.id });
    expect(activeCount(items)).toBe(MAX_CONCURRENT);
    expect(nextToStart(items)).toEqual([]);

    items = uploadReduce(items, { t: "done", id: "id-a", path: "/x/a", duplicate: false });
    expect(nextToStart(items).map((item) => item.id)).toEqual(["id-c"]);
  });

  it("summarises what is in flight, done and failed", () => {
    let items = queue("a", "b", "c");
    items = uploadReduce(items, { t: "done", id: "id-a", path: "/x/a", duplicate: false });
    items = uploadReduce(items, { t: "fail", id: "id-b", error: "boom", retryable: true, gone: false });
    expect(summarise(items)).toEqual({ active: 1, done: 1, failed: 1 });
  });
});

describe("itemProgress", () => {
  it("splits the bar between hashing and sending", () => {
    const item = newItem("id", "a", 1000, 0);
    expect(itemProgress({ ...item, phase: "queued" })).toBe(0);
    expect(itemProgress({ ...item, phase: "hashing", hashedBytes: 500 })).toBeCloseTo(0.25, 5);
    expect(itemProgress({ ...item, phase: "hashing", hashedBytes: 1000 })).toBeCloseTo(0.5, 5);
    expect(itemProgress({ ...item, phase: "uploading", hashedBytes: 1000, sentBytes: 500 })).toBeCloseTo(0.75, 5);
    expect(itemProgress({ ...item, phase: "done" })).toBe(1);
  });
});

describe("mapUploadError", () => {
  it("maps the contract's statuses onto retryability", () => {
    expect(mapUploadError(409)).toMatchObject({ retryable: true, gone: false });
    expect(mapUploadError(410)).toMatchObject({ retryable: false, gone: true });
    expect(mapUploadError(413)).toMatchObject({ retryable: false, gone: false });
    expect(mapUploadError(507)).toMatchObject({ retryable: true, gone: false });
    expect(mapUploadError(0)).toMatchObject({ retryable: true, gone: false });
    expect(mapUploadError(503)).toMatchObject({ retryable: true, gone: false });
    expect(mapUploadError(400)).toMatchObject({ retryable: false, gone: false });
  });

  it("explains 413 and 507 in terms of the actual limits", () => {
    expect(mapUploadError(413).error).toMatch(/200 MB/);
    expect(mapUploadError(507).error).toMatch(/quota|free-space/);
  });

  it("appends the server's own detail when there is one", () => {
    expect(mapUploadError(409, "id in progress").error).toMatch(/id in progress/);
  });
});

describe("rejectReason", () => {
  it("refuses a file over the per-file limit before anything is hashed", () => {
    expect(rejectReason({ name: "big.iso", size: MAX_FILE_BYTES + 1 })).toMatch(/200 MB/);
    expect(rejectReason({ name: "empty.txt", size: 0 })).toMatch(/empty/);
    expect(rejectReason({ name: "fine.png", size: 1024 })).toBeNull();
  });
});
