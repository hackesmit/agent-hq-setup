// Read-only viewer for the project's prose: Knowledge.md, the vault hub, DECISIONS.md.
// Fetched through the server (which reads the vault mirror; agents never read the vault
// path directly from the browser) and rendered by the safe renderer in markdown.ts.

import { useState } from "react";
import { Button, ButtonRow, Chip } from "../ui/primitives";
import { fmtAge } from "../ui/format";
import { DOC_LABELS, errorText, projectsApi, type DocName } from "./api";
import { Markdown } from "./Markdown";
import { useAsync } from "./useAsync";

const ORDER: DocName[] = ["knowledge", "hub", "decisions"];

export function DocViewer({
  project,
  available,
  initial,
  onClose,
}: {
  project: string;
  available: { knowledge: boolean; hub: boolean; decisions: boolean };
  initial: DocName;
  onClose: () => void;
}) {
  const [name, setName] = useState<DocName>(initial);
  const { data, error, loading, reload } = useAsync(
    (signal) => projectsApi.doc(project, name, signal),
    `${project}:doc:${name}`,
  );

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <ButtonRow>
          {ORDER.map((doc) => (
            <Button
              key={doc}
              size="sm"
              variant={doc === name ? "primary" : "default"}
              disabled={!available[doc]}
              title={available[doc] ? undefined : "not present in this project"}
              onClick={() => setName(doc)}
            >
              {DOC_LABELS[doc]}
            </Button>
          ))}
        </ButtonRow>
        <ButtonRow>
          {data?.updatedAt ? <Chip tone="mute">{fmtAge(data.updatedAt)} old</Chip> : null}
          <Button size="sm" variant="ghost" onClick={reload}>
            Reload
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </ButtonRow>
      </div>
      <div className="hq-scroll max-h-[60vh] overflow-y-auto px-3.5 py-2">
        {loading ? <p className="m-0 text-[12px] text-mute">Loading {DOC_LABELS[name]}.</p> : null}
        {error ? <p className="m-0 text-[12px] text-bad">Could not read it. {errorText(error)}</p> : null}
        {data ? (
          <>
            <p className="mb-1 mt-0 font-mono text-[11px] text-faint">{data.path}</p>
            <Markdown source={data.markdown} />
          </>
        ) : null}
      </div>
    </div>
  );
}
