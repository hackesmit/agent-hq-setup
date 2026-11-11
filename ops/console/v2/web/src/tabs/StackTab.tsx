// Stack: inventory and evidence, live from the collector (design 4.3, bead
// hq-fn4n). Windows are applied server-side by record timestamp; this tab only
// picks which one to show. Verdicts are hints: the keep/revert buttons file
// the decision onto the acquisition bead (or a new stack-verdict bead), and a
// revert never executes anything from here.

import { useMemo, useState } from "react";
import type { FlowReport, StackItem, StackReport, UnderstudyReport } from "@shared/api";
import { api } from "../data/client";
import { useOpRunner } from "../now/ops";
import { toastInfo } from "../now/toast";
import { Button, Card, CardBody, CardHead, Chip, PageHeader, StatTile, Table, TableWrap, Td, Th, cx } from "../ui/primitives";
import { fmtAge } from "../ui/format";
import { KIND_LABEL, VERDICT_TONE, fmtTokens, kindsOf, pendingDecisions, signalOf, sortedItems, type StackWindow } from "../stack/model";
import { evaluationBody, evaluationTitle } from "../stack/evaluate";
import { FlowPanel } from "../stack/FlowPanel";
import { UnderstudyPanel } from "../stack/UnderstudyPanel";

const WINDOWS: StackWindow[] = ["7", "30", "90"];

