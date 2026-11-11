// The Flow link on a session row, a terminal header and a request card (bead
// hq-c4pl0.3): one click opens the chart of the project that bead belongs to,
// on the bead's epic, with the bead ringed. Renders nothing when no bead or no
// known project, so a meta terminal or a bead-less request shows no dead button.
//
// A real anchor: a plain click navigates in place and a middle or modified click
// opens a new tab. On a terminal header it is target=_blank, so the chart pops out
// beside the terminals instead of replacing them (the same rule as the terminal
// pop-out in Terminal.tsx: never a scripted window.open).

import { navigate } from "../app/router";
import { flowPathFor } from "../app/routes";
import { useConsoleSlice } from "../data/store";

const LINK =
  "hq-press inline-flex items-center rounded-sub border border-transparent px-2 py-0.5 text-[11px] text-mute no-underline hover:bg-panel2 hover:text-ink";

export function FlowLink({
  rig,
  bead,
  newTab = false,
  className,
}: {
  rig: string | null | undefined;
  bead: string | null | undefined;
  /** "Flow" itself opens a new tab: a terminal header, where leaving the page would drop the terminal. */
  newTab?: boolean;
  className?: string;
}) {
  const projectIds = useConsoleSlice((state) => (state?.projects ?? []).map((p) => p.id).join("\n"));
  const href = flowPathFor(projectIds ? projectIds.split("\n") : [], rig, bead);
  if (!href) return null;
  return (
    <span className={className ? `inline-flex items-center ${className}` : "inline-flex items-center"}>
      <a
        href={href}
        className={LINK}
        title={newTab ? `Open the flow chart at ${bead} in a new tab` : `Open the flow chart at ${bead}`}
        {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={(event) => {
          if (newTab) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigate(href);
        }}
      >
        Flow
      </a>
    </span>
  );
}
