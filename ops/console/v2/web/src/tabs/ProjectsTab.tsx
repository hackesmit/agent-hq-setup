// Projects tab entry points. The screen itself lives in ../projects: the overview grid,
// the drill-down page, the timeline, the truths editor and the markdown renderer are one
// feature and share their own module.
//
// The two names exported here are the Shell's contract (tab body and drill-down), so they
// stay stable while the feature underneath grows.

import type { DiscoveredReport, ProjectSummary } from "@shared/api";
import { Discovered } from "../projects/Discovered";
import { FlowPage } from "../projects/FlowPage";
import { ProjectPage } from "../projects/ProjectPage";
import { ProjectsOverview } from "../projects/ProjectsOverview";

export { sortProjects } from "../projects/overview";

export function ProjectsTab({
  projects,
  discovered,
}: {
  projects: ProjectSummary[];
  discovered: DiscoveredReport | null;
}) {
  return (
    <>
      <Discovered report={discovered} />
      <ProjectsOverview projects={projects} />
    </>
  );
}

export function ProjectDetail({
  project,
  id,
  beadId = null,
  flow = null,
}: {
  project: ProjectSummary | null;
  id: string;
  beadId?: string | null;
  /** /projects/<id>/flow...: the full-width flow chart instead of the project page. */
  flow?: { epic: string | null; focus: string | null; chart: string | null } | null;
}) {
  if (flow) return <FlowPage project={project} id={id} epic={flow.epic} focus={flow.focus} chart={flow.chart} />;
  return <ProjectPage project={project} id={id} beadId={beadId} />;
}
