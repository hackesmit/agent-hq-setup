// File drop (design doc section 6). Pick or drag files, watch each one hash and stream,
// and get the path on hqbox that a worker can read.
//
// Every row is one request with one client-generated id: hashing happens in the browser
// over file.stream() before a byte is sent, so the server can reject a lie about the
// content and a retry after a lost response is a no-op instead of a duplicate file.

import { useCallback, useEffect, useRef, useState } from "react";
import type { UploadEntry } from "@shared/api";
import { api } from "../data/client";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip, cx, ProgressBar } from "../ui/primitives";
import { copyText } from "./clipboard";
import { deleteUpload, keepUpload } from "./http";
import { toastError, toastInfo } from "./toast";
import { fmtBytes, todayStamp } from "./uploadApi";
import { itemProgress, summarise, type UploadItem } from "./uploadMachine";
import type { UploadQueue } from "./uploadQueue";
import { TOUCH_SM } from "./ui";

function phaseText(item: UploadItem): string {
  switch (item.phase) {
    case "queued":
      return "waiting for a slot";
    case "hashing":
      return `hashing ${Math.round((item.hashedBytes / Math.max(1, item.size)) * 100)}%`;
    case "uploading":
      return `sending ${Math.round((item.sentBytes / Math.max(1, item.size)) * 100)}%`;
    case "done":
      return item.duplicate ? "already on hqbox" : "on hqbox";
    case "error":
      return "failed";
    default:
      return item.phase;
  }
}

function QueueRow({ item, queue }: { item: UploadItem; queue: UploadQueue }) {
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-[12px] last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-ink" title={item.name}>
        {item.name}
      </span>
      <span className="text-mute">{fmtBytes(item.size)}</span>
      <span className={cx("text-mute", item.phase === "error" && "text-bad")}>{phaseText(item)}</span>
      {item.phase !== "error" ? <ProgressBar value={itemProgress(item)} width={90} /> : null}
      {item.path ? (
        <Button size="sm" className={TOUCH_SM} onClick={() => void copyText(item.path ?? "")}>
          Copy path
        </Button>
      ) : null}
      {item.phase === "error" && item.retryable ? (
        <Button size="sm" className={TOUCH_SM} onClick={() => queue.retry(item.id)}>
          Retry
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => queue.remove(item.id)}>
        remove
      </Button>
      {item.error ? (
        <span role="alert" className="basis-full text-[11px] text-bad">
          {item.error}
        </span>
      ) : null}
    </li>
  );
}

export function Uploads({ queue }: { queue: UploadQueue }) {
  const picker = useRef<HTMLInputElement | null>(null);
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const counts = summarise(queue.items);

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.uploads(todayStamp());
      setEntries(Array.isArray(rows) ? rows : []);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "could not read today's uploads");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh the list whenever the queue commits something.
  const doneCount = counts.done;
  useEffect(() => {
    if (doneCount > 0) void load();
  }, [doneCount, load]);

  return (
    <Card>
      <CardHead
        title="Files in"
        chip={<Chip tone="mute">{entries.length} today</Chip>}
        actions={
          <ButtonRow>
            <Button size="sm" className={TOUCH_SM} onClick={() => picker.current?.click()}>
              Upload files
            </Button>
            {counts.done > 0 ? (
              <Button size="sm" variant="ghost" onClick={queue.clearDone}>
                clear finished
              </Button>
            ) : null}
          </ButtonRow>
        }
      />
      <CardBody>
        <input
          ref={picker}
          type="file"
          multiple
          className="sr-only"
          aria-label="Files to upload"
          onChange={(event) => {
            const list = event.target.files;
            if (list) queue.add([...list]);
            event.target.value = "";
          }}
        />

        <div
          className={cx(
            "rounded-sub border border-dashed px-3 py-4 text-center text-[12px]",
            dragging ? "border-accent bg-panel2/60 text-ink" : "border-line text-mute",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer?.files;
            if (dropped && dropped.length > 0) queue.add([...dropped]);
          }}
        >
          Drop files here, or anywhere on this tab. They land in ~/hq/inbox/files on hqbox, readable by workers.
        </div>

        {queue.items.length > 0 ? (
          <ul className="m-0 mt-2 list-none p-0">
            {queue.items.map((item) => (
              <QueueRow key={item.id} item={item} queue={queue} />
            ))}
          </ul>
        ) : null}

        <div className="mt-3 border-t border-line pt-2">
          <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">today</p>
          {listError ? (
            <p className="m-0 text-[12px] text-mute">uploads list unavailable: {listError}</p>
          ) : entries.length === 0 ? (
            <p className="m-0 text-[12px] text-mute">Nothing uploaded today.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-[12px] last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-ink" title={entry.path}>
                    {entry.name}
                  </span>
                  <span className="text-mute">{fmtBytes(entry.size)}</span>
                  {entry.keep ? <Chip tone="ok">kept</Chip> : null}
                  <Button
                    size="sm"
                    className={TOUCH_SM}
                    onClick={async () => {
                      const ok = await copyText(entry.path);
                      if (ok) toastInfo(`copied ${entry.path}`);
                      else toastError("could not copy the path");
                    }}
                  >
                    Copy path
                  </Button>
                  <Button
                    size="sm"
                    className={TOUCH_SM}
                    title={entry.keep ? "Let the 30-day sweep take it" : "Pin it against the 30-day sweep"}
                    onClick={async () => {
                      try {
                        const updated = await keepUpload(entry.id, !entry.keep);
                        setEntries((current) =>
                          current.map((row) => (row.id === entry.id ? { ...row, ...updated } : row)),
                        );
                      } catch (err) {
                        toastError(err instanceof Error ? err.message : "keep failed");
                      }
                    }}
                  >
                    {entry.keep ? "Unkeep" : "Keep"}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className={TOUCH_SM}
                    onClick={async () => {
                      if (!window.confirm(`Delete ${entry.name} from the hqbox inbox?`)) return;
                      try {
                        await deleteUpload(entry.id);
                        setEntries((current) => current.filter((row) => row.id !== entry.id));
                      } catch (err) {
                        toastError(err instanceof Error ? err.message : "delete failed");
                      }
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
