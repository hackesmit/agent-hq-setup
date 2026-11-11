// Review of the size fix (2026-10-20): after another view resized the shared
// PTY, this pane refitting to its own width must reach the runner, not be
// skipped as a repeat of what it last sent.
import { test, expect } from "vitest";
import { consoleLink } from "../data/ws";

test("after a term.size from another view, this pane refitting to its own size reaches the runner", () => {
  const link: any = consoleLink;
  const sent: any[] = [];
  link.send = (m: any) => { sent.push(m); return true; };
  // Pane A: fits 104x25 (the xterm stand-in tracks what Terminal.tsx would do)
  const xterm = { cols: 104, rows: 25 };
  consoleLink.attachTerm("s1", xterm.cols, xterm.rows, {
    onSize: (c, r) => { xterm.cols = c; xterm.rows = r; }, // Terminal.tsx: term.resize(c, r)
  });
  // Another view resized the shared PTY to 109x25
  link.handle(JSON.stringify({ t: "term.size", sid: "s1", cols: 109, rows: 25 }));
  expect(xterm.cols).toBe(109);
  // Pane A gets focus / visibility: refitIfReal -> fit.fit() back to 104, resizeTerm(104,25)
  sent.length = 0;
  xterm.cols = 104;
  consoleLink.resizeTerm("s1", xterm.cols, xterm.rows);
  // Now xterm is at 104 and the PTY is still at 109 unless a resize went out
  expect(sent.filter((m) => m.t === "term.resize")).toHaveLength(1);
});
