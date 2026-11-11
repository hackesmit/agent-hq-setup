// One project, drilled down: header and tiles, the plan (timeline, epics or the flow
// chart), truths, recent activity, and the three summary cards that open the beads list
// and the doc viewer.

import { useState } from "react";
import type { ProjectSummary } from "@shared/api";
import { navigate } from "../app/router";
import { useConsoleSlice } from "../data/store";
import {
  Button,
  ButtonRow,
  Card,
  CardBody,
  CardHead,
  Chip,
  PageHeader,
  Placeholder,
  ProgressBar,
  StatTile,
} from "../ui/primitives";
import { fmtAge, fmtCount, fmtDate } from "../ui/format";
import { DOC_LABELS, errorText, projectsApi, type DocName } from "./api";
import { BeadsList, type StatusFilter } from "./BeadsList";
import { DocViewer } from "./DocViewer";
import { FlowChart } from "./FlowChart";
import { ProcessCharts } from "./ProcessCharts";
import { FEATURES } from "./features";
import { ATTENTION_CHIP, daysUntil, milestoneProgress } from "./overview";
import { RecentCard } from "./RecentCard";
import { Timeline } from "./Timeline";
import { TruthsCard } from "./TruthsCard";
import { useAsync } from "./useAsync";

type PlanView = "timeline" | "epics" | "graph";

/** "$12,340 MXN" (+ USD beside it when both were logged); "$0" when the ledger has nothing. */
export function fmtEarned(earned: ProjectSummary["earned"]): string {
  if (earned === null) return "-";
  // cents are money: never rounded away ($0.50 is $0.50, not $1)
  const amount = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  const parts: string[] = [];
  if (earned.mxnCents > 0) parts.push(`$${amount(earned.mxnCents)} MXN`);
  if (earned.usdCents > 0) parts.push(`$${amount(earned.usdCents)} USD`);
  return parts.length > 0 ? parts.join(" + ") : "$0";
}

/**
 * "$1,284" / "$12.40" / "$0.05". Never rounded to a bare "$0" while any spend
 * exists: a project that cost five cents did cost something, and a tile that
 * says $0 next to a real token count reads as a bug.
 */
export function fmtCostUsd(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return "-";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  const digits = usd >= 100 ? 0 : 2;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function Crumb({ label }: { label: string }) {
  return (
    <p className="mb-2 text-[12px] text-mute">
      <a
        href="/projects"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigate("/projects");
        }}
      >
        Projects
      </a>{" "}
      / {label}
    </p>
  );
}

