// The reading view for one report: title, kind, severity, project, time, a link to the
// bead it names, then the body across the reader, prose at a reading measure inside it.
// Opening it marks it read; the GET alone never does (server contract), so a prefetch or
// a reload cannot eat a report.

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { ReportDetail } from "@shared/api";
import { ApiError } from "../data/client";
import { navigate } from "../app/router";
import { tabPath } from "../app/routes";
import { useAsync } from "../projects/useAsync";
import { Button, Chip, cx } from "../ui/primitives";
import { getReport, markRead } from "./api";
import { ReportBody } from "./ReportBody";
import { beadPath, bodyMode, findBead, fullTime, kindLabel, kindTone, severityTone } from "./model";

const SEVERITY_CLASS = { p0: "text-p0", p1: "text-p1", p2: "text-mute", info: "text-mute" } as const;

function internalLink(path: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };
}

function Meta({ report }: { report: ReportDetail }) {
  const bead = findBead(report.title, report.body_md);
  const tone = severityTone(report.severity);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-mute">
      <Chip tone={kindTone(report.kind)}>{kindLabel(report.kind)}</Chip>
      <span className={SEVERITY_CLASS[tone]}>{report.severity}</span>
      <a href={`/projects/${encodeURIComponent(report.project)}`} onClick={internalLink(`/projects/${encodeURIComponent(report.project)}`)} className="text-ink">
        {report.project || "no project"}
      </a>
      <time dateTime={report.created}>{fullTime(report.created)}</time>
      {bead ? (
        <a
          href={beadPath(report.project, bead)}
          onClick={internalLink(beadPath(report.project, bead))}
          className="font-mono text-ink"
          title="Open the project page that lists this bead"
        >
          bead {bead}
        </a>
      ) : null}
      {report.source && report.source !== "gmail" ? <span className="font-mono text-faint">{report.source}</span> : null}
    </div>
  );
}

export function ReportView({ id, onRead }: { id: string; onRead: (id: string) => void }) {
  const { data, error, loading } = useAsync<ReportDetail>((signal) => getReport(id, signal), id);
  const [plain, setPlain] = useState(false);
  const marked = useRef<string | null>(null);

  useEffect(() => setPlain(false), [id]);

  // Opening marks read, once per open. A read-only server (409) or a failed mark leaves
  // the dot on, which is the honest state: the store still says unread.
  useEffect(() => {
    if (!data || data.id !== id || marked.current === id) return;
    marked.current = id;
    if (data.read) return;
    markRead(id)
      .then(() => onRead(id))
      .catch(() => undefined);
  }, [data, id, onRead]);

  const back = (
    <Button size="sm" variant="ghost" className="lg:hidden" onClick={() => navigate(tabPath("reports"))}>
      Back to reports
    </Button>
  );

  if (loading && !data) {
    return <div className="p-4 text-[12px] text-mute">{back} Loading report.</div>;
  }
  if (error || !data) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className="p-4 text-[13px]">
        {back}
        <p className="mt-2 mb-0 text-bad">{missing ? "This report is not in the store." : `Could not load the report: ${String((error as Error)?.message ?? error)}`}</p>
      </div>
    );
  }

  const canToggle = bodyMode(data) !== "text";
  return (
    <article className="px-4 pt-3 pb-8 sm:px-6">
      <div className="flex items-center justify-between gap-2">
        {back}
        {canToggle ? (
          <Button size="sm" variant="ghost" className="ml-auto" aria-pressed={plain} onClick={() => setPlain((v) => !v)}>
            {plain ? "Formatted" : "Plain text"}
          </Button>
        ) : null}
      </div>
      <h1 className={cx("m-0 mt-1 text-[17px] leading-[1.35] font-semibold text-balance break-words")}>{data.title}</h1>
      <Meta report={data} />
      <div className="mt-4 border-t border-line pt-3">
        <ReportBody report={data} plain={plain} />
      </div>
    </article>
  );
}
