import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReportDetail } from "@shared/api";
import { formatValue, niceTicks, parseChart, parseKeypoints, seriesColor, splitReport, splitTag } from "./blocks";
import { ReportBody } from "./ReportBody";

const SPEC = { type: "bar", title: "Spend", labels: ["Aug", "Sep"], series: [{ name: "API", values: [3, 5] }], unit: "$" };

function report(body_md: string): ReportDetail {
  return {
    id: "r1",
    kind: "digest",
    title: "t",
    project: "hq",
    created: "2026-10-30T00:00:00Z",
    severity: "P2",
    source: "report.md",
    hasHtml: false,
    read: false,
    body_md,
    body_html: null,
  } as unknown as ReportDetail;
}

const render = (md: string) => renderToStaticMarkup(createElement(ReportBody, { report: report(md) }));
const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

describe("parseChart", () => {
  it("accepts every chart type and resolves default colors from the ramp", () => {
    for (const type of ["bar", "hbar", "stacked", "line"]) {
      const spec = parseChart(JSON.stringify({ ...SPEC, type }));
      expect(spec?.type).toBe(type);
      expect(spec?.series[0]!.color).toBe("var(--cat-1)");
      expect(spec?.unit).toBe("$");
    }
    expect(parseChart(JSON.stringify({ ...SPEC, type: "donut" }))?.type).toBe("donut");
  });
  it("returns null for malformed or off-shape specs, never throws", () => {
    const bad = [
      "{not json",
      "[]",
      "null",
      JSON.stringify({ ...SPEC, type: "pie" }),
      JSON.stringify({ ...SPEC, labels: [] }),
      JSON.stringify({ ...SPEC, series: [] }),
      JSON.stringify({ ...SPEC, series: [{ name: "x", values: [1] }] }), // length mismatch
      JSON.stringify({ ...SPEC, series: [{ name: "x", values: [1, "2"] }] }),
      JSON.stringify({ ...SPEC, series: [{ name: "x", values: [1, null] }] }),
      JSON.stringify({ ...SPEC, type: "stacked", series: [{ name: "x", values: [1, -2] }] }),
      JSON.stringify({ ...SPEC, type: "donut", series: [{ name: "a", values: [1, 2] }, { name: "b", values: [1, 2] }] }),
      JSON.stringify({ ...SPEC, labels: [{}, "b"] }),
      "x".repeat(30_000),
    ];
    for (const source of bad) expect(() => parseChart(source)).not.toThrow();
    for (const source of bad) expect(parseChart(source)).toBeNull();
  });
  it("only takes token names or a hex for a color, so a spec cannot reach url()", () => {
    expect(seriesColor("url(https://evil.example/x)", 0)).toBe("var(--cat-1)");
    expect(seriesColor("red;background:url(x)", 1)).toBe("var(--cat-2)");
    expect(seriesColor("var(--x)", 2)).toBe("var(--cat-3)");
    expect(seriesColor("good", 0)).toBe("var(--ok)");
    expect(seriesColor("cat-4", 0)).toBe("var(--cat-4)");
    expect(seriesColor("#A1b2C3", 0)).toBe("#a1b2c3");
  });
});

describe("keypoints and tags", () => {
  it("reads one point per line with an optional tag and list marker", () => {
    expect(parseKeypoints("- [good] tests pass\n\n* [WARN] slow build\n3. plain point\n[bad]\n[info] fyi")).toEqual([
      { tone: "good", text: "tests pass" },
      { tone: "warn", text: "slow build" },
      { tone: null, text: "plain point" },
      { tone: "info", text: "fyi" },
    ]);
  });
  it("splits a tag only at the start", () => {
    expect(splitTag("[bad] down 4%")).toEqual({ tone: "bad", text: "down 4%" });
    expect(splitTag("ok [bad]")).toEqual({ tone: null, text: "ok [bad]" });
    expect(splitTag("[nope] x")).toEqual({ tone: null, text: "[nope] x" });
  });
});

describe("splitReport", () => {
  it("hoists keypoints, lifts charts, keeps tables and other fences in order", () => {
    const md = ["# Title", fence("chart", JSON.stringify(SPEC)), "| a | b |", "|---|---|", "| 1 | 2 |", fence("keypoints", "[good] one"), fence("json", JSON.stringify(SPEC))].join("\n");
    const parts = splitReport(md);
    expect(parts.keypoints).toEqual([{ tone: "good", text: "one" }]);
    expect(parts.segments.map((s) => s.t)).toEqual(["md", "chart", "table", "md"]);
    // a json fence that shows a spec is still a code block in the prose
    expect((parts.segments[3] as { text: string }).text).toContain("```json");
  });
  it("turns a malformed chart fence into a code segment", () => {
    const parts = splitReport(fence("chart", "{oops"));
    expect(parts.segments).toEqual([{ t: "code", lang: "chart", text: "{oops" }]);
  });
  it("does not read a chart fence nested inside a longer fence", () => {
    const md = "````md\n" + fence("chart", JSON.stringify(SPEC)) + "\n````";
    expect(splitReport(md).segments.map((s) => s.t)).toEqual(["md"]);
  });
});

