// Recent activity for one project: merges from git and session-eval verdicts, on one
// timeline. Both are already in ProjectDetail, so this is a merge and a sort, not a fetch.

import type { ProjectDetail } from "@shared/api";
import { Card, CardBody, CardHead, Chip } from "../ui/primitives";
import { fmtAge } from "../ui/format";

type Entry = {
  at: string;
  kind: "commit" | "eval";
  tone: "ok" | "warn" | "bad" | "mute";
  label: string;
  text: string;
  detail: string | null;
};

const EVAL_TONE: Record<string, "ok" | "warn" | "bad"> = {
  ok: "ok",
  pass: "ok",
  flag: "warn",
  revise: "warn",
  escalate: "bad",
  block: "bad",
};

export function recentEntries(detail: ProjectDetail, limit = 12): Entry[] {
  const commits: Entry[] = detail.commits.map((commit) => ({
    at: commit.at,
    kind: "commit",
    tone: "ok",
    label: commit.sha.slice(0, 7),
    text: commit.subject,
    detail: commit.author,
  }));
  const evals: Entry[] = detail.sessionEval.map((row) => ({
    at: row.at,
    kind: "eval",
    tone: EVAL_TONE[row.verdict.toLowerCase()] ?? "mute",
    label: row.verdict.toLowerCase(),
    text: row.summary,
    detail: row.session,
  }));
  return [...commits, ...evals]
    .filter((entry) => !Number.isNaN(Date.parse(entry.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

export function RecentCard({ detail }: { detail: ProjectDetail }) {
  const entries = recentEntries(detail);
  return (
    <Card>
      <CardHead title="Recent" chip={<Chip tone="mute">git and session-eval</Chip>} />
      <CardBody>
        {detail.error ? <p className="m-0 mb-2 text-[12px] text-bad">Could not read everything. {detail.error}</p> : null}
        {entries.length === 0 ? (
          <p className="m-0 text-[12px] text-mute">
            {detail.error ? "Nothing to show." : "Nothing merged or reviewed yet."}
          </p>
        ) : (
          <ul className="m-0 list-none p-0 text-[12px]">
            {entries.map((entry) => (
              <li
                key={`${entry.kind}-${entry.at}-${entry.label}`}
                className="flex items-start gap-2 border-b border-line py-1 last:border-b-0"
              >
                <Chip tone={entry.tone}>{entry.label}</Chip>
                <span className="min-w-0 flex-1 truncate" title={entry.text}>
                  {entry.text}
                </span>
                <span className="shrink-0 text-faint">{fmtAge(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
