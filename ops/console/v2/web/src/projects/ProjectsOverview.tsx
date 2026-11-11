// Projects overview: one card per project, ordered by what wants attention. Everything on
// a card comes from collectors (bd, git, deploys); nothing here is typed by hand.

import { useState } from "react";
import type { ProjectSummary } from "@shared/api";
import { navigate } from "../app/router";
import { projectPath } from "../app/routes";
import { Card, CardBody, Chip, PageHeader } from "../ui/primitives";
import { fmtAge, fmtDate } from "../ui/format";
import { CalendarCard } from "./CalendarCard";
import {
  ATTENTION_CHIP,
  FILTER_LABELS,
  PROJECT_FILTERS,
  activityGeometry,
  activityLabel,
  activityTotal,
  filterCounts,
  filterProjects,
  type ProjectFilter,
} from "./overview";

function Activity({ values, label }: { values: readonly number[]; label: string }) {
  const geometry = activityGeometry(values);
  // A month with nothing in it still holds its space, so cards keep the same height
  // and the grid does not jump as projects go quiet and come back.
  if (geometry.bars.length === 0) return <div style={{ height: geometry.height }} aria-hidden="true" />;
  return (
    <svg
      className="block w-full"
      style={{ height: geometry.height }}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {geometry.bars.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          fill="var(--accent)"
          opacity="0.85"
        />
      ))}
    </svg>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const chip = ATTENTION_CHIP[project.attention];
  const deploy = project.lastDeploy;
  const total = activityTotal(project.activity30d);
  return (
    <a
      href={projectPath(project.id)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(projectPath(project.id));
      }}
      className="block rounded-card border border-line bg-panel px-3.5 py-3 text-ink no-underline shadow-card hover:border-accent"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <b className="text-[15px]">{project.name}</b>
          {project.client ? (
            <span className="truncate text-[11px] uppercase tracking-[0.05em] text-mute">{project.client}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5">
          {project.needsYou > 0 ? <Chip tone="bad">{project.needsYou} waiting on you</Chip> : null}
          {/* The count chip already reads "n needs you", and attention is "needs-you"
              precisely BECAUSE that count is above zero, so the second chip said the
              same words again beside it. It is only news when it is something else. */}
          {project.attention === "needs-you" && project.needsYou > 0 ? null : (
            <Chip tone={chip.tone}>{chip.label}</Chip>
          )}
        </span>
      </div>
      <div className="text-[12px] text-mute">
        {project.goal ?? "No goal set."}
        {project.targetDate ? ` Due ${fmtDate(project.targetDate)}.` : ""}
      </div>
      {project.completion !== null && project.completion !== undefined ? (
        <div className="mt-1.5 flex items-center gap-2" title={project.activeEpic ? `now: ${project.activeEpic.title} (${project.activeEpic.done}/${project.activeEpic.total})` : "closed over everything scoped in bd"}>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-panel2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(project.completion * 100)}%` }} />
          </div>
          <span className="shrink-0 font-mono text-[11px] text-mute">{Math.round(project.completion * 100)}%</span>
        </div>
      ) : null}
      <div className="my-2 grid grid-cols-4 gap-1.5">
        {[
          { label: "open", value: project.counts.open, bad: false },
          { label: "active", value: project.counts.inProgress, bad: false },
          { label: "blocked", value: project.counts.blocked, bad: project.counts.blocked > 0 },
          { label: "closed 7d", value: project.counts.closed7d, bad: false },
        ].map((cell) => (
          <div key={cell.label} className="rounded-sub bg-panel2 px-2 py-1.5">
            <small className="block text-[10px] uppercase tracking-[0.05em] text-mute">{cell.label}</small>
            <b className={`font-mono text-[14px] ${cell.bad ? "text-bad" : ""}`}>{cell.value}</b>
          </div>
        ))}
      </div>
      <Activity
        values={project.activity30d}
        label={`${project.name}: ${activityLabel(total, project.activitySource)}`}
      />
      <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-mute">
        <span>{activityLabel(total, project.activitySource)}</span>
        {project.activityTruncated ? <span className="text-warn">early days incomplete</span> : null}
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-2 text-[12px] text-mute">
        <span>merge {fmtAge(project.lastMergeAt)}</span>
        <span>{deploy ? `deploy ${deploy.state} ${fmtAge(deploy.at)}` : "no deploy"}</span>
        <span>{project.nextUp ? `next: ${project.nextUp.id}` : "nothing ready"}</span>
      </div>
    </a>
  );
}

export function ProjectsOverview({ projects }: { projects: ProjectSummary[] }) {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const counts = filterCounts(projects);
  const shown = filterProjects(projects, filter);

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <span className="flex flex-wrap items-center gap-1.5">
            {PROJECT_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === filter}
                onClick={() => setFilter(option)}
                className={`cursor-pointer rounded-sub border px-2 py-0.5 text-[11px] ${
                  option === filter ? "border-accent bg-accent/20 text-accent" : "border-line bg-panel text-mute"
                }`}
              >
                {FILTER_LABELS[option]} {counts[option]}
              </button>
            ))}
          </span>
        }
      />
      {shown.length === 0 ? (
        <Card>
          <CardBody>
            <p className="m-0 text-[13px] text-mute">
              {projects.length === 0
                ? "No projects yet. The registry lands with ops/projects.json in phase 1."
                : "No project matches this filter."}
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {shown.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
      <CalendarCard projects={shown} />
    </>
  );
}
