// Beads list for one project: the ledger, filtered. Status comes from the server (the
// route takes ?status=), label and epic filter client side because both are already in
// the payload and a round trip per chip would be silly.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Bead } from "@shared/api";
import { Button, ButtonRow, Chip, Table, TableWrap, Td, Th } from "../ui/primitives";
import { fmtDate } from "../ui/format";
import { errorText, projectsApi } from "./api";
import { useAsync } from "./useAsync";

export type StatusFilter = Bead["status"] | "all";

const STATUS_FILTERS: StatusFilter[] = ["all", "open", "in_progress", "blocked", "closed"];

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All",
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
  deferred: "Deferred",
};

const STATUS_TONE: Record<Bead["status"], "ok" | "warn" | "bad" | "accent" | "mute"> = {
  open: "mute",
  in_progress: "accent",
  blocked: "bad",
  closed: "ok",
  deferred: "warn",
};

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Copy ${id}`}
      onClick={() => {
        const write = navigator?.clipboard?.writeText?.(id);
        if (write) {
          void write.then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "copied" : "copy id"}
    </Button>
  );
}

function BeadRow({ bead, startOpen }: { bead: Bead; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (startOpen) ref.current?.scrollIntoView?.({ block: "center" });
  }, [startOpen]);
  return (
    <>
      <tr ref={ref} data-bead={bead.id} className="cursor-pointer hover:bg-panel2" onClick={() => setOpen((value) => !value)}>
        <Td>
          <span className="font-mono text-[12px]">{bead.id}</span>
        </Td>
        <Td>
          <span className="mr-1.5 text-faint">{open ? "-" : "+"}</span>
          {bead.title}
        </Td>
        <Td>
          <Chip tone={STATUS_TONE[bead.status]}>{bead.status.replace("_", " ")}</Chip>
        </Td>
        <Td numeric>{bead.priority}</Td>
        <Td>{bead.due ? fmtDate(bead.due) : ""}</Td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5} className="border-b border-line bg-panel2/40 px-3 py-2 text-[12px]">
            <div className="grid gap-1">
              <span>
                <b>{bead.title}</b>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {bead.labels.length > 0 ? (
                  bead.labels.map((label) => <Chip key={label}>{label}</Chip>)
                ) : (
                  <span className="text-mute">no labels</span>
                )}
              </span>
              <span className="text-mute">
                type {bead.type}
                {bead.parent ? `, epic ${bead.parent}` : ""}
                {bead.assignee ? `, owner ${bead.assignee}` : ""}
              </span>
              <span className="text-mute">
                deps: {bead.deps.length > 0 ? bead.deps.join(", ") : "none"}
              </span>
              <span className="text-mute">
                due {bead.due ? bead.due.slice(0, 10) : "none"}, estimate{" "}
                {bead.estimateMin === null ? "none" : `${bead.estimateMin} min`}
                {bead.deferUntil ? `, deferred to ${bead.deferUntil.slice(0, 10)}` : ""}
              </span>
              <ButtonRow>
                <CopyId id={bead.id} />
              </ButtonRow>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function BeadsList({
  project,
  initialStatus = "all",
  initialLabel = null,
  openBead = null,
  onClose,
}: {
  project: string;
  initialStatus?: StatusFilter;
  initialLabel?: string | null;
  /** Id of a bead to show expanded and scrolled into view (from a /beads/ link). */
  openBead?: string | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [label, setLabel] = useState<string | null>(initialLabel);
  const [epic, setEpic] = useState<string | null>(null);
  const { data, error, loading } = useAsync(
    (signal) => projectsApi.beads(project, status === "all" ? undefined : status, signal),
    `${project}:beads:${status}`,
  );

  const beads = useMemo(() => data ?? [], [data]);
  const labels = useMemo(
    () => [...new Set(beads.flatMap((bead) => bead.labels))].sort((a, b) => a.localeCompare(b)),
    [beads],
  );
  const epics = useMemo(
    () => [...new Set(beads.map((bead) => bead.parent).filter((value): value is string => value !== null))].sort(),
    [beads],
  );
  const shown = beads.filter(
    (bead) => (label === null || bead.labels.includes(label)) && (epic === null || bead.parent === epic),
  );

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <ButtonRow>
          {STATUS_FILTERS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === status ? "primary" : "default"}
              onClick={() => setStatus(option)}
            >
              {STATUS_LABELS[option]}
            </Button>
          ))}
        </ButtonRow>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      {labels.length > 0 || epics.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3.5 py-2 text-[11px]">
          <span className="text-mute">label</span>
          <Button size="sm" variant={label === null ? "primary" : "default"} onClick={() => setLabel(null)}>
            any
          </Button>
          {labels.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={label === option ? "primary" : "default"}
              onClick={() => setLabel(option)}
            >
              {option}
            </Button>
          ))}
          {epics.length > 0 ? (
            <>
              <span className="ml-2 text-mute">epic</span>
              <Button size="sm" variant={epic === null ? "primary" : "default"} onClick={() => setEpic(null)}>
                any
              </Button>
              {epics.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={epic === option ? "primary" : "default"}
                  onClick={() => setEpic(option)}
                >
                  {option}
                </Button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="px-1 py-1">
        {loading ? <p className="px-2.5 py-2 text-[12px] text-mute">Loading beads.</p> : null}
        {error ? <p className="px-2.5 py-2 text-[12px] text-bad">Could not list beads. {errorText(error)}</p> : null}
        {!loading && !error && shown.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-mute">Nothing matches this filter.</p>
        ) : null}
        {shown.length > 0 ? (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Id</Th>
                  <Th>Title</Th>
                  <Th>Status</Th>
                  <Th numeric>P</Th>
                  <Th>Due</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((bead) => (
                  <BeadRow key={bead.id} bead={bead} startOpen={bead.id === openBead} />
                ))}
              </tbody>
            </Table>
          </TableWrap>
        ) : null}
      </div>
    </div>
  );
}
