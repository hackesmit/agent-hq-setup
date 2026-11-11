// The Errors tab (bead hq-hsl2.3): which errors arrived, which a fixer is
// working on now, which were fixed (with the Verification receipt), and which
// need the owner.
//
// Data is the `errors` slice (server/src/errors.js), refreshed by the collector
// and pushed over the WebSocket like every other slice. A fixing incident's tmux
// pane attaches inline through the same TerminalPane the Terminals tab uses; the
// server vouches for exactly those pane ids, read-only. They never enter the
// sessions slice, so they do not appear on the Terminals tab.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { importOrReload } from "../app/lazyChunk";
import type { ErrorsReport, FpVolume, Incident, IncidentStatus, Session } from "@shared/api";
import { postJson } from "../data/client";
import { toastError, toastInfo } from "../now/toast";
import { Button, Card, CardBody, CardHead, Chip, type ChipTone, Note, PageHeader, RigSigil, cx } from "../ui/primitives";
import { fmtDuration } from "../ui/format";

const TerminalPane = lazy(importOrReload(async () => ({ default: (await import("../now/Terminal")).TerminalPane })));

interface Section {
  key: string;
  title: string;
  statuses: IncidentStatus[];
  empty: string;
  limit?: number;
}

const SECTIONS: Section[] = [
  { key: "needs", title: "Needs you", statuses: ["escalated"], empty: "Nothing is waiting on you." },
  { key: "fixing", title: "Fixing now", statuses: ["fixing"], empty: "No fixer is running." },
  { key: "watching", title: "Watching", statuses: ["watching"], empty: "Nothing under watch." },
  { key: "fixed", title: "Fixed", statuses: ["fixed"], empty: "No fixed incidents yet.", limit: 20 },
  { key: "logged", title: "Logged", statuses: ["logged", "unknown"], empty: "Nothing logged.", limit: 20 },
  { key: "resolved", title: "Resolved", statuses: ["resolved"], empty: "Nothing resolved yet.", limit: 10 },
];

const STATUS_TONE: Record<IncidentStatus, ChipTone> = {
  escalated: "bad",
  fixing: "accent",
  watching: "warn",
  fixed: "ok",
  logged: "mute",
  resolved: "mute",
  unknown: "warn",
};

/** A Date for epoch seconds, or null when the value cannot be one. */
export function dateOf(tsSec: number | null | undefined): Date | null {
  if (tsSec === null || tsSec === undefined || !Number.isFinite(tsSec)) return null;
  const d = new Date(tsSec * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12 min ago" from epoch seconds. */
export function ago(tsSec: number | null, now: number = Date.now()): string {
  if (!dateOf(tsSec)) return "unknown";
  return `${fmtDuration(Math.max(0, now / 1000 - (tsSec as number)))} ago`;
}

function absTime(tsSec: number | null): string {
  return dateOf(tsSec)?.toLocaleString() ?? "";
}

/** The read-only Session the TerminalPane needs for a fixer pane. */
function paneSession(inc: Incident): Session | null {
  const id = inc.pane?.id;
  if (!id || !inc.pane?.attachable) return null;
  return {
    id,
    kind: "worker",
    rig: inc.project,
    bead: inc.bead,
    model: null,
    branch: null,
    worktree: null,
    state: "running",
    startedAt: (dateOf(inc.fixer?.startedTs) ?? new Date()).toISOString(),
    lastActivityAt: null,
    phases: [],
    wakeAt: null,
    runner: "tmux",
    focusable: false,
    attachable: true,
    writable: false,
    name: `fixer ${inc.id}`,
    task: inc.title,
    turn: null,
    turnAt: null,
  };
}

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="text-[11px] uppercase tracking-[0.05em] text-faint">{label}</span>
      <span className={cx("min-w-0 truncate text-ink", mono && "font-mono text-[12px]")}>{children}</span>
    </span>
  );
}

