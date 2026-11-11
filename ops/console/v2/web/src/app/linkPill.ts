// What the top strip says about the link (hq-aukwy). A server restart on every merge
// used to read as the console going offline; now a drop shows one small pill while the
// last good state stays on screen, and a deploy shows a quiet "update ready" button.

import type { LinkStatus } from "../data/wsMachine";
import type { StateSource } from "../data/ws";

export interface LinkPill {
  label: string;
  /** Text tone class. */
  tone: string;
  /** Render as a bordered pill (attention) rather than plain text. */
  pill: boolean;
}

export function linkPill(status: LinkStatus, source: StateSource): LinkPill {
  if (source === "mock") return { label: "mock data", tone: "text-mute", pill: false };
  if (status === "live") return { label: "live", tone: "text-ok", pill: false };
  if (status === "offline") return { label: "offline", tone: "text-bad", pill: true };
  // connecting and polling both mean "the socket is coming back"; polling keeps the
  // data at most 3 s stale meanwhile, so neither is an outage worth more than this.
  return { label: "reconnecting", tone: "text-warn", pill: true };
}
