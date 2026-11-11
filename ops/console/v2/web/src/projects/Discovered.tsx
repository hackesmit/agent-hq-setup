// Repos on disk the registry has not been told about.
//
// the owner: "It should automatically update when we create new GitHub repos."
//
// It reports rather than adopts, and that is the design rather than a shortcut.
// ops/projects.json is guard-protected, so an agent cannot write it, and it
// should not: a registry an agent can edit is a registry an agent can point
// somewhere else. What the console can remove is the friction, which was never
// the decision but the remembering. So the card hands over a ready-made entry to
// paste, and adopting a repo stays one keystroke that is the owner's.
import { useState } from "react";
import type { DiscoveredReport } from "@shared/api";
import { Button, Card, CardBody, CardHead, Chip, RigSigil } from "../ui/primitives";
import { copyText } from "../now/clipboard";
import { toastInfo } from "../now/toast";

export function Discovered({ report }: { report: DiscoveredReport | null }) {
  const found = report?.found ?? [];
  const missing = report?.missing ?? [];
  const [open, setOpen] = useState<string | null>(null);

  if (found.length === 0 && missing.length === 0) return null;

  return (
    <Card className="mb-4">
      <CardHead
        title="Not in the registry"
        chip={
          found.length > 0 ? (
            <Chip tone="accent">{found.length} found</Chip>
          ) : (
            <Chip tone="warn">{missing.length} missing</Chip>
          )
        }
      />
      <CardBody className="flex flex-col gap-2">
        {found.map((repo) => (
          <div key={repo.id} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <RigSigil id={repo.id} size={12} />
              <span className="text-[13px] text-ink">{repo.id}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute">{repo.path}</span>
              <Button size="sm" onClick={() => setOpen((c) => (c === repo.id ? null : repo.id))}>
                {open === repo.id ? "hide" : "entry"}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  void copyText(repo.snippet);
                  toastInfo(`Copied the entry for ${repo.id}; paste it into ops/projects.json`);
                }}
              >
                Copy
              </Button>
            </div>
            {open === repo.id ? (
              <pre className="hq-scroll m-0 overflow-x-auto rounded-sub bg-code px-2.5 py-2 font-mono text-[11px] text-mute">
                {repo.snippet}
              </pre>
            ) : null}
          </div>
        ))}

        {missing.length > 0 ? (
          <div className="border-t border-line pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-mute">Listed, but not on disk</div>
            {missing.map((repo) => (
              <div key={repo.id} className="flex flex-wrap items-center gap-2 py-0.5">
                <span className="text-[13px] text-ink">{repo.id}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute">{repo.path}</span>
                <Chip tone="warn">path gone</Chip>
              </div>
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