function Row({
  item,
  window,
  now,
  picked,
  onPick,
}: {
  item: StackItem;
  window: StackWindow;
  now: number;
  picked: boolean;
  onPick: (id: string) => void;
}) {
  const run = useOpRunner();
  const [busy, setBusy] = useState<null | "keep" | "revert">(null);
  const [decided, setDecided] = useState<string | null>(null);
  const w = item.windows[window];
  const bead = item.acquisitions[0]?.id ?? null;

  async function decide(decision: "keep" | "revert"): Promise<void> {
    setBusy(decision);
    try {
      const call = decision === "keep" ? api.stackKeep : api.stackRevert;
      const result = await run(`${decision} ${item.name}`, () => call(item.id, bead));
      if (result.ok) {
        setDecided(decision);
        toastInfo(bead ? `${decision} noted on ${bead}` : `${decision} filed as a stack-verdict bead`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <tr className={cx(item.verdictHint === "stale" && "bg-bad/5")}>
      <Td>
        <label className="sr-only" htmlFor={`pick-${item.id}`}>
          Evaluate how we use {item.name}
        </label>
        <input
          id={`pick-${item.id}`}
          type="checkbox"
          className="h-4 w-4 align-middle accent-[var(--accent)]"
          checked={picked}
          onChange={() => onPick(item.id)}
          title={`Include ${item.name} in a usage evaluation`}
        />
      </Td>
      <Td>
        <span className="font-mono text-[12px]" title={item.id}>
          {item.name}
        </span>
        {item.acquisitions.length > 0 ? (
          <span className="mt-0.5 block text-[11px] text-mute" title={item.acquisitions.map((a) => a.title).join("; ")}>
            {item.acquisitions.map((a) => a.id).join(", ")}
          </span>
        ) : null}
      </Td>
      <Td>
        <Chip tone="mute">{KIND_LABEL[item.kind]}</Chip>
      </Td>
      <Td numeric>{w.uses}</Td>
      <Td numeric>{w.sessions}</Td>
      <Td numeric>{item.tokens90 > 0 ? fmtTokens(item.tokens90) : ""}</Td>
      <Td>{item.lastUsed ? `${fmtAge(item.lastUsed, now)} ago` : item.unstamped > 0 ? "all-time only" : "never"}</Td>
      <Td>
        <span className="block max-w-[40ch] truncate" title={signalOf(item, window)}>
          {signalOf(item, window)}
        </span>
      </Td>
      <Td>
        <Chip tone={VERDICT_TONE[item.verdictHint]}>{item.verdictHint}</Chip>
      </Td>
      <Td>
        {decided ? (
          <Chip tone={decided === "keep" ? "ok" : "warn"}>{decided} filed</Chip>
        ) : (
          <span className="flex gap-1">
            <Button size="sm" disabled={busy !== null} onClick={() => void decide("keep")}>
              Keep
            </Button>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void decide("revert")}>
              Revert
            </Button>
          </span>
        )}
      </Td>
    </tr>
  );
}

export function StackTab({
  stack,
  flow,
  understudy,
}: {
  stack: StackReport | null;
  flow?: FlowReport | null;
  understudy?: UnderstudyReport | null;
}) {
  const [window, setWindow] = useState<StackWindow>("30");
  const [kind, setKind] = useState("");
  const now = Date.now();

  const rows = useMemo(() => sortedItems(stack, window, kind), [stack, window, kind]);
  // Which capabilities to evaluate together. One bead for the selection rather
  // than one per item: the interesting answers are comparative ("we reach for
  // Bash where Read would do"), and separate beads cannot make that observation.
  const [picked, setPicked] = useState<string[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const evalRun = useOpRunner();
  const togglePick = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const pickedItems = useMemo(
    () => (stack?.items ?? []).filter((item) => picked.includes(item.id)),
    [stack, picked],
  );

  function evaluate(): void {
    if (pickedItems.length === 0) return;
    setEvaluating(true);
    void evalRun("stack evaluation", () =>
      api
        .capture("hq", evaluationTitle(pickedItems), evaluationBody(pickedItems))
        .finally(() => setEvaluating(false)),
    ).then((result) => {
      if (result.ok) {
        toastInfo(`Filed an evaluation of ${pickedItems.length} capabilit${pickedItems.length === 1 ? "y" : "ies"}; work it in a terminal.`);
        setPicked([]);
      }
    });
  }
  const kinds = useMemo(() => kindsOf(stack), [stack]);
  const pending = pendingDecisions(stack);
  const used = stack ? stack.items.filter((item) => item.windows[window].uses > 0).length : 0;
  const blocks = stack ? stack.items.reduce((n, item) => n + item.blocks90, 0) : 0;

  return (
    <>
      <PageHeader
        title="Stack"
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Items tracked" value={stack ? String(stack.items.length) : "..."} detail="inventory + seen in use" />
        <StatTile label={`Used in ${window}d`} value={stack ? String(used) : "..."} detail="at least one call" />
        <StatTile label="Hook blocks, 90d" value={stack ? String(blocks) : "..."} detail="friction vs catch: read the reasons" />
        <StatTile label="Pending decisions" value={stack ? String(pending) : "..."} detail="unused or stale, nothing filed" />
      </div>
      <Card>
        {/* Evaluating is a USAGE review, deliberately separate from the
            keep-or-revert verdict in the table: that asks whether a capability
            should exist, this asks whether the way we use it is any good. */}
        {picked.length > 0 ? (
          <div className="hq-arrive flex flex-wrap items-center gap-2 border-b border-line bg-panel2/60 px-3.5 py-2 text-[12px]">
            <span className="text-mute">
              evaluate how we use <b className="text-ink">{picked.length}</b>{" "}
              {picked.length === 1 ? "capability" : "capabilities"}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute">
              {pickedItems.map((item) => item.name).join(" ")}
            </span>
            <Button size="sm" variant="primary" disabled={evaluating} onClick={evaluate}>
              Evaluate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
              clear
            </Button>
          </div>
        ) : null}
        <CardHead
          title="Inventory and evidence"
          chip={stack ? <Chip tone="mute">generated {fmtAge(stack.generatedAt, now)} ago</Chip> : <Chip tone="mute">loading</Chip>}
          actions={
            <span className="flex items-center gap-1.5">
              {WINDOWS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cx(
                    "rounded-sub px-2 py-0.5 text-[12px]",
                    window === option ? "bg-accent/20 text-accent" : "bg-chip text-mute",
                  )}
                  aria-pressed={window === option}
                  onClick={() => setWindow(option)}
                >
                  {option}d
                </button>
              ))}
              <label className="sr-only" htmlFor="stack-kind">
                Filter by kind
              </label>
              <select
                id="stack-kind"
                className="rounded-sub border border-line bg-panel px-1.5 py-1 text-[12px] text-ink"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="">all kinds</option>
                {kinds.map((option) => (
                  <option key={option} value={option}>
                    {KIND_LABEL[option as StackItem["kind"]] ?? option}
                  </option>
                ))}
              </select>
            </span>
          }
        />
        <CardBody className="px-0 pt-0 pb-0">
          {rows.length === 0 ? (
            <p className="m-0 px-3.5 py-3 text-[13px] text-mute">
              {stack ? "Nothing matches that filter." : "The stack collector has not reported yet (10-minute cadence)."}
            </p>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th />
                    <Th>Item</Th>
                    <Th>Kind</Th>
                    <Th numeric>Uses</Th>
                    <Th numeric>Sessions</Th>
                    <Th numeric>Tokens 90d</Th>
                    <Th>Last used</Th>
                    <Th>Signal</Th>
                    <Th>Verdict</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <Row
                      key={item.id}
                      item={item}
                      window={window}
                      now={now}
                      picked={picked.includes(item.id)}
                      onPick={togglePick}
                    />
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </CardBody>
      </Card>
      {/* Flow rides the same window picker as the table above: one idea of
          "recent" per screen. */}
      <FlowPanel flow={flow ?? null} window={window} />
      {/* The stack watching the owner back: the shadow predictor's scores. */}
      <UnderstudyPanel understudy={understudy ?? null} />
    </>
  );
}
