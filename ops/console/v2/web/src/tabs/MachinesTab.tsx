// Machines: hqbox hardware (live), disk and backup health, programs (services with logs and gated
// restart), jobs and automations (bead hq-7icm, design 4.4). Policy comes from
// the guard-protected ops/projects/console/*.json; empty sections say so
// instead of pretending health. Cloud deploys stay a phase 2.5 placeholder
// behind their token asks.

import { useState } from "react";
import type { CollectorStatus, DeploysReport, HealthLevel, JobRow, MachineHealth, MachineSnapshot, MonitorsReport, ServiceRow, ServicesReport } from "@shared/api";
import { api } from "../data/client";
import { useOpRunner } from "../now/ops";
import { safeLink } from "../now/lanes";
import { Gauge } from "../machines/Gauge";
import { CPU, LOAD, MEM, TEMP } from "../machines/scales";
import { toastInfo } from "../now/toast";
import { jobDetail, jobTone, serviceTone, useOpKey, type Tone } from "../machines/model";
import { Button, Card, CardBody, CardHead, Chip, PageHeader, Sparkline } from "../ui/primitives";
import { fmtAge, fmtDuration, fmtGb, pct } from "../ui/format";

function ServiceLine({
  tone,
  name,
  detail,
  right,
  children,
}: {
  tone: Tone;
  name: string;
  detail?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const dot = tone === "ok" ? "bg-ok" : tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-faint";
  return (
    <div className="border-b border-line py-1.5 last:border-b-0">
      <div className="grid grid-cols-[10px_1fr_auto] items-center gap-2.5 text-[13px]">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden="true" />
        <span className="min-w-0 truncate">
          {name} {detail ? <small className="text-mute">{detail}</small> : null}
        </span>
        <span className="flex items-center gap-1.5 text-[12px] text-mute">{right ?? null}</span>
      </div>
      {children}
    </div>
  );
}

function HardwareCard({ machine }: { machine: MachineSnapshot | null }) {
  if (!machine) {
    return (
      <Card>
        <CardHead title="hqbox" chip={<Chip tone="mute">no data</Chip>} />
        <CardBody>
          <p className="m-0 text-[13px] text-mute">The machine collector has not reported yet.</p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHead title={machine.host} chip={<Chip tone="ok">up {fmtDuration(machine.uptimeS)}</Chip>} />
      <CardBody>
        {/* Four gauges rather than a sentence of numbers. The sentence was true
            and unreadable: it required the reader to already know what counts as
            a normal temperature for this hardware. */}
        {/* Container queries, not viewport ones. This card is a third of the page
            on a desktop, so sm:grid-cols-2 asked the VIEWPORT how wide it was and
            got the wrong answer: four gauges were laid out across a column narrow
            enough that the labels overlapped the numbers. The card measures
            itself now, so it holds on a phone, in this column, and full width. */}
        <div className="@container">
          <div className="grid gap-2 @[22rem]:grid-cols-2 @[52rem]:grid-cols-4">
          <Gauge label="CPU" value={machine.cpuPct} scale={CPU} series={machine.series?.cpu} />
          <Gauge
            label="Memory"
            value={machine.mem.pct}
            scale={MEM}
            series={machine.series?.mem}
            detail={`${fmtGb(machine.mem.usedMb)} of ${fmtGb(machine.mem.totalMb)}`}
          />
          <Gauge
            label="Load"
            value={machine.cores > 0 ? machine.load[0] / machine.cores : null}
            scale={LOAD}
            series={machine.series?.load}
            detail={`${machine.load.map((v) => v.toFixed(2)).join(" ")} on ${machine.cores} cores`}
          />
            <Gauge label="Temperature" value={machine.tempC} scale={TEMP} series={machine.series?.temp} />
          </div>
        </div>

        <p className="mt-2.5 mb-2 text-[12px] text-mute">
          {machine.disks.map((disk) => `${disk.mount} ${pct(disk.pct)}`).join(", ")}
        </p>
        {machine.cpuSeries24h.length > 1 ? <Sparkline points={machine.cpuSeries24h} label="CPU, 24 hours" /> : null}
        <div className="mt-2 text-[12px] text-mute">
          top: {machine.topRss.slice(0, 3).map((proc) => `${proc.name} ${Math.round(proc.rssMb)} MB`).join(", ")}
        </div>
      </CardBody>
    </Card>
  );
}

const levelTone = (level: HealthLevel): Tone => (level === "ok" ? "ok" : level === "crit" ? "bad" : "warn");
const levelChip = (level: HealthLevel): "ok" | "warn" | "bad" => (level === "ok" ? "ok" : level === "crit" ? "bad" : "warn");

/** Disk and backup health. The verdicts come from the server, so this card and the alert cards in Now agree. */
function HealthCard({ health }: { health: MachineHealth | null }) {
  const disk = health?.disk ?? null;
  const backup = health?.backup ?? null;
  const levels = [disk?.level, backup?.level].filter((l): l is HealthLevel => Boolean(l));
  const worst: HealthLevel = levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok";
  const diskFacts = disk
    ? [
        disk.passed === null ? null : disk.passed ? "self-check passed" : "self-check FAILED",
        disk.usedPct !== null ? `${disk.usedPct}% worn` : null,
        disk.sparePct !== null ? `${disk.sparePct}% spare` : null,
        disk.tempC !== null ? `${disk.tempC} C` : null,
      ].filter(Boolean)
    : [];
  const diskHistory = disk
    ? [
        disk.powerOnHours !== null ? `${disk.powerOnHours.toLocaleString("en-US")} hours powered on` : null,
        disk.unsafeShutdowns !== null ? `${disk.unsafeShutdowns} unsafe shutdowns` : null,
        disk.mediaErrors !== null ? `${disk.mediaErrors} media errors` : null,
      ].filter(Boolean)
    : [];
  return (
    <Card>
      <CardHead
        title="Health"
        chip={
          levels.length === 0 ? (
            <Chip tone="mute">no data</Chip>
          ) : (
            <Chip tone={levelChip(worst)}>{worst === "ok" ? "healthy" : worst === "crit" ? "failing" : "needs a look"}</Chip>
          )
        }
      />
      <CardBody>
        {disk ? (
          <ServiceLine
            tone={levelTone(disk.level)}
            name={`Disk ${disk.model || disk.device}`}
            detail={diskFacts.join(", ")}
            right={<span>{disk.at ? `read ${fmtAge(disk.at)} ago` : ""}</span>}
          >
            {disk.problems.map((problem) => (
              <p key={problem} className={`m-0 mt-1 text-[12px] ${disk.level === "crit" ? "text-bad" : "text-warn"}`}>
                {problem}
              </p>
            ))}
            {diskHistory.length ? <p className="m-0 mt-1 text-[12px] text-mute">{diskHistory.join(", ")}</p> : null}
          </ServiceLine>
        ) : (
          <ServiceLine tone="off" name="Disk" detail="the disk check has not reported on this box" />
        )}
        {backup ? (
          <ServiceLine
            tone={levelTone(backup.level)}
            name={`Backup to ${backup.target || "its target"}`}
            detail={backup.lastResult ? `last attempt ${backup.lastResult}` : ""}
            right={<span>{backup.lastSuccessAt ? `snapshot ${fmtAge(backup.lastSuccessAt)} ago` : "no snapshot yet"}</span>}
          >
            {backup.problems.map((problem) => (
              <p key={problem} className="m-0 mt-1 text-[12px] text-warn">
                {problem}
              </p>
            ))}
          </ServiceLine>
        ) : (
          <ServiceLine tone="off" name="Backup" detail="the backup job has not reported on this box" />
        )}
      </CardBody>
    </Card>
  );
}

function ServiceRowLine({ row }: { row: ServiceRow }) {
  const run = useOpRunner();
  const restartKey = useOpKey(row.id);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function toggleLogs(): Promise<void> {
    if (lines) return setLines(null);
    setBusy(true);
    try {
      const payload = await api.serviceLogs(row.id, 50);
      setLines(payload.lines);
    } catch (error) {
      setLines([`logs unavailable: ${error instanceof Error ? error.message : "error"}`]);
    } finally {
      setBusy(false);
    }
  }

  async function restart(): Promise<void> {
    setConfirming(false);
    setBusy(true);
    try {
      const result = await run(`restart ${row.id}`, () => api.serviceRestart(row.id, restartKey.current()));
      if (result.ok) {
        restartKey.reset();
        toastInfo(`${row.label} restarting`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ServiceLine
      tone={serviceTone(row)}
      name={row.label}
      detail={`${row.kind} ${row.state}${row.detail ? `, ${row.detail}` : ""}${row.restarts ? `, ${row.restarts} restarts` : ""}`}
      right={
        <>
          {row.since ? <span>{fmtAge(row.since)}</span> : null}
          {row.logs ? (
            <Button size="sm" disabled={busy} onClick={() => void toggleLogs()}>
              {lines ? "Hide" : "Logs"}
            </Button>
          ) : null}
          {row.restartable ? (
            confirming ? (
              <>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void restart()}>
                  Confirm restart
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  cancel
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                Restart
              </Button>
            )
          ) : null}
        </>
      }
    >
      {lines ? (
        <pre className="hq-scroll mt-1.5 mb-0 max-h-56 overflow-auto rounded-sub border border-line bg-code px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink">
          {lines.length ? lines.join("\n") : "(no lines)"}
        </pre>
      ) : null}
    </ServiceLine>
  );
}

function ProgramsCard({ report }: { report: ServicesReport | null }) {
  const rows = report?.services ?? [];
  return (
    <Card>
      <CardHead
        title="Programs"
        chip={
          report?.servicesError ? (
            <Chip tone="bad">policy invalid</Chip>
          ) : (
            <Chip tone="mute">{rows.length ? `${rows.length} allowlisted` : "no allowlist yet"}</Chip>
          )
        }
      />
      <CardBody>
        {report?.servicesError ? (
          <p className="m-0 text-[13px] text-bad">{report.servicesError}</p>
        ) : rows.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">
            No services allowlisted. Seed <span className="font-mono">ops/projects/console/services.json</span>{" "}
            (guard-protected: the owner edits it, agents cannot).
          </p>
        ) : (
          rows.map((row) => <ServiceRowLine key={row.id} row={row} />)
        )}
      </CardBody>
    </Card>
  );
}

function JobLine({ row }: { row: JobRow }) {
  return (
    <ServiceLine
      tone={jobTone(row)}
      name={row.label}
      detail={jobDetail(row)}
      right={<span>{row.lastRun ? `${fmtAge(row.lastRun)} ago` : "never"}</span>}
    />
  );
}

function AutomationsCard({ report }: { report: ServicesReport | null }) {
  const run = useOpRunner();
  const disabledKey = useOpKey(`disabled:${!(report?.automations.mail.flags.disabled ?? false)}`);
  const logOnlyKey = useOpKey(`log-only:${!(report?.automations.mail.flags.logOnly ?? false)}`);
  const [busy, setBusy] = useState<string | null>(null);
  const mail = report?.automations.mail ?? null;
  const jobs = report?.jobs ?? [];

  async function toggle(sw: "disabled" | "log-only", on: boolean): Promise<void> {
    setBusy(sw);
    const key = sw === "disabled" ? disabledKey : logOnlyKey;
    try {
      const result = await run(`mail ${sw} ${on ? "on" : "off"}`, () => api.mailSwitch(sw, on, key.current()));
      if (result.ok) {
        key.reset();
        toastInfo(`hq-mail ${sw} is now ${on ? "on" : "off"}`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHead
        title="Automations"
        chip={
          report?.jobsError ? (
            <Chip tone="bad">jobs policy invalid</Chip>
          ) : (
            <Chip tone="mute">{jobs.length ? `${jobs.length} jobs` : "no jobs registry yet"}</Chip>
          )
        }
      />
      <CardBody>
        {mail ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-mute">hq-mail kill switches:</span>
            <Chip tone={mail.flags.disabled ? "bad" : "ok"}>{mail.flags.disabled ? "DISABLED" : "enabled"}</Chip>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void toggle("disabled", !mail.flags.disabled)}
            >
              {mail.flags.disabled ? "Enable" : "Disable"}
            </Button>
            <Chip tone={mail.flags.logOnly ? "warn" : "mute"}>{mail.flags.logOnly ? "LOG_ONLY" : "acting"}</Chip>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void toggle("log-only", !mail.flags.logOnly)}
            >
              {mail.flags.logOnly ? "Act" : "Log only"}
            </Button>
          </div>
        ) : null}
        {report?.jobsError ? <p className="m-0 mb-1 text-[13px] text-bad">{report.jobsError}</p> : null}
        {jobs.map((row) => (
          <JobLine key={row.id} row={row} />
        ))}
        {mail && mail.heartbeats.length > 0 ? (
          <div className="mt-2">
            {mail.heartbeats.map((h) => (
              <ServiceLine
                key={h.id}
                tone={h.state === "ok" ? "ok" : h.state === "stale" ? "bad" : "warn"}
                name={h.id}
                detail={h.state}
                right={<span>{h.lastRun ? `${fmtAge(h.lastRun)} ago` : "never"}</span>}
              />
            ))}
          </div>
        ) : null}
        {!report ? (
          <p className="m-0 text-[13px] text-mute">The services collector has not reported yet.</p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function CollectorsCard({ collectors }: { collectors: CollectorStatus[] }) {
  const failing = collectors.filter((collector) => collector.error !== null);
  return (
    <Card>
      <CardHead
        title="Collectors"
        chip={
          <Chip tone={failing.length === 0 ? "ok" : "warn"}>
            {collectors.length - failing.length}/{collectors.length} healthy
          </Chip>
        }
      />
      <CardBody>
        {collectors.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">No collector has reported yet.</p>
        ) : (
          collectors.map((collector) => (
            <ServiceLine
              key={collector.name}
              tone={collector.error ? "bad" : "ok"}
              name={collector.name}
              detail={collector.error ?? `ttl ${collector.ttlS}s`}
              right={<span>{fmtAge(collector.updatedAt)}</span>}
            />
          ))
        )}
      </CardBody>
    </Card>
  );
}

function MonitorsCard({ report }: { report: MonitorsReport | null }) {
  const rows = report?.monitors ?? [];
  const down = rows.filter((m) => m.state === "down").length;
  return (
    <Card>
      <CardHead
        title="Monitors"
        chip={
          report?.error ? (
            <Chip tone="warn">unavailable</Chip>
          ) : rows.length === 0 ? (
            <Chip tone="mute">none</Chip>
          ) : (
            <Chip tone={down ? "bad" : "ok"}>{down ? `${down} down` : `${rows.length} up`}</Chip>
          )
        }
        actions={
          safeLink(report?.source ?? null) ? (
            <a
              className="text-[12px] text-mute no-underline hover:text-ink"
              href={safeLink(report?.source ?? null) as string}
              target="_blank"
              rel="noreferrer noopener"
            >
              status page
            </a>
          ) : null
        }
      />
      <CardBody>
        {report?.error ? (
          <p className="m-0 text-[13px] text-mute">Uptime Kuma: {report.error}</p>
        ) : rows.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">No monitors on the status page yet.</p>
        ) : (
          rows.map((m) => (
            <ServiceLine
              key={m.id}
              tone={m.state === "up" ? "ok" : m.state === "down" ? "bad" : m.state === "maintenance" ? "warn" : "off"}
              name={m.name}
              detail={[m.group, m.state, m.uptime24 !== null ? `${m.uptime24}% 24h` : null].filter(Boolean).join(", ")}
              right={<span>{m.pingMs !== null ? `${m.pingMs} ms` : ""}</span>}
            />
          ))
        )}
      </CardBody>
    </Card>
  );
}

function DeploysCard({ report }: { report: DeploysReport | null }) {
  const rows = report?.deploys ?? [];
  const unconfigured = (report?.providers ?? []).filter((p) => !p.configured).map((p) => p.provider);
  const failing = (report?.providers ?? []).filter((p) => p.error);
  return (
    <Card>
      <CardHead
        title="Deploys"
        chip={<Chip tone={rows.some((d) => d.state === "failed") ? "bad" : rows.length ? "ok" : "mute"}>{rows.length ? `${rows.length} tracked` : "none"}</Chip>}
      />
      <CardBody>
        {rows.map((d) => (
          <ServiceLine
            key={d.id}
            tone={d.state === "ok" ? "ok" : d.state === "failed" ? "bad" : d.state === "building" ? "warn" : "off"}
            name={d.name}
            detail={[d.provider, d.detail].filter(Boolean).join(", ")}
            right={<span>{d.at ? `${fmtAge(d.at)} ago` : ""}</span>}
          />
        ))}
        {failing.map((p) => (
          <p key={p.provider} className="m-0 mt-1 text-[12px] text-bad">
            {p.provider}: {p.error}
          </p>
        ))}
        {(report?.providers ?? []).filter((p) => p.partial).map((p) => (
          <p key={`${p.provider}-partial`} className="m-0 mt-1 text-[12px] text-warn">
            {p.provider}: partial data, not every item was listed
          </p>
        ))}
        {unconfigured.length > 0 ? (
          <p className="m-0 mt-1 text-[12px] text-mute">
            no token configured: {unconfigured.join(", ")}
          </p>
        ) : null}
        {!report ? <p className="m-0 text-[13px] text-mute">The deploys collector has not reported yet.</p> : null}
      </CardBody>
    </Card>
  );
}

export function MachinesTab({
  machine,
  collectors,
  services,
  monitors,
  deploys,
}: {
  machine: MachineSnapshot | null;
  collectors: CollectorStatus[];
  services: ServicesReport | null;
  monitors: MonitorsReport | null;
  deploys: DeploysReport | null;
}) {
  return (
    <>
      <PageHeader title="Machines" />
      <div className="grid gap-4 xl:grid-cols-3">
        <HardwareCard machine={machine} />
        <CollectorsCard collectors={collectors} />
        <AutomationsCard report={services} />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <ProgramsCard report={services} />
        <HealthCard health={machine?.health ?? null} />
        <MonitorsCard report={monitors} />
        <DeploysCard report={deploys} />
      </div>
    </>
  );
}
