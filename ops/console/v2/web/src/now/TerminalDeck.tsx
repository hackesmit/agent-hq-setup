// Where terminals live on the Now tab.
//
// Desktop: up to four pinned panes in a 1, 2 or 4 up grid inside a card. Phone: one
// terminal at a time, full screen over everything else, because a 12 px xterm in a column
// on a phone is unusable (design doc 3, phone breakpoint).
//
// This module is loaded lazily by the Now tab: xterm is the heaviest dependency in the app
// and nothing needs it until a pane is actually opened.

import type { Session } from "@shared/api";
import { Button, ButtonRow, Card, CardBody, CardHead } from "../ui/primitives";
import { TerminalPane } from "./Terminal";
import { useAttentionOrder } from "./attention";
import { TOUCH_SM } from "./ui";

export const PANE_LIMITS = [1, 2, 4] as const;

export function TerminalDeck({
  capability,
  panes,
  paneLimit,
  onPaneLimit,
  onClose,
}: {
  panes: Session[];
  paneLimit: number;
  onPaneLimit: (count: number) => void;
  onClose: (id: string) => void;
  /** Capri only: hands each pane its one-use passkey proof. */
  capability?: (sid: string) => string | undefined;
}) {
  const { ordered, ...holdOrder } = useAttentionOrder(panes);
  return (
    <Card>
      <CardHead
        title="Terminals"
        actions={
          <ButtonRow>
            {PANE_LIMITS.map((count) => (
              <Button
                key={count}
                size="sm"
                className={TOUCH_SM}
                variant={paneLimit === count ? "primary" : "default"}
                aria-pressed={paneLimit === count}
                aria-label={`Show ${count} panes`}
                onClick={() => onPaneLimit(count)}
              >
                {count}
              </Button>
            ))}
          </ButtonRow>
        }
      />
      <CardBody>
        {panes.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">No terminal open.</p>
        ) : (
          <div className={paneLimit > 1 ? "grid gap-2.5 lg:grid-cols-2" : "grid gap-2.5"} {...holdOrder}>
            {ordered.map((session) => (
              <TerminalPane key={session.id} session={session} onClose={onClose} meta={session.kind === "meta"} capability={capability} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Phone: one terminal, full screen, with a way back. */
export function TerminalOverlay({ session, onClose, capability }: { session: Session; onClose: (id: string) => void; capability?: (sid: string) => string | undefined }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg p-2" role="dialog" aria-label={`Terminal ${session.id}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <b className="font-mono text-[13px]">{session.name ?? session.id}</b>
        <Button className="min-h-11 px-3" onClick={() => onClose(session.id)}>
          Back
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPane session={session} fill onClose={onClose} popout={false} meta={session.kind === "meta"} capability={capability} />
      </div>
    </div>
  );
}

/** Pop-out route (/term/<sid>): one terminal, nothing else. */
export function TerminalPage({ session }: { session: Session }) {
  // No capability here on purpose: a pop-out window is a separate attach, so a Capri
  // pane opened this way must earn its own passkey proof rather than inherit one. The
  // server answers "passkey required" and the pane says so.
  return (
    <div className="flex h-[calc(100vh-6rem)] min-h-80 flex-col">
      <TerminalPane session={session} fill popout={false} meta={session.kind === "meta"} />
    </div>
  );
}
