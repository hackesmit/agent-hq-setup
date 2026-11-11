// The upload queue as a hook: the pure reducer in uploadMachine.ts plus the two side
// effects it drives (hash the file, send the file).
//
// Concurrency is capped at two streaming uploads, matching the server's admission rule, so
// the browser does not queue up work the server will only reject. A retry reuses the same
// upload id and the hash already computed: that is the whole point of the idempotency key,
// and it means a retry after a lost response costs nothing on the server.

import { useCallback, useEffect, useReducer, useRef } from "react";
import { hashFile } from "./sha256";
import { toastError } from "./toast";
import { newUploadId, uploadFile, UploadError } from "./uploadApi";
import {
  MAX_PER_DROP,
  nextToStart,
  rejectReason,
  uploadReduce,
  type UploadEvent,
  type UploadItem,
} from "./uploadMachine";

export interface UploadQueue {
  items: UploadItem[];
  add: (files: readonly File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clearDone: () => void;
}

export function useUploadQueue(onCommitted?: (id: string) => void): UploadQueue {
  const [items, dispatch] = useReducer(
    (state: UploadItem[], event: UploadEvent) => uploadReduce(state, event),
    [] as UploadItem[],
  );
  const files = useRef(new Map<string, File>());
  const running = useRef(new Set<string>());
  const committed = useRef(onCommitted);
  committed.current = onCommitted;

  const start = useCallback(async (item: UploadItem): Promise<void> => {
    const file = files.current.get(item.id);
    if (!file) {
      dispatch({
        t: "fail",
        id: item.id,
        error: "the browser no longer has this file; pick it again",
        retryable: false,
        gone: false,
      });
      running.current.delete(item.id);
      return;
    }
    try {
      let sha = item.sha256;
      if (!sha) {
        dispatch({ t: "hash.start", id: item.id });
        const hashed = await hashFile(file, (bytes) => dispatch({ t: "hash.progress", id: item.id, bytes }));
        sha = hashed.hex;
        dispatch({ t: "hash.done", id: item.id, sha256: sha });
      }
      dispatch({ t: "send.start", id: item.id });
      const result = await uploadFile(file, item.id, sha, {
        onProgress: (bytes) => dispatch({ t: "send.progress", id: item.id, bytes }),
      });
      dispatch({
        t: "done",
        id: item.id,
        path: result.path,
        duplicate: Boolean(result.duplicateOf),
      });
      committed.current?.(item.id);
    } catch (err) {
      const failure =
        err instanceof UploadError
          ? err.failure
          : {
              error: err instanceof Error ? err.message : "upload failed",
              retryable: true,
              gone: false,
            };
      dispatch({ t: "fail", id: item.id, ...failure });
      toastError(`${item.name}: ${failure.error}`);
    } finally {
      running.current.delete(item.id);
    }
  }, []);

  useEffect(() => {
    for (const item of nextToStart(items)) {
      if (running.current.has(item.id)) continue;
      running.current.add(item.id);
      void start(item);
    }
  }, [items, start]);

  const add = useCallback((incoming: readonly File[]): void => {
    const list = [...incoming];
    if (list.length === 0) return;
    if (list.length > MAX_PER_DROP) {
      toastError(`At most ${MAX_PER_DROP} files per drop; the rest were ignored.`);
    }
    for (const file of list.slice(0, MAX_PER_DROP)) {
      const reason = rejectReason(file);
      if (reason) {
        toastError(reason);
        continue;
      }
      const id = newUploadId();
      files.current.set(id, file);
      dispatch({ t: "queue", id, name: file.name, size: file.size, at: Date.now() });
    }
  }, []);

  const retry = useCallback((id: string): void => {
    dispatch({ t: "retry", id });
  }, []);

  const remove = useCallback((id: string): void => {
    files.current.delete(id);
    dispatch({ t: "remove", id });
  }, []);

  const clearDone = useCallback((): void => {
    dispatch({ t: "clear-done" });
  }, []);

  return { items, add, retry, remove, clearDone };
}
