// Recent artifacts (bead hq-7llgp.9): the newest published artifacts, which project built
// each one, and a link to open it. The server reads state/artifacts.jsonl, which a
// PostToolUse hook appends to on every publish, so a new artifact shows within one poll.

import { useEffect, useState } from "react";
import { api } from "../data/client";
import { fmtAge } from "../ui/format";
import { Card, CardHead, Chip, RigSigil } from "../ui/primitives";
import { TOUCH_SM } from "./ui";

export interface ArtifactRow {
  ts: string;
  url: string;
  title: string;
  session: string;
  rig: string;
  bead: string;
}

const POLL_MS = 30_000;

/** Keep only the rows of the selected workspace; null means everything. */
export function scopeArtifacts(rows: ArtifactRow[], rigs: string[] | null): ArtifactRow[] {
  return rigs ? rows.filter((r) => rigs.includes(r.rig)) : rows;
}

export function Artifacts({ rigs, now }: { rigs: string[] | null; now: number }) {
  const [rows, setRows] = useState<ArtifactRow[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .artifacts()
        .then((r) => live && setRows(r))
        .catch(() => {
          /* the link being down is already reported in the top strip */
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const shown = scopeArtifacts(rows, rigs);
  if (shown.length === 0) return null;
  return (
    <Card>
      <CardHead title="Recent artifacts" chip={<Chip tone="mute">{shown.length}</Chip>} />
      <ul className="m-0 list-none p-0">
        {shown.map((a) => (
          <li key={a.url} className="flex items-baseline gap-2 border-b border-line/60 px-3.5 py-1.5 text-[13px] last:border-b-0">
            <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-faint" title={a.ts}>
              {fmtAge(a.ts, now)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <RigSigil id={a.rig} size={12} />
              <Chip tone="mute">{a.rig || "?"}</Chip>
            </span>
            <span className="min-w-0 flex-1">
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`block truncate text-ink underline-offset-2 hover:underline ${TOUCH_SM}`}
                title={a.title || a.url}
              >
                {a.title || a.url.replace("https://claude.ai/artifact/", "")}
              </a>
              <span className="block truncate text-[12px] text-mute">
                {[a.session, a.bead].filter(Boolean).join(" ")}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