export function ProjectPage({
  project,
  id,
  beadId = null,
}: {
  project: ProjectSummary | null;
  id: string;
  beadId?: string | null;
}) {
  // Epics first: the plan opens at the idea level, not the atoms.
  const [plan, setPlan] = useState<PlanView>("epics");
  const [beadsFilter, setBeadsFilter] = useState<{ status: StatusFilter; label: string | null } | null>(
    beadId ? { status: "all", label: null } : null,
  );
  // A bead link followed while this page is already mounted (same project) still opens it.
  const [seenBead, setSeenBead] = useState(beadId);
  if (beadId !== seenBead) {
    setSeenBead(beadId);
    if (beadId) setBeadsFilter({ status: "all", label: null });
  }
  const [doc, setDoc] = useState<DocName | null>(null);
  const usage = useConsoleSlice((state) => state?.usage ?? null);

  const detail = useAsync((signal) => projectsApi.detail(id, signal), `${id}:detail`);
  const timeline = useAsync((signal) => projectsApi.timeline(id, signal), `${id}:timeline`);

  if (!project && !detail.data) {
    return (
      <>
        <Crumb label={id} />
        <PageHeader
          title={id}
          sub={
            detail.loading
              ? "Loading."
              : "No project with this id in the current state. Check ops/projects.json."
          }
        />
      </>
    );
  }

  const summary = project ?? detail.data!.summary;
  const chip = ATTENTION_CHIP[summary.attention];
  const epics = detail.data?.epics ?? [];
  const milestone = milestoneProgress(epics);
  const days = daysUntil(summary.targetDate);
  const items = timeline.data ?? [];
  const byLabel = detail.data?.beads.byLabel ?? {};
  const docs = detail.data?.docs ?? { knowledge: false, hub: false, decisions: false };

  function openBeads(status: StatusFilter, label: string | null = null): void {
    setDoc(null);
    setBeadsFilter({ status, label });
  }

  return (
    <>
      <Crumb label={summary.name} />
      <PageHeader
        title={summary.name}
        sub={summary.goal ?? undefined}
        actions={
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone="mute">{summary.kind}</Chip>
            {summary.status !== "active" ? <Chip tone="warn">{summary.status}</Chip> : null}
            {summary.needsYou > 0 ? <Chip tone="bad">{summary.needsYou} waiting on you</Chip> : null}
            <Chip tone={chip.tone}>{chip.label}</Chip>
            {summary.targetDate ? <Chip tone="accent">target {fmtDate(summary.targetDate)}</Chip> : null}
          </span>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Complete"
          value={summary.completion === null ? "-" : `${Math.round(summary.completion * 100)}%`}
          detail={
            summary.activeEpic
              ? `now: ${summary.activeEpic.title} (${summary.activeEpic.done}/${summary.activeEpic.total})`
              : milestone?.lead
                ? `${milestone.lead.title}: ${milestone.closed} of ${milestone.total} beads`
                : "closed over everything scoped"
          }
        />
        <StatTile
          label="Due"
          value={summary.targetDate ? fmtDate(summary.targetDate) : "none"}
          detail={
            days === null
              ? summary.nextUp
                ? `next: ${summary.nextUp.id}`
                : "nothing ready"
              : days < 0
                ? `${Math.abs(days)} days late`
                : `${days} days left`
          }
        />
        <StatTile
          label="Questions waiting"
          value={summary.needsYou}
          detail={`${summary.counts.blocked} blocked, ${summary.counts.inProgress} in progress`}
        />
        <StatTile
          label="Worth"
          value={summary.worth ?? "-"}
          detail={summary.worth ? "your valuation (ops/projects.json)" : "unset: add `worth` to ops/projects.json"}
        />
        <StatTile
          label="Earned"
          value={fmtEarned(summary.earned)}
          detail={
            summary.earned === null
              ? "no money ledger on this box"
              : summary.earned.mxnCents === 0 && summary.earned.usdCents === 0
                ? "nothing logged against this project yet (Money tab)"
                : "money in, logged against this project, all-time"
          }
        />
        <StatTile
          label="Cost"
          value={fmtCostUsd(summary.costUsd30d)}
          detail={
            summary.tokens30d === null
              ? "no usage data on this box"
              : summary.tokens30d === 0
                ? "no agent work attributed here in the last 30 days"
                : `${fmtCount(summary.tokens30d)} tokens in 30 days, at API list prices`
          }
        />
        <StatTile
          label="Invested"
          value={summary.startedAt ? fmtAge(summary.startedAt) : "-"}
          detail={
            (summary.startedAt ? `since ${fmtDate(summary.startedAt)}; ` : "") +
            (usage ? `${fmtCount(usage.tokensWeek)} tokens this week workspace-wide` : "tokens: no usage data")
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHead
            title="Plan (bd deps, due, estimate)"
            chip={
              timeline.loading ? (
                <Chip tone="mute">loading</Chip>
              ) : (
                <Chip tone="mute">{items.length} items</Chip>
              )
            }
            actions={
              <ButtonRow>
                <Button size="sm" variant={plan === "timeline" ? "primary" : "default"} onClick={() => setPlan("timeline")}>
                  Timeline
                </Button>
                <Button size="sm" variant={plan === "epics" ? "primary" : "default"} onClick={() => setPlan("epics")}>
                  Epics
                </Button>
                <Button size="sm" variant={plan === "graph" ? "primary" : "default"} onClick={() => setPlan("graph")}>
                  Flow
                </Button>
              </ButtonRow>
            }
          />
          <CardBody>
            {timeline.error ? (
              <p className="m-0 text-[12px] text-bad">Could not project the plan. {errorText(timeline.error)}</p>
            ) : null}
            {plan === "timeline" ? (
              <Timeline
                items={items}
                onSetDue={
                  FEATURES.timelineDueDrag
                    ? (bead, due) => {
                        void projectsApi.setBeadDue(id, bead, due).then(
                          () => timeline.reload(),
                          () => timeline.reload(),
                        );
                      }
                    : undefined
                }
              />
            ) : null}
            {plan === "epics" ? (
              epics.length === 0 ? (
                <p className="m-0 text-[12px] text-mute">No epics on this project yet.</p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {epics.map((epic) => (
                    <li key={epic.id} className="flex items-center gap-2 border-b border-line py-1.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        <span className="font-mono text-faint">{epic.id}</span> {epic.title}
                      </span>
                      <ProgressBar value={epic.children === 0 ? 0 : epic.closed / epic.children} />
                      <span className="w-20 shrink-0 text-right font-mono text-[12px] text-mute">
                        {epic.closed}/{epic.children}
                      </span>
                      <span className="w-16 shrink-0 text-right text-[12px] text-mute">
                        {epic.due ? fmtDate(epic.due) : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {plan === "graph" ? <FlowChart project={id} /> : null}
            <p className="mt-2 mb-0 text-[11px] text-faint">
              Open bars are a projection from estimate and dependency order, not a promise. Only due dates are
              persisted; start positions are re-projected every load.
            </p>
          </CardBody>
        </Card>

        <div className="grid gap-4 content-start">
          <TruthsCard project={id} />
          {detail.data ? (
            <RecentCard detail={detail.data} />
          ) : (
            <Card>
              <CardHead title="Recent" />
              <CardBody>
                <p className="m-0 text-[12px] text-mute">
                  {detail.loading ? "Loading commits and verdicts." : errorText(detail.error)}
                </p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHead title="Beads by status" />
          <CardBody>
            {detail.data ? (
              <>
                <div className="mb-2 flex flex-wrap gap-1.5 text-[12px]">
                  {(
                    [
                      ["open", detail.data.beads.open],
                      ["in_progress", detail.data.beads.inProgress],
                      ["blocked", detail.data.beads.blocked],
                      ["closed", detail.data.beads.closed],
                    ] as [StatusFilter, number][]
                  ).map(([status, count]) => (
                    <Button key={status} size="sm" onClick={() => openBeads(status)}>
                      {status.replace("_", " ")} {count}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(byLabel).length === 0 ? (
                    <span className="text-[12px] text-mute">no labels in use</span>
                  ) : (
                    Object.entries(byLabel)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 10)
                      .map(([label, count]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => openBeads("all", label)}
                          className="cursor-pointer rounded-sub border border-line bg-chip px-1.5 py-px text-[11px] text-ink"
                        >
                          {label} {count}
                        </button>
                      ))
                  )}
                </div>
              </>
            ) : (
              <p className="m-0 text-[12px] text-mute">{detail.loading ? "Loading." : "Not available."}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHead title="Knowledge and decisions" />
          <CardBody>
            <ButtonRow>
              {(Object.keys(DOC_LABELS) as DocName[]).map((name) => (
                <Button
                  key={name}
                  size="sm"
                  disabled={!docs[name]}
                  title={docs[name] ? undefined : "not present in this project"}
                  onClick={() => {
                    setBeadsFilter(null);
                    setDoc(name);
                  }}
                >
                  {DOC_LABELS[name]}
                </Button>
              ))}
            </ButtonRow>
            <p className="mt-2 mb-0 text-[11px] text-faint">
              Rendered read-only by the console's own markdown renderer: no raw HTML, no remote images, links
              limited to http, https and mailto.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHead title="Deploys and errors" />
          <CardBody>
            <p className="m-0 mb-2 text-[12px] text-mute">
              {summary.lastDeploy
                ? `last deploy ${summary.lastDeploy.state}, ${fmtAge(summary.lastDeploy.at)} ago`
                : "no deploy target registered"}
            </p>
            <Placeholder phase="phase 2">
              Deploy history per provider and the error-system reports for this rig.
            </Placeholder>
          </CardBody>
        </Card>
      </div>

      <section className="mt-4" aria-label="Process charts">
        <h2 className="mt-0 mb-2 text-[11px] font-normal uppercase tracking-[0.14em] text-mute">Process charts</h2>
        <ProcessCharts project={id} />
      </section>

      {beadsFilter ? (
        <div className="mt-4">
          <BeadsList
            project={id}
            initialStatus={beadsFilter.status}
            initialLabel={beadsFilter.label}
            openBead={beadId}
            onClose={() => setBeadsFilter(null)}
          />
        </div>
      ) : null}

      {doc ? (
        <div className="mt-4">
          <DocViewer project={id} available={docs} initial={doc} onClose={() => setDoc(null)} />
        </div>
      ) : null}
    </>
  );
}
