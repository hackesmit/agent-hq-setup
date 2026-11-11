// The strip at the top of Now: Everything, then one tab per workspace (now/workspace.ts).

import { cx } from "../ui/primitives";
import { EVERYTHING, workspaceCounts, type Scoped, type Workspace } from "./workspace";

function Counts({ asks, live }: { asks: number; live: number }) {
  return (
    <>
      {asks > 0 ? <span className="rounded-sub bg-p1/20 px-1 text-[10px] leading-4 text-p1">{asks}</span> : null}
      {live > 0 ? <span className="text-[10px] text-faint">{live}</span> : null}
    </>
  );
}

export function WorkspaceTabs({
  workspaces,
  current,
  all,
  onPick,
}: {
  workspaces: Workspace[];
  current: Workspace | null;
  all: Scoped;
  onPick: (id: string) => void;
}) {
  if (workspaces.length === 0) return null;
  const tab = "flex shrink-0 items-center gap-1.5 border-0 border-b-2 bg-transparent px-2.5 py-1.5 text-[12px] cursor-pointer min-h-[36px]";
  return (
    <div role="tablist" aria-label="Workspace" className="mb-4 flex gap-0.5 overflow-x-auto border-b border-line">
      <button
        type="button"
        role="tab"
        aria-selected={!current}
        className={cx(tab, !current ? "border-ink text-ink" : "border-transparent text-mute hover:text-ink")}
        onClick={() => onPick(EVERYTHING)}
      >
        Everything
      </button>
      {workspaces.map((workspace) => {
        const active = current?.id === workspace.id;
        const color = `var(--sigil-${workspace.hue})`;
        return (
          <button
            key={workspace.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={workspace.rigs.join(", ") || "nothing on this box yet"}
            className={cx(tab, active ? "text-ink" : "border-transparent text-mute hover:text-ink")}
            style={active ? { borderBottomColor: color, color } : undefined}
            onClick={() => onPick(workspace.id)}
          >
            <span aria-hidden="true" className="inline-block size-2 rounded-full" style={{ background: color }} />
            <span>{workspace.label}</span>
            <Counts {...workspaceCounts(workspace, all)} />
          </button>
        );
      })}
    </div>
  );
}
