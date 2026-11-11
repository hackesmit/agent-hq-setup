// Quick capture: an idea becomes a bead without opening a terminal (design doc 4.1).
//
// It creates the bead and nothing else. Refining it into a Definition of Done and
// dispatching it stays a deliberate act, because invariant 5 says no DoD, no dispatch.

import { useState } from "react";
import { api } from "../data/client";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip, inputClass } from "../ui/primitives";
import { parseBeadId } from "./capture";
import { useOpRunner } from "./ops";
import { TOUCH } from "./ui";

export function QuickCapture({ rigs }: { rigs: string[] }) {
  const run = useOpRunner();
  const [rig, setRig] = useState(rigs[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const target = rig || rigs[0] || "";

  async function submit(): Promise<void> {
    const text = title.trim();
    if (!text || !target || busy) return;
    setBusy(true);
    setCreated(null);
    try {
      const result = await run("capture", () => api.capture(target, text, body.trim() || undefined));
      if (!result.ok) return;
      setCreated(parseBeadId(result.op?.output) ?? "new bead");
      setTitle("");
      setBody("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="Quick capture"
        chip={<Chip tone="mute">bd create</Chip>}
        actions={created ? <Chip tone="ok">created {created}</Chip> : null}
      />
      <CardBody>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="sr-only" htmlFor="capture-rig">
              Project
            </label>
            <select
              id="capture-rig"
              className="rounded-sub border border-line bg-panel px-1.5 py-1 text-[12px] text-ink"
              value={target}
              onChange={(event) => setRig(event.target.value)}
            >
              {rigs.length === 0 ? <option value="">no project</option> : null}
              {rigs.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="capture-title">
              Title
            </label>
            <input
              id="capture-title"
              className="min-w-0 flex-1 rounded-sub border border-line bg-panel px-2 py-1.5 text-[13px] text-ink placeholder:text-faint"
              placeholder="One line, what needs doing"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <label className="sr-only" htmlFor="capture-body">
            Detail
          </label>
          <textarea
            id="capture-body"
            className={inputClass}
            rows={2}
            placeholder="Optional detail, context, or the first half of a DoD"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <ButtonRow>
            <Button
              type="submit"
              variant="primary"
              className={TOUCH}
              disabled={busy || title.trim().length === 0 || !target}
            >
              Create bead
            </Button>
            <span className="text-[11px] text-faint">
              Captured, not dispatched: a bead needs a Definition of Done before it goes to a worker.
            </span>
          </ButtonRow>
        </form>
      </CardBody>
    </Card>
  );
}
