// The report list: day headings, then one dense row per report with its severity bar,
// unread dot, kind chip, project and time. A row is a link to /reports/<id>, so a middle
// click opens it in a new tab and a plain click stays in the console.

import type { MouseEvent } from "react";
import type { ReportHeader } from "@shared/api";
import { Chip, cx } from "../ui/primitives";
import { navigate } from "../app/router";
import { reportPath } from "../app/routes";
import { groupByDay, kindLabel, kindTone, rowTime, severityTone, type SeverityTone } from "./model";

const BAR: Record<SeverityTone, string> = {
  p0: "bg-p0",
  p1: "bg-p1",
  p2: "bg-p2",
  info: "bg-transparent",
};

function Row({ item, active }: { item: ReportHeader; active: boolean }) {
  const href = reportPath(item.id);
  const tone = severityTone(item.severity);
  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  }
  return (
    <li>
      <a
        href={href}
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={cx(
          "relative flex gap-2.5 border-b border-line py-2.5 pr-3 pl-4 text-ink no-underline hover:bg-panel2",
          active && "bg-panel2",
        )}
      >
        <span aria-hidden className={cx("absolute inset-y-1.5 left-0 w-[3px] rounded-r-sub", BAR[tone])} />
        <span className="mt-[7px] flex w-2 shrink-0 justify-center">
          {item.read ? null : <span className="h-2 w-2 rounded-full bg-accent" title="unread" />}
          <span className="sr-only">{item.read ? "read" : "unread"}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11px] text-mute">
            <Chip tone={kindTone(item.kind)}>{kindLabel(item.kind)}</Chip>
            {tone !== "info" ? <span className={tone === "p2" ? "text-mute" : tone === "p0" ? "text-p0" : "text-p1"}>{item.severity}</span> : null}
            <span className="min-w-0 truncate">{item.project}</span>
            <span className="ml-auto shrink-0 font-mono">{rowTime(item.created)}</span>
          </span>
          <span className={cx("mt-0.5 line-clamp-2 block text-[13px] leading-[1.4] break-words", item.read ? "text-mute" : "font-semibold")}>
            {item.title}
          </span>
        </span>
      </a>
    </li>
  );
}

export function ReportList({ items, selectedId }: { items: readonly ReportHeader[]; selectedId: string | null }) {
  const groups = groupByDay(items);
  return (
    <div>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="sticky top-0 z-[1] m-0 border-b border-line bg-panel px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-faint">
            {group.label} <span className="font-normal">{group.items.length}</span>
          </h2>
          <ul className="m-0 list-none p-0">
            {group.items.map((item) => (
              <Row key={item.id} item={item} active={item.id === selectedId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
