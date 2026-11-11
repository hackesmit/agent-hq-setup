// Snooze and Kill on a terminal pane (the owner, 2026-10-20: "allow me to kill terminals
// from this terminal page, and snooze them"). The same calls, confirm and presets the
// session row uses, so the two places never disagree about what Kill leaves behind.

import { useState, type ReactElement } from "react";
import type { Session } from "@shared/api";
import { api } from "../data/client";
import { Button, ButtonRow } from "../ui/primitives";
import { patchSession, useOpRunner } from "./ops";
import { customSnoozeIso, defaultCustomInput, snoozePresets } from "./snooze";
import { TOUCH_SM } from "./ui";

export function usePaneManage(session: Session): { buttons: ReactElement; panel: ReactElement | null } {
  const run = useOpRunner();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");

  async function act(label: string, fn: () => Promise<unknown>, optimistic: () => void): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    optimistic();
    try {
      return (await run(label, fn)).ok;
    } finally {
      setBusy(false);
    }
  }

  function snooze(iso: string): void {
    void act("snooze", () => api.session(session.id, "snooze", { until: iso }), () =>
      patchSession(session.id, { state: "snoozed", wakeAt: iso }),
    ).then((ok) => {
      if (ok) setOpen(false);
    });
  }

  const buttons = (
    <>
      <Button size="sm" variant="ghost" className={TOUCH_SM} disabled={busy} aria-expanded={open} onClick={() => setOpen(!open)}>
        Snooze
      </Button>
      <Button
        size="sm"
        variant="danger"
        className={TOUCH_SM}
        disabled={busy}
        onClick={() => {
          if (!window.confirm(`Kill ${session.id}? Uncommitted work in its worktree stays on disk.`)) return;
          void act("kill", () => api.session(session.id, "kill"), () => patchSession(session.id, { state: "closed" }));
        }}
      >
        Kill
      </Button>
    </>
  );

  const now = new Date();
  const panel = open ? (
    <div className="border-b border-line bg-panel2/50 px-2.5 py-1.5">
      <ButtonRow>
        <span className="text-[12px] text-mute">wake</span>
        {snoozePresets(now).map((preset) => (
          <Button key={preset.id} size="sm" className={TOUCH_SM} disabled={busy} onClick={() => snooze(preset.iso)}>
            {preset.label}
          </Button>
        ))}
        <input
          type="datetime-local"
          aria-label={`Custom wake time for ${session.id}`}
          className="rounded-sub border border-line bg-panel px-2 py-1 text-[12px] text-ink"
          value={custom || defaultCustomInput(now)}
          onChange={(event) => setCustom(event.target.value)}
        />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const iso = customSnoozeIso(custom || defaultCustomInput(now));
            if (iso) snooze(iso);
          }}
        >
          Set
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          cancel
        </Button>
      </ButtonRow>
    </div>
  ) : null;

  return { buttons, panel };
}
