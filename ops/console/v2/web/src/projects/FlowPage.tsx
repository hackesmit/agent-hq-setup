// /projects/<id>/flow[/<epic>][?focus=<bead>]: one project's flow chart, full width,
// reachable from a terminal, a request card or the palette (bead hq-c4pl0.3). The
// route owns the epic, so the back button walks the drill-down. ?chart=<name> shows
// one authored process chart instead (bead hq-c4pl0.4).

import type { MouseEvent } from "react";
import type { ProjectSummary } from "@shared/api";
import { navigate } from "../app/router";
import { flowPath, projectPath } from "../app/routes";
import { Card, CardBody, PageHeader } from "../ui/primitives";
import { FlowChart } from "./FlowChart";
import { ProcessCharts } from "./ProcessCharts";

function go(path: string) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  };
}

export function FlowPage({
  project,
  id,
  epic,
  focus,
  chart = null,
}: {
  project: ProjectSummary | null;
  id: string;
  epic: string | null;
  focus: string | null;
  chart?: string | null;
}) {
  const name = project?.name ?? id;
  return (
    <>
      <p className="mb-2 text-[12px] text-mute">
        <a href="/projects" onClick={go("/projects")}>
          Projects
        </a>{" "}
        /{" "}
        <a href={projectPath(id)} onClick={go(projectPath(id))}>
          {name}
        </a>{" "}
        / Flow
      </p>
      <PageHeader title={`${name} flow`} />
      {chart ? (
        <ProcessCharts project={id} only={chart} />
      ) : (
        <Card>
          <CardBody>
            <FlowChart
              project={id}
              epic={epic}
              focus={focus}
              // drilling or going back is a fresh view: the ring belongs to the chart it was opened on
              onEpic={(next) => navigate(flowPath(id, { epic: next }))}
            />
          </CardBody>
        </Card>
      )}
    </>
  );
}
