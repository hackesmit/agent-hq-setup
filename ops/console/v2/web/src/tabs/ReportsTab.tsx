// The Reports tab (bead hq-o6wn.5): every HQ report (the [HQ-*] mails, stack usage, the
// retro) in one place, readable on the phone. The store is ops/reports/publish.py, the
// API server/src/reports.js. Email delivery is unchanged; this is a second reader.
//
// The list is pulled over REST on open and pulled again whenever the live summary on the
// state slice moves (a new report, or a read on another device). Desktop shows the list
// and the reader side by side; a phone shows one at a time, switched by the route.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportHeader, ReportKind, ReportsSummary } from "@shared/api";
import { toastError, toastInfo } from "../now/toast";
import { Button, PageHeader, cx } from "../ui/primitives";
import { listReports, markAllRead } from "../reports/api";
import { ReportList } from "../reports/ReportList";
import { ReportView } from "../reports/ReportView";
import {
  KIND_LABELS,
  MAX_LIMIT,
  NO_FILTER,
  PAGE_SIZE,
  REPORT_KINDS,
  markReadLocally,
  mergePage,
  passes,
  unreadText,
  type ReportsFilter,
} from "../reports/model";

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "shrink-0 cursor-pointer rounded-sub border px-2 py-1 text-[12px] leading-4",
        active ? "border-accent bg-accent text-accent-ink" : "border-line bg-transparent text-mute hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function ReportsTab({ summary, reportId }: { summary: ReportsSummary | null; reportId: string | null }) {
  const [filter, setFilter] = useState<ReportsFilter>(NO_FILTER);
  const [items, setItems] = useState<ReportHeader[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const shown = useRef(0);
  shown.current = items.length;
  // The server offset for "Show more" is how many loaded rows still pass the filter: a
  // report read here has already left the server's unread list, so counting it would skip
  // one. The generation drops a page that answers after the filter or the first page moved.
  const offset = useRef(0);
  offset.current = items.filter((item) => passes(item, filter)).length;
  const generation = useRef(0);

  // A summary change re-pulls the first page, sized to what is already on screen so a
  // "Show more" is not undone by a report arriving.
  const summaryKey = summary ? `${summary.total}:${summary.unread}:${summary.error ?? ""}` : "none";
  useEffect(() => {
    const controller = new AbortController();
    const gen = ++generation.current;
    setLoading(true);
    listReports(filter, 0, controller.signal, Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, shown.current)))
      .then((page) => {
        if (gen !== generation.current) return;
        setItems(page.items);
        setTotal(page.total);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(String((cause as Error)?.message ?? cause));
        setLoading(false);
      });
    return () => controller.abort();
  }, [filter, summaryKey]);

  const showMore = useCallback(() => {
    const gen = generation.current;
    listReports(filter, offset.current)
      .then((page) => {
        if (gen !== generation.current) return;
        setItems((prev) => mergePage(prev, page.items));
        setTotal(page.total);
      })
      .catch((cause: unknown) => gen === generation.current && toastError(`Could not load more reports: ${String((cause as Error)?.message ?? cause)}`));
  }, [filter]);

  const onRead = useCallback((id: string) => setItems((prev) => markReadLocally(prev, id)), []);

  function pickKind(kind: ReportKind | null): void {
    setConfirmAll(false);
    setFilter((prev) => ({ ...prev, kind: prev.kind === kind ? null : kind }));
  }

  async function readAll(): Promise<void> {
    if (!confirmAll) {
      setConfirmAll(true);
      return;
    }
    setConfirmAll(false);
    try {
      const result = await markAllRead(filter.kind);
      setItems((prev) => prev.map((item) => (filter.kind && item.kind !== filter.kind ? item : { ...item, read: true })));
      toastInfo(`${result.marked} marked read`);
    } catch (cause) {
      toastError(`Could not mark reports read: ${String((cause as Error)?.message ?? cause)}`);
    }
  }

  // In the Unread view a report read here stays listed while it is open, so the list
  // does not jump under the reader; it drops out once something else is open.
  const visible = items.filter((item) => passes(item, filter) || item.id === reportId);
  const counts = unreadText(summary);
  const open = reportId !== null;

  return (
    <div className="-mx-5 -mt-4 lg:mx-0 lg:mt-0">
      <div className={cx("px-5 pt-4 lg:px-0 lg:pt-0", open && "hidden lg:block")}>
        <PageHeader
          title="Reports"
          sub={counts.text}
          actions={
            summary && summary.unread ? (
              <Button size="sm" variant={confirmAll ? "danger" : "default"} onClick={() => void readAll()} onBlur={() => setConfirmAll(false)}>
                {confirmAll ? `Confirm: mark ${filter.kind ? KIND_LABELS[filter.kind].toLowerCase() : "all"} read` : "Mark all read"}
              </Button>
            ) : null
          }
        />
        {counts.unavailable && summary?.error ? (
          <p className="-mt-2 mb-3 text-[12px] text-bad">The report store could not be read: {summary.error}</p>
        ) : null}
        <div className="hq-scroll -mx-5 mb-3 flex gap-1.5 overflow-x-auto px-5 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
          <FilterButton active={filter.unread} onClick={() => setFilter((prev) => ({ ...prev, unread: !prev.unread }))}>
            Unread
          </FilterButton>
          <span aria-hidden className="mx-1 w-px shrink-0 bg-line" />
          <FilterButton active={filter.kind === null} onClick={() => pickKind(null)}>
            All kinds
          </FilterButton>
          {REPORT_KINDS.map((kind) => (
            <FilterButton key={kind} active={filter.kind === kind} onClick={() => pickKind(kind)}>
              {KIND_LABELS[kind]}
            </FilterButton>
          ))}
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] lg:gap-4">
        <div
          className={cx(
            "border-y border-line bg-panel lg:sticky lg:top-[52px] lg:max-h-[calc(100vh-72px)] lg:overflow-y-auto lg:rounded-card lg:border hq-scroll",
            open && "hidden lg:block",
          )}
        >
          {error ? <p className="m-0 px-4 py-3 text-[12px] text-bad">Could not load reports: {error}</p> : null}
          {!error && loading && items.length === 0 ? <p className="m-0 px-4 py-3 text-[12px] text-mute">Loading reports.</p> : null}
          {!error && !loading && visible.length === 0 ? (
            <p className="m-0 px-4 py-3 text-[12px] text-mute">{filter.unread ? "Nothing unread." : "No reports."}</p>
          ) : null}
          <ReportList items={visible} selectedId={reportId} />
          {items.length < total ? (
            <div className="px-4 py-3">
              <Button size="sm" onClick={showMore}>
                Show {Math.min(PAGE_SIZE, total - items.length)} more of {total - items.length}
              </Button>
            </div>
          ) : null}
        </div>

        <div className={cx("min-w-0 bg-panel lg:rounded-card lg:border lg:border-line", !open && "hidden lg:block")}>
          {open ? (
            <ReportView key={reportId} id={reportId} onRead={onRead} />
          ) : (
            <p className="m-0 px-6 py-8 text-[13px] text-mute">Pick a report to read it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
