import { describe, expect, it } from "vitest";
import type { ReportHeader } from "@shared/api";
import {
  beadPath,
  bodyMode,
  findBead,
  groupByDay,
  kindTone,
  listQuery,
  markReadLocally,
  mergePage,
  passes,
  plainBody,
  severityTone,
  unreadText,
} from "./model";
import { MAX_DEPTH, treeFrom, type DomLike } from "./html";
import { splitTables } from "./mdTables";

function header(id: string, created: string, extra: Partial<ReportHeader> = {}): ReportHeader {
  return { id, kind: "error", title: id, project: "hq", created, severity: "P2", source: "gmail", hasHtml: false, read: false, ...extra };
}

describe("groupByDay", () => {
  const now = new Date(2026, 9, 28, 9, 0);
  it("groups newest first by local day with Today and Yesterday labels", () => {
    const items = [
      header("a", new Date(2026, 9, 27, 23, 10).toISOString()),
      header("b", new Date(2026, 9, 28, 8, 0).toISOString()),
      header("c", new Date(2026, 9, 28, 1, 0).toISOString()),
      header("d", new Date(2026, 9, 20, 12, 0).toISOString()),
    ];
    const groups = groupByDay(items, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Tue 20 Oct"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["b", "c"]);
  });
  it("names the year for another year and keeps undated items last", () => {
    const groups = groupByDay([header("x", "nope"), header("y", new Date(2025, 0, 5).toISOString())], now);
    expect(groups.map((g) => g.label)).toEqual(["Sun 5 Jan 2025", "Undated"]);
  });
});

describe("unread summary", () => {
  it("says unavailable when the store cannot be read, never zero", () => {
    expect(unreadText({ total: null, unread: null, error: "EACCES" })).toEqual({ text: "store unavailable", unavailable: true });
    expect(unreadText(null).unavailable).toBe(true);
  });
  it("counts otherwise", () => {
    expect(unreadText({ total: 9, unread: 0 }).text).toBe("all 9 read");
    expect(unreadText({ total: 9, unread: 3 }).text).toBe("3 unread of 9");
  });
});

describe("filters", () => {
  it("builds only the query the server reads", () => {
    expect(listQuery({ kind: null, unread: false })).toBe("?limit=100");
    expect(listQuery({ kind: "digest", unread: true }, 100, 50)).toBe("?kind=digest&unread=1&limit=50&offset=100");
  });
  it("drops a read item from the unread view", () => {
    const item = header("a", "2026-10-28T00:00:00Z", { read: true });
    expect(passes(item, { kind: null, unread: true })).toBe(false);
    expect(passes(item, { kind: "error", unread: false })).toBe(true);
    expect(passes(item, { kind: "digest", unread: false })).toBe(false);
  });
  it("marks read locally and merges pages without duplicates", () => {
    const list = [header("a", "2026-10-28T00:00:00Z"), header("b", "2026-10-27T00:00:00Z", { read: true })];
    expect(markReadLocally(list, "b")).toBe(list);
    expect(markReadLocally(list, "a")[0]!.read).toBe(true);
    expect(mergePage(list, [header("b", "x"), header("c", "x")]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("tones", () => {
  it("maps severity and kind, unknowns stay plain", () => {
    expect(severityTone("P0")).toBe("p0");
    expect(severityTone("info")).toBe("info");
    expect(severityTone("weird")).toBe("info");
    expect(kindTone("error")).toBe("bad");
    expect(kindTone("future-kind")).toBe("default");
  });
});

describe("reading view", () => {
  it("picks html, then markdown for file reports, then plain text", () => {
    expect(bodyMode({ kind: "digest", source: "gmail", body_html: "<p>x</p>" })).toBe("html");
    expect(bodyMode({ kind: "retro", source: "WEEKLY.md", body_html: null })).toBe("markdown");
    expect(bodyMode({ kind: "logged", source: "ops/metrics/x.md", body_html: null })).toBe("markdown");
    expect(bodyMode({ kind: "error", source: "gmail", body_html: null })).toBe("text");
  });
  it("normalizes mail line endings", () => {
    expect(plainBody("a\r\nb\r\n\r\n\r\n\r\nc\r\n")).toBe("a\nb\n\nc");
  });
  it("finds a named or dotted bead id but not a project name", () => {
    expect(findBead("fixer for bead hq-khg4 done")).toBe("hq-khg4");
    expect(findBead("merged hq-o6wn.5 today")).toBe("hq-o6wn.5");
    expect(findBead("hq-vault-bridge MirrorFailed")).toBeNull();
    expect(findBead(null, "Bead: XD-ab12")).toBe("xd-ab12");
    expect(beadPath("acme-avance", "xd-ab12")).toBe("/projects/acme-avance/beads/xd-ab12");
    expect(beadPath("", "hq-ab12")).toBe("/projects/hq/beads/hq-ab12");
  });
});

// ---------- html walker over fake DOM nodes ----------

function text(value: string): DomLike {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] };
}
function el(name: string, attrs: Record<string, string>, ...children: DomLike[]): DomLike {
  return { nodeType: 1, nodeName: name.toUpperCase(), nodeValue: null, childNodes: children, getAttribute: (n) => attrs[n] ?? null };
}

describe("html tree", () => {
  it("keeps allowlisted structure and drops everything else", () => {
    const body = el(
      "body",
      {},
      el("script", {}, text("alert(1)")),
      el("style", {}, text("body{}")),
      el("img", { src: "https://track.example/p.gif" }),
      { nodeType: 8, nodeName: "#comment", nodeValue: "hidden", childNodes: [] },
      el("p", { style: "position:fixed", onclick: "x()", class: "evil" }, text("hi "), el("font", {}, text("there"))),
    );
    expect(treeFrom(body)).toEqual([{ t: "el", tag: "p", attrs: {}, children: [{ t: "text", value: "hi " }, { t: "text", value: "there" }] }]);
  });
  it("keeps only safe links and numeric table spans", () => {
    const body = el(
      "body",
      {},
      el("a", { href: "javascript:alert(1)" }, text("bad")),
      el("a", { href: "https://ok.example/x", target: "_top" }, text("good")),
      el("td", { colspan: "2", rowspan: "x" }),
    );
    const tree = treeFrom(body);
    expect(tree[0]).toEqual({ t: "el", tag: "a", attrs: {}, children: [{ t: "text", value: "bad" }] });
    expect(tree[1]).toEqual({ t: "el", tag: "a", attrs: { href: "https://ok.example/x" }, children: [{ t: "text", value: "good" }] });
    expect(tree[2]).toEqual({ t: "el", tag: "td", attrs: { colspan: "2" }, children: [] });
  });
  it("flattens past the depth cap instead of recursing without end", () => {
    let node: DomLike = text("deep");
    for (let i = 0; i < MAX_DEPTH + 20; i += 1) node = el("div", {}, node);
    const tree = treeFrom(el("body", {}, node));
    let depth = 0;
    let cur = tree[0];
    while (cur && cur.t === "el") {
      depth += 1;
      cur = cur.children[0];
    }
    expect(depth).toBe(MAX_DEPTH);
    expect(cur).toEqual({ t: "text", value: "deep" });
  });
});

describe("markdown tables", () => {
  it("lifts pipe tables out of prose and keeps cells as plain text", () => {
    const src = "# Title\r\n\r\n| tool | calls |\r\n|------|------:|\r\n| `mcp__x__y` | 1742 |\r\n| a \\| b | 2 |\r\n\r\nafter";
    const segs = splitTables(src);
    expect(segs.map((s) => s.t)).toEqual(["md", "table", "md"]);
    expect(segs[1]).toEqual({ t: "table", head: ["tool", "calls"], rows: [["mcp__x__y", "1742"], ["a | b", "2"]] });
  });
  it("leaves tables inside fenced code and pipes without a divider alone", () => {
    expect(splitTables("```\n| a | b |\n|---|---|\n```").map((s) => s.t)).toEqual(["md"]);
    expect(splitTables("| a | b |\nplain").map((s) => s.t)).toEqual(["md"]);
  });
});