describe("axis helpers", () => {
  it("makes round ticks that include zero", () => {
    expect(niceTicks(0, 97)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-3, 7)[0]).toBeLessThanOrEqual(-3);
    expect(niceTicks(-3, 7)).toContain(0);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });
  it("formats with the unit", () => {
    expect(formatValue(12.345, "%")).toBe("12.3%");
    expect(formatValue(25_000, "MXN")).toBe("25K MXN");
    expect(formatValue(3)).toBe("3");
    expect(formatValue(120, "$")).toBe("$120");
    expect(formatValue(-4, "$")).toBe("-$4");
  });
});

describe("ReportBody with the new blocks", () => {
  it("draws each chart type as an inline svg in token colors", () => {
    for (const type of ["bar", "hbar", "stacked", "donut", "line"]) {
      const html = render(fence("chart", JSON.stringify({ ...SPEC, type, series: [{ name: "API", values: [3, 5], color: "warn" }] })));
      expect(html).toContain(`data-chart="${type}"`);
      expect(html).toContain("<svg");
      expect(html).toContain("var(--");
      expect(html).toContain("table view");
    }
  });
  it("falls back to a code block for malformed chart json", () => {
    const html = render("before\n" + fence("chart", '{"type":"bar",'));
    expect(html).toContain("data-chart-error");
    expect(html).toContain("<pre");
    expect(html).not.toContain("<svg");
  });
  it("renders the key points first, as a card, with tone marks", () => {
    const html = render("Intro text\n\n" + fence("keypoints", "[good] green\n[bad] red"));
    expect(html.indexOf("data-keypoints")).toBeLessThan(html.indexOf("Intro text"));
    expect(html).toContain('data-tone="good"');
    expect(html).toContain("var(--bad)");
    expect(html).not.toContain("[good]");
  });
  it("colors a tagged table cell and leaves the rest alone", () => {
    const html = render("| name | state |\n|---|---|\n| api | [warn] slow |\n| db | fine |");
    expect(html).toMatch(/<td class="[^"]*text-warn[^"]*" data-tone="warn">/);
    expect(html).toContain(">slow<");
    expect(html).toContain(">fine</td>");
  });
  it("keeps markup in a spec or a point as text", () => {
    const evil = { ...SPEC, title: "<img src=x onerror=alert(1)>", labels: ["<script>", "b"] };
    const html = render(fence("chart", JSON.stringify(evil)) + "\n" + fence("keypoints", "<b>x</b>"));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x");
  });
  it("keeps prose at a reading measure and tables full width", () => {
    const html = render("Some prose.\n\n| a |\n|---|\n| 1 |");
    expect(html).toContain("max-w-[78ch]");
    expect(html).toMatch(/<table class="my-2 w-full/);
  });
});

describe("hostile sizes (lucy, hq-je3fk.3 round 2)", () => {
  it("rejects values past MAX_ABS_VALUE, including the largest double", () => {
    const spec = '{"type":"bar","labels":["x"],"series":[{"name":"x","values":[1.7976931348623157e308]}]}';
    expect(parseChart(spec)).toBeNull();
  });
  it("niceTicks terminates on a near-max range", () => {
    const t = niceTicks(0, 1.7976931348623157e308);
    expect(t.length).toBeLessThanOrEqual(65);
  });
  it("a million-line code fence and keypoints fence do not throw", () => {
    expect(() => splitReport("```json\n" + "x\n".repeat(1_000_000) + "```")).not.toThrow();
    expect(() => splitReport("```keypoints\n" + "x\n".repeat(1_000_000) + "```")).not.toThrow();
  });
});

describe("hostile sizes round 3 (lucy)", () => {
  it("an oversized keypoints fence renders as one code block, not a card", () => {
    const html = renderToStaticMarkup(createElement(ReportBody, { report: { kind: "stack", source: "x.md", body_html: null, body_md: "```keypoints\n" + "- x\n".repeat(100_000) + "```" } as unknown as ReportDetail }));
    expect((html.match(/<li/g) ?? []).length).toBe(0);
    expect(html).toContain("<pre");
  });
  it("rejects subnormal values", () => {
    expect(parseChart('{"type":"bar","labels":["x"],"series":[{"name":"x","values":[1e-323]}]}')).toBeNull();
  });
});

