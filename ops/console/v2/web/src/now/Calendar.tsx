// What is coming up, and what you have not answered.
//
// the owner: "sometimes I will get an email with a Google Meet invite and I won't
// notice or accept it. I want to be alerted of that in this."
//
// So the unanswered invitations are the point of this card, not a footnote on it.
// They sit at the top with the loudest treatment on the page short of a P0,
// because an invitation you never saw is the failure mode being fixed; everything
// below is ordinary schedule.
//
// Every string here was written by somebody else, which is unusual for this
// console: an event title comes from whoever sent the invite. The server bounds
// the lengths and drops any link that is not plainly https, and React puts all of
// it in text nodes, so a hostile title is text and a hostile link is absent.
import type { CalendarEvent, CalendarReport } from "@shared/api";
import { Card, CardBody, CardHead, Chip, cx } from "../ui/primitives";

/** Local day boundaries, so "today" means the reader's today. */
function dayKey(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function clockOf(event: CalendarEvent): string {
  if (event.allDay) return "all day";
  const at = new Date(event.startsAt);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Minutes until it starts; negative once it has. */
export function minutesUntil(event: CalendarEvent, now: number): number | null {
  const at = new Date(event.startsAt).getTime();
  if (Number.isNaN(at)) return null;
  return Math.round((at - now) / 60000);
}

/** Events grouped by the day they fall on, in order. */
export function byDay(events: CalendarEvent[]): { day: string; events: CalendarEvent[] }[] {
  const out: { day: string; events: CalendarEvent[] }[] = [];
  for (const event of events) {
    const day = dayKey(event.startsAt);
    if (!day) continue;
    const last = out[out.length - 1];
    if (last && last.day === day) last.events.push(event);
    else out.push({ day, events: [event] });
  }
  return out;
}

function Row({ event, now }: { event: CalendarEvent; now: number }) {
  const mins = minutesUntil(event, now);
  const soon = mins !== null && mins >= 0 && mins <= 30;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line px-3.5 py-2 last:border-b-0">
      <span className={cx("w-16 shrink-0 tabular-nums text-[12px]", soon ? "text-accent" : "text-mute")}>
        {clockOf(event)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={event.title}>
        {event.title}
      </span>
      {soon ? <Chip tone="accent">in {mins} min</Chip> : null}
      {event.response === "tentative" ? <Chip tone="mute">maybe</Chip> : null}
      {event.meetLink ? (
        <a
          href={event.meetLink}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[11px] text-mute no-underline hover:text-ink"
        >
          join
        </a>
      ) : null}
    </div>
  );
}

export function Calendar({ report }: { report: CalendarReport | null }) {
  const now = Date.now();
  const events = report?.events ?? [];
  const waiting = events.filter((e) => e.response === "needsAction");
  const rest = events.filter((e) => e.response !== "needsAction");

  return (
    <Card className={waiting.length > 0 ? "hq-call" : undefined}>
      <CardHead
        title="Calendar"
        chip={
          // "0 in 14 days" when the calendar cannot be read says "you have no
          // meetings", which is a different and much worse claim than "I cannot
          // see your calendar". Unreadable says unreadable.
          report && report.ok === false ? (
            <Chip tone="warn">unavailable</Chip>
          ) : waiting.length > 0 ? (
            <Chip tone="warn">{waiting.length} unanswered</Chip>
          ) : (
            <Chip tone="mute">{events.length} in 14 days</Chip>
          )
        }
      />
      <CardBody className="px-0 pb-0 pt-0">
        {report && report.ok === false ? (
          <p className="m-0 px-3.5 py-4 text-[13px] text-mute">
            Calendar unavailable: {report.reason ?? "no reason given"}
          </p>
        ) : null}

        {waiting.length > 0 ? (
          <div className="border-b border-line bg-warn/10 px-3.5 py-2.5">
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-warn">Never answered</div>
            {waiting.map((event) => (
              <div key={event.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
                <span className="text-[12px] tabular-nums text-mute">
                  {dayKey(event.startsAt)} {clockOf(event)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={event.title}>
                  {event.title}
                </span>
                {event.organizer ? <span className="text-[11px] text-mute">{event.organizer}</span> : null}
                {event.meetLink ? (
                  <a
                    href={event.meetLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[11px] text-warn no-underline hover:text-ink"
                  >
                    open
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {rest.length === 0 && waiting.length === 0 && (!report || report.ok !== false) ? (
          <p className="m-0 px-3.5 py-4 text-[13px] text-mute">Nothing on the calendar for the next fortnight.</p>
        ) : null}

        {byDay(rest).map((group) => (
          <div key={group.day}>
            <div className="border-b border-line bg-panel2/40 px-3.5 py-1 text-[10px] uppercase tracking-[0.16em] text-mute">
              {group.day}
            </div>
            {group.events.map((event) => (
              <Row key={event.id} event={event} now={now} />
            ))}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
