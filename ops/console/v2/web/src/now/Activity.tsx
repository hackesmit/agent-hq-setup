// The activity timeline (design section 4.1 item 2): what happened while you
// were away, in one filterable stream. Collapsed by default on every width;
// the header shows enough (count + newest entry age) to decide whether to open
// it. The v1 Operations and Recent-changes panels fold in here.

import { useState } from "react";
import type { ActivityEvent } from "@shared/api";
import { Button, Card, CardBody, CardHead, Chip, RigSigil, cx } from "../ui/primitives";
import { fmtAge } from "../ui/format";
import { ACTIVITY_FILTERS, filterActivity, filterCounts, typeTone, type ActivityFilter } from "./activity";
import { horizonIndex, newEvents } from "./sinceYouLeft";
import { TOUCH_SM } from "./ui";

const RENDER_CAP = 100;

function Row({ event, now }: { event: ActivityEvent; now: number }) {
  return (
    <li className="flex items-baseline gap-2 border-b border-line/60 px-3.5 py-1.5 text-[13px] last:border-b-0">
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-faint" title={event.ts}>
        {fmtAge(event.ts, now)}
      </span>
      <Chip tone={typeTone(event)}>{event.type}</Chip>
      {event.rig ? (
        <span className="inline-flex items-center gap-1.5">
          <RigSigil id={event.rig} size={12} />
          <Chip tone="mute">{event.rig}</Chip>
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink" title={event.title}>
          {event.bead ? <span className="font-mono text-[12px] text-mute">{event.bead} </span> : null}
          {event.title}
        </span>
        {event.detail ? (
          <span className="block truncate text-[12px] text-mute" title={event.detail}>
            {event.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function Activity({ events, now, since }: { events: ActivityEvent[]; now: number; since?: string | null }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const counts = filterCounts(events);
  const rows = filterActivity(events, filter).slice(0, RENDER_CAP);
  const newest = events[0] ?? null;
  // Where you stopped reading, drawn into the list rather than only counted above it.
  const horizon = horizonIndex(rows, since ?? null);
  const unread = newEvents(events, since ?? null).length;

  return (
    <Card>
      <CardHead
        title="Activity"
        chip={
          <Chip tone={unread > 0 ? "accent" : "mute"}>
            {events.length === 0 ? "quiet" : `${events.length}${newest ? `, last ${fmtAge(newest.ts, now)} ago` : ""}`}
          </Chip>
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            className={TOUCH_SM}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "hide" : "show"}
          </Button>
        }
      />
      {open ? (
        <CardBody className="px-0 py-0">
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3.5 py-2">
            {ACTIVITY_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={cx(
                  "rounded-sub px-2 py-0.5 text-[12px]",
                  filter === option.id ? "bg-accent/20 text-accent" : "bg-chip text-mute",
                )}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label} {counts[option.id]}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="m-0 px-3.5 py-3 text-[13px] text-mute">
              {events.length === 0 ? "Nothing yet in this stream." : "Nothing matches that filter."}
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {rows.map((event, i) => (
                <li key={event.id} className="list-none">
                  {i === horizon ? (
                    <div className="flex items-center gap-2.5 px-3.5 py-1.5" aria-hidden="true">
                      <span className="whitespace-nowrap text-[11px] text-faint">you left off here</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null}
                  <ul className="m-0 list-none p-0">
                    <Row event={event} now={now} />
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      ) : null}
    </Card>
  );
}
