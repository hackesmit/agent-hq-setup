// Pop-out favicon: a popped-out terminal tab wears its workspace's colour (the owner, 2026-10-20).
//
// The console's own tab is the yellow dot from index.html. With three or four terminals
// popped out the tab strip is a row of identical yellow dots, so a /term/<sid> tab swaps
// the dot for the same dot in the hue its rig's workspace already has on the Now tab
// (Orbit Acme, agencyco, Lodgeco and the rest). Leaving the route puts the yellow back.
//
// State marks (the owner, 2026-11-03: "when a terminal has a question there is a little
// question mark inside the favicon, when done a checkmark"). The console tab shows the
// aggregate over every live terminal, question > done > working > idle, with the count in
// the title; a pop-out tab shows its own terminal's mark on its workspace colour. Both
// come from cueOf, the same derivation that paints the card borders.

import { useEffect } from "react";
import type { Session } from "@shared/api";
import { cueOf, type TermCue } from "./attention";
import type { Workspace } from "./workspace";

/** The fallback when the sigil token cannot be read (no stylesheet yet, a test DOM). */
const RAMP_FALLBACK = [
  "#6f9dc4", "#4fa695", "#6aa87b", "#9aab5f", "#c9a355", "#cc8b5e",
  "#c47f92", "#b586bd", "#9590cc", "#7f93c4", "#5fa5b5", "#b39a76",
];

const HEX = /^#[0-9a-f]{3,8}$/i;

/** The same circle as public/favicon.svg, filled with `color`, as a data: URL (CSP allows data: images). */
export function dotIcon(color: string): string {
  const fill = HEX.test(color) ? color : "#ffd60a";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${fill}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export type Mark = "question" | "done" | "working" | null;

const YELLOW = "#ffd60a";
const AMBER = "#e7bd45"; // --p1, the question colour
const RED = "#ff5147"; // --bad, the finished border
const INK = "#16130b";

/** The glyph for a mark, drawn as paths (a favicon cannot count on a font). */
function glyph(mark: Mark, stroke: string): string {
  const line = `fill="none" stroke="${stroke}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"`;
  if (mark === "question") {
    return `<path d="M11.2 12.2a4.8 4.8 0 1 1 7.4 4c-1.7 1.1-2.6 2-2.6 3.9" ${line}/><circle cx="16" cy="25" r="2.4" fill="${stroke}"/>`;
  }
  if (mark === "done") return `<path d="M9 16.5l4.8 4.8L23.5 11" ${line}/>`;
  if (mark === "working") return `<circle cx="16" cy="16" r="5" fill="${stroke}"/>`;
  return "";
}

/**
 * The tab icon for a mark. With no fill it uses the console's own colours (yellow, amber
 * for a question, red for done); a pop-out passes its workspace colour and the mark is
 * drawn on that. A plain idle console icon is exactly the dot.
 */
export function markIcon(mark: Mark, fill?: string): string {
  const own = fill === undefined;
  const base = own ? (mark === "question" ? AMBER : mark === "done" ? RED : YELLOW) : HEX.test(fill) ? fill : YELLOW;
  if (!mark) return dotIcon(base);
  const stroke = own && mark === "done" ? "#ffffff" : INK;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${base}"/>${glyph(mark, stroke)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The mark one terminal's cue shows. */
export function cueMark(cue: TermCue | null): Mark {
  return cue === "question" ? "question" : cue === "finished" ? "done" : cue === "working" ? "working" : null;
}

export interface MarkSummary {
  mark: Mark;
  questions: number;
  finished: number;
}

/** The aggregate mark over every terminal: question > done > working > idle. */
export function consoleMark(sessions: readonly Session[], now: number = Date.now()): MarkSummary {
  let questions = 0;
  let finished = 0;
  let working = 0;
  for (const session of sessions) {
    const mark = cueMark(cueOf(session, now));
    if (mark === "question") questions += 1;
    else if (mark === "done") finished += 1;
    else if (mark === "working") working += 1;
  }
  const mark: Mark = questions ? "question" : finished ? "done" : working ? "working" : null;
  return { mark, questions, finished };
}

/** The page title with the count up front: "(2?)" for questions, else "(3 done)". */
export function markTitle(base: string, summary: MarkSummary): string {
  if (summary.questions) return `(${summary.questions}?) ${base}`;
  if (summary.finished) return `(${summary.finished} done) ${base}`;
  return base;
}

/** Swaps the tab icon to `href` while mounted; unmount or null restores the original. */
function useIcon(href: string | null): void {
  useEffect(() => {
    if (href == null || typeof document === "undefined") return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const original = link.getAttribute("href");
    const originalType = link.getAttribute("type");
    link.setAttribute("type", "image/svg+xml");
    link.setAttribute("href", href);
    return () => {
      if (original != null) link.setAttribute("href", original);
      if (originalType != null) link.setAttribute("type", originalType);
    };
  }, [href]);
}

/**
 * The console tab's icon and title follow the terminals. Null sessions (a pop-out window,
 * which marks its own terminal instead) leave both alone.
 */
export function useConsoleFavicon(sessions: readonly Session[] | null, now: number): void {
  const summary = sessions ? consoleMark(sessions, now) : null;
  useIcon(summary && summary.mark ? markIcon(summary.mark) : null);
  const title = summary ? markTitle("", summary) : null;
  useEffect(() => {
    if (title == null || typeof document === "undefined") return;
    const original = document.title;
    document.title = `${title}${original}`;
    return () => {
      document.title = original;
    };
  }, [title]);
}

/** The workspace a rig sits in, or null for a session with no rig. */
export function workspaceForRig(workspaces: readonly Workspace[], rig: string | null | undefined): Workspace | null {
  if (!rig) return null;
  return workspaces.find((workspace) => workspace.rigs.includes(rig)) ?? null;
}

/** The colour of sigil hue N as the page paints it, with the static ramp as a fallback. */
export function hueColor(hue: number): string {
  const fallback = RAMP_FALLBACK[(hue - 1 + RAMP_FALLBACK.length) % RAMP_FALLBACK.length] ?? "#ffd60a";
  if (typeof document === "undefined") return fallback;
  const live = getComputedStyle(document.documentElement).getPropertyValue(`--sigil-${hue}`).trim();
  return HEX.test(live) ? live : fallback;
}

/**
 * While mounted on a pop-out, the tab's icon is a dot of its workspace hue carrying the
 * popped-out terminal's mark; a pop-out whose rig has no workspace gets the console
 * yellow with the mark. Not a pop-out (or unmount) restores the original.
 */
export function useWorkspaceFavicon(hue: number | null, mark: Mark = null, popped: boolean = hue != null): void {
  useIcon(!popped ? null : markIcon(mark, hue == null ? YELLOW : hueColor(hue)));
}