function IncidentCard({ inc, onResolve, busy }: { inc: Incident; onResolve: (id: string) => void; busy: boolean }) {
  const [attached, setAttached] = useState(false);
  const session = inc.status === "fixing" ? paneSession(inc) : null;
  const logPath = inc.fixer?.logPath ?? null;
  return (
    <div className="border-b border-line px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <RigSigil id={inc.project} size={12} />
            <span className="text-[12px] text-mute">{inc.project ?? "no project"}</span>
            <Chip tone={STATUS_TONE[inc.status]}>{inc.status === "unknown" ? `status ${inc.rawStatus ?? "?"}` : inc.status}</Chip>
            {inc.repeats > 0 ? (
              <Chip tone={inc.status === "watching" ? "warn" : "default"}>
                {inc.repeats} {inc.repeats === 1 ? "repeat" : "repeats"}
              </Chip>
            ) : null}
            {inc.mailPending ? <Chip tone="warn">mail pending</Chip> : null}
          </div>
          <div className="mt-1 text-[14px] font-semibold text-balance text-ink">{inc.title}</div>
          {inc.status === "watching" && inc.policy ? (
            <div className="mt-0.5 text-[12px] text-warn">watching: {inc.policy}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {inc.status === "watching" ? (
            <span className="font-mono text-[20px] font-semibold leading-none text-warn" title="reports folded into this incident">
              x{inc.repeats + 1}
            </span>
          ) : null}
          {session ? (
            <Button size="sm" variant={attached ? "default" : "primary"} onClick={() => setAttached((v) => !v)}>
              {attached ? "Hide pane" : "Watch fixer"}
            </Button>
          ) : null}
          {inc.status !== "resolved" ? (
            <Button size="sm" disabled={busy} onClick={() => onResolve(inc.id)} title="Mark this incident resolved">
              {busy ? "Resolving" : "Resolve"}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <Field label="opened">
          <span title={absTime(inc.openedTs)}>{ago(inc.openedTs)}</span>
        </Field>
        {inc.conditionSinceTs ? (
          <Field label="failing since">
            <span title={absTime(inc.conditionSinceTs)}>{ago(inc.conditionSinceTs)}</span>
          </Field>
        ) : null}
        {inc.lastSeenTs ? <Field label="last seen">{ago(inc.lastSeenTs)}</Field> : null}
        {inc.fp ? <Field label="fp" mono>{inc.fp}</Field> : null}
        <Field label="host">{inc.host ?? "unknown"}</Field>
        {inc.repeats > 0 && inc.lastRepeatTs ? <Field label="last repeat">{ago(inc.lastRepeatTs)}</Field> : null}
        {inc.bead ? <Field label="bead" mono>{inc.bead}</Field> : null}
        {inc.resolvedTs ? <Field label="resolved">{ago(inc.resolvedTs)}</Field> : null}
        {inc.loopdeadAlertTs ? <Field label="loop alert">{ago(inc.loopdeadAlertTs)}</Field> : null}
        {inc.result?.rc !== null && inc.result?.rc !== undefined ? <Field label="rc" mono>{inc.result.rc}</Field> : null}
        <Field label="id" mono>{inc.id}</Field>
      </div>
      {logPath ? (
        <div className="mt-1 text-[12px]">
          <Field label="log" mono>
            <span title={logPath}>{logPath}</span>
          </Field>
        </div>
      ) : null}

      {inc.result && (inc.result.summary || inc.result.receipt) ? (
        <div className="mt-2 rounded-sub border border-line bg-panel2/40 px-2.5 py-1.5 text-[12px]">
          {inc.result.summary ? <p className="m-0 text-ink">{inc.result.summary}</p> : null}
          {inc.result.receipt ? (
            <p className={cx("m-0 font-mono text-[11px]", inc.result.summary && "mt-1", "text-ok")}>{inc.result.receipt}</p>
          ) : null}
        </div>
      ) : null}
      {inc.note ? <Note>{inc.note}</Note> : null}
      {inc.status === "fixing" && !session ? (
        <p className="mt-1.5 mb-0 text-[12px] text-mute">
          Fixer pane not attachable{inc.pane?.reason ? `: ${inc.pane.reason}` : inc.fixer?.tmuxTarget ? "" : ": no tmux target recorded"}
          {inc.fixer?.tmuxTarget ? ` (target ${inc.fixer.tmuxTarget})` : ""}.
        </p>
      ) : null}
      {session && attached ? (
        <div className="mt-2 flex h-[46vh] min-h-64 flex-col">
          <Suspense fallback={<div className="rounded-card border border-line bg-panel px-3.5 py-6 text-center text-[12px] text-mute">loading the terminal</div>}>
            <TerminalPane session={session} fill popout={false} onClose={() => setAttached(false)} />
          </Suspense>
        </div>
      ) : null}
      {inc.body && inc.status !== "resolved" ? (
        <details className="mt-1.5 text-[12px]">
          <summary className="cursor-pointer text-mute hover:text-ink">report</summary>
          <pre className="hq-scroll mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-sub bg-panel2/50 p-2 font-mono text-[11px] text-ink">
            {inc.body}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Bars({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  return (
    <span className="flex h-5 items-end gap-px" role="img" aria-label={`${buckets.reduce((a, b) => a + b, 0)} reports in 24 hours, hourly`}>
      {buckets.map((n, i) => (
        <i
          key={i}
          className={cx("block w-1.5 rounded-[1px]", n > 0 ? "bg-accent" : "bg-panel2")}
          style={{ height: n > 0 ? `${Math.max(18, (n / max) * 100)}%` : "12%" }}
          title={`${n} in hour ${i + 1} of 24`}
        />
      ))}
    </span>
  );
}

function VolumeStrip({ volume }: { volume: ErrorsReport["volume"] }) {
  const rows: FpVolume[] = volume.fps;
  return (
    <Card className="mb-4">
      <CardHead
        title="Last 24 hours by fingerprint"
        chip={<Chip tone="mute">{volume.source === "fp_events" ? "hourly" : volume.source === "fps" ? "last seen only" : "no data"}</Chip>}
      />
      <CardBody className="py-2">
        {volume.error ? <p className="m-0 mb-1 text-[12px] text-bad">mail.db: {volume.error}</p> : null}
        {rows.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">No error reports in the last 24 hours.</p>
        ) : (
          <div className="grid gap-1">
            {rows.map((r) => (
              <div key={r.fp} className="grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-3 text-[12px]">
                <span className="flex min-w-0 items-center gap-1.5" title={`${r.fp}${r.title ? ` - ${r.title}` : ""}`}>
                  <RigSigil id={r.project} size={11} className="shrink-0" />
                  <span className="min-w-0 truncate">
                    <span className="text-mute">{r.project ?? "?"}</span> <span className="text-ink">{r.title ?? r.fp}</span>
                  </span>
                </span>
                {r.buckets ? <Bars buckets={r.buckets} /> : <span className="text-[11px] text-mute">seen {ago(r.lastTs)}</span>}
                <span className="text-right font-mono text-ink">{r.total ?? (r.count !== null ? `${r.count} all` : "-")}</span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function ErrorsTab({ errors }: { errors: ErrorsReport | null }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(id: string): Promise<void> {
    setBusy(id);
    try {
      await postJson(`/api/errors/${encodeURIComponent(id)}/resolve`, {});
      toastInfo(`${id} resolved`);
    } catch (e) {
      toastError(`could not resolve ${id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  if (!errors) {
    return (
      <>
        <PageHeader title="Errors" />
        <Card>
          <CardBody>
            <p className="m-0 text-[13px] text-mute">The errors collector has not answered yet.</p>
          </CardBody>
        </Card>
      </>
    );
  }

  const c = errors.counts;
  const sub =
    `${c.escalated ?? 0} need you, ${c.fixing ?? 0} fixing, ${c.watching ?? 0} watching, ${c.fixed ?? 0} fixed` +
    (errors.dir === "missing" ? ". No incident directory yet." : errors.dir !== "ok" ? `. Incident directory ${errors.dir}.` : ".") +
    (errors.omitted > 0 ? ` ${errors.omitted} older history files not loaded.` : "");

  return (
    <>
      <PageHeader title="Errors" sub={sub} />
      <VolumeStrip volume={errors.volume} />
      {SECTIONS.map((section) => {
        const all = errors.incidents.filter((i) => section.statuses.includes(i.status));
        // The cap is for history only: an incident with a status outside the
        // contract is never hidden behind it.
        const shown = section.limit
          ? [...all.filter((i) => i.status === "unknown"), ...all.filter((i) => i.status !== "unknown").slice(0, section.limit)]
          : all;
        const quiet = all.length === 0 && (section.key === "resolved" || section.key === "logged");
        if (quiet) return null;
        return (
          <Card key={section.key} className={cx("mb-4", section.key === "needs" && all.length > 0 && "border-p1")}>
            <CardHead
              title={section.title}
              chip={all.length > 0 ? <Chip tone={section.key === "needs" ? "bad" : "mute"}>{all.length}</Chip> : null}
            />
            {shown.length === 0 ? (
              <CardBody>
                <p className="m-0 text-[13px] text-mute">{section.empty}</p>
              </CardBody>
            ) : (
              <div>
                {shown.map((inc) => (
                  <IncidentCard key={inc.id} inc={inc} busy={busy === inc.id} onResolve={(id) => void resolve(id)} />
                ))}
                {all.length > shown.length ? (
                  <p className="m-0 px-3.5 py-2 text-[12px] text-mute">{all.length - shown.length} older not shown.</p>
                ) : null}
              </div>
            )}
          </Card>
        );
      })}
      {errors.malformed.length > 0 ? (
        <Card className="mb-4">
          <CardHead title="Unreadable incident files" chip={<Chip tone="warn">{errors.malformed.length}</Chip>} />
          <CardBody className="grid gap-0.5">
            {errors.malformed.map((m) => (
              <span key={m.file} className="text-[12px]">
                <span className="font-mono text-ink">{m.file}</span> <span className="text-mute">{m.error}</span>
              </span>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
