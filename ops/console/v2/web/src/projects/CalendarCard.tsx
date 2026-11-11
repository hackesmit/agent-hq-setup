// Month calendar across projects: bead and epic due dates, from the same timeline
// projection the Gantt draws. Wake times and scheduled jobs join in phase 2 (design 4.2).
// Clicking a day's entry opens that project.

import { useState } from "react";
import type { ProjectSummary, TimelineItem } from "@shared/api";
import { navigate } from "../app/router";
import { projectPath } from "../app/routes";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip } from "../ui/primitives";
import { projectsApi } from "./api";
import { WEEKDAYS, eventsByDay, monthView, shiftMonth, type EventSource } from "./calendar";
import { useAsync } from "./useAsync";

const MAX_PROJECTS = 8;

export function CalendarCard({ projects }: { projects: readonly ProjectSummary[] }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() });
  const [open, setOpen] = useState(false);

  const wanted = projects.slice(0, MAX_PROJECTS);
  const key = wanted.map((project) => project.id).join(",");
  const { data, loading } = useAsync<EventSource[]>(
    async (signal) => {
      if (!open) return [];
      return Promise.all(
        wanted.map(async (project) => ({
          project: project.id,
          projectName: project.name,
          items: await projectsApi
            .timeline(project.id, signal)
            .catch((): TimelineItem[] => []),
        })),
      );
    },
    `calendar:${open ? "on" : "off"}:${key}`,
  );

  const view = monthView(cursor.year, cursor.month, eventsByDay(data ?? []));

  return (
    <Card className="mt-4">
      <CardHead
        title="Calendar"
        chip={<Chip tone="mute">due dates</Chip>}
        actions={
          <ButtonRow>
            {open ? (
              <>
                <Button size="sm" onClick={() => setCursor((at) => shiftMonth(at.year, at.month, -1))}>
                  Prev
                </Button>
                <span className="px-1 text-[12px]">{view.label}</span>
                <Button size="sm" onClick={() => setCursor((at) => shiftMonth(at.year, at.month, 1))}>
                  Next
                </Button>
              </>
            ) : null}
            <Button size="sm" variant={open ? "default" : "primary"} onClick={() => setOpen((value) => !value)}>
              {open ? "Hide" : "Show"}
            </Button>
          </ButtonRow>
        }
      />
      {open ? (
        <CardBody>
          {loading ? <p className="m-0 mb-2 text-[12px] text-mute">Loading due dates.</p> : null}
          <div className="grid grid-cols-7 gap-px text-[11px]">
            {WEEKDAYS.map((day) => (
              <div key={day} className="px-1 py-0.5 text-center text-mute">
                {day}
              </div>
            ))}
            {view.weeks.flatMap((week) =>
              week.map((day) => (
                <div
                  key={day.iso}
                  className={[
                    "min-h-[54px] rounded-sub border p-1",
                    day.inMonth ? "border-line bg-panel" : "border-transparent bg-panel2/30 text-faint",
                    day.today ? "border-accent" : "",
                  ].join(" ")}
                >
                  <span className={day.weekend ? "text-faint" : "text-mute"}>{day.day}</span>
                  {day.events.slice(0, 3).map((event) => (
                    <button
                      key={`${event.project}-${event.id}`}
                      type="button"
                      title={`${event.projectName}: ${event.id} ${event.title}`}
                      onClick={() => navigate(projectPath(event.project))}
                      className={[
                        "mt-0.5 block w-full cursor-pointer truncate rounded-sub border-0 px-1 py-px text-left text-[10px]",
                        event.done
                          ? "bg-ok/15 text-ok"
                          : event.late
                            ? "bg-bad/15 text-bad"
                            : event.kind === "epic"
                              ? "bg-accent/20 text-accent"
                              : "bg-chip text-ink",
                      ].join(" ")}
                    >
                      {event.id} {event.title}
                    </button>
                  ))}
                  {day.events.length > 3 ? (
                    <span className="mt-0.5 block text-[10px] text-faint">+{day.events.length - 3} more</span>
                  ) : null}
                </div>
              )),
            )}
          </div>
        </CardBody>
      ) : null}
    </Card>
  );
}
