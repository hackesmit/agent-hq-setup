import { describe, expect, it } from "vitest";
import { flowPath, flowPathFor, parseRoute, projectPath, reportPath, routePath, tabForKey } from "../app/routes";

describe("parseRoute", () => {
  it("maps the root to Now", () => {
    expect(parseRoute("/")).toEqual({ tab: "now", projectId: null, requestId: null, termSid: null });
    expect(parseRoute("")).toEqual({ tab: "now", projectId: null, requestId: null, termSid: null });
  });

  it("reads each tab", () => {
    for (const tab of ["now", "board", "projects", "stack", "machines", "money"] as const) {
      expect(parseRoute(`/${tab}`).tab).toBe(tab);
    }
  });

  it("reads a project id and decodes it", () => {
    expect(parseRoute("/projects/fintrack-portfolio")).toEqual({
      tab: "projects",
      projectId: "fintrack-portfolio",
      requestId: null,
      termSid: null,
    });
    expect(parseRoute("/term/w-3f2a")).toEqual({ tab: "now", projectId: null, requestId: null, termSid: "w-3f2a" });
    expect(parseRoute("/projects/hq%20mail").projectId).toBe("hq mail");
  });

  it("keeps the deep link to a request card", () => {
    expect(parseRoute("/now?req=r-1187")).toEqual({ tab: "now", projectId: null, requestId: "r-1187", termSid: null });
    expect(parseRoute("/?req=r-9").requestId).toBe("r-9");
    expect(parseRoute("/now?foo=1&req=r-2&bar=3").requestId).toBe("r-2");
    expect(parseRoute("/now?req=").requestId).toBeNull();
  });

  it("tolerates trailing slashes, hashes, extra segments and full urls", () => {
    expect(parseRoute("/projects/")).toEqual({ tab: "projects", projectId: null, requestId: null, termSid: null });
    expect(parseRoute("/projects/chesski/beads").projectId).toBe("chesski");
    expect(parseRoute("/now#top").tab).toBe("now");
    expect(parseRoute("https://hqbox.tail.ts.net:8787/projects/chesski").projectId).toBe("chesski");
  });

  it("falls back to Now for anything unknown", () => {
    expect(parseRoute("/nope").tab).toBe("now");
    expect(parseRoute("/stackoverflow").tab).toBe("now");
    expect(parseRoute("/nope?req=r-3")).toEqual({ tab: "now", projectId: null, requestId: "r-3", termSid: null });
  });

  it("is case insensitive on the tab segment", () => {
    expect(parseRoute("/Money").tab).toBe("money");
  });
});

describe("routePath", () => {
  it("round-trips", () => {
    for (const path of ["/now", "/projects", "/projects/chesski", "/stack", "/machines", "/money"]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
    expect(routePath(parseRoute("/now?req=r-1"))).toBe("/now?req=r-1");
  });

  it("encodes project ids", () => {
    expect(projectPath("hq mail")).toBe("/projects/hq%20mail");
  });
});

describe("report routes", () => {
  it("reads the list and one open report, and round-trips both", () => {
    expect(parseRoute("/reports")).toEqual({ tab: "reports", projectId: null, requestId: null, termSid: null });
    expect(parseRoute("/reports/mail-00d7d2a5d89e6b73").reportId).toBe("mail-00d7d2a5d89e6b73");
    expect(parseRoute("/reports/")).toEqual({ tab: "reports", projectId: null, requestId: null, termSid: null });
    expect(parseRoute("/projects/hq").beadId).toBeUndefined();
    expect(parseRoute("/projects/hq/beads/hq-o6wn.7")).toEqual({
      tab: "projects",
      projectId: "hq",
      requestId: null,
      termSid: null,
      beadId: "hq-o6wn.7",
    });
    expect(routePath(parseRoute("/projects/hq/beads/hq-o6wn.7"))).toBe("/projects/hq/beads/hq-o6wn.7");
    expect(parseRoute("/projects/hq").reportId).toBeUndefined();
    for (const path of ["/reports", "/reports/retro-2026-10-28"]) expect(routePath(parseRoute(path))).toBe(path);
    expect(reportPath("a b")).toBe("/reports/a%20b");
  });
});

describe("tabForKey", () => {
  it("maps the number keys to the tabs in order and ignores anything else", () => {
    // Terminals landed second, so the shortcuts after it all moved along one.
    // Worth pinning rather than asserting a count: the digits are muscle memory.
    expect(tabForKey("1")).toBe("now");
    expect(tabForKey("2")).toBe("terminals");
    expect(tabForKey("3")).toBe("board");
    expect(tabForKey("4")).toBe("projects");
    expect(tabForKey("5")).toBe("stack");
    expect(tabForKey("6")).toBe("machines");
    expect(tabForKey("7")).toBe("money");
    expect(tabForKey("8")).toBe("errors");
    // Reports was appended, so no earlier digit moved.
    expect(tabForKey("9")).toBe("reports");
    expect(tabForKey("0")).toBeNull();
    expect(tabForKey("k")).toBeNull();
    expect(tabForKey("")).toBeNull();
  });
});

describe("flow chart routes", () => {
  it("parses the project chart, an epic and a focus bead", () => {
    expect(parseRoute("/projects/hq/flow")).toEqual({
      tab: "projects",
      projectId: "hq",
      requestId: null,
      termSid: null,
      flow: { epic: null, focus: null, chart: null },
    });
    expect(parseRoute("/projects/hq/flow/hq-c4pl0?focus=hq-c4pl0.3").flow).toEqual({ epic: "hq-c4pl0", focus: "hq-c4pl0.3", chart: null });
    expect(parseRoute("/projects/acme-avance/flow?chart=avance-netsuite").flow).toEqual({ epic: null, focus: null, chart: "avance-netsuite" });
    expect(parseRoute("/projects/hq/flow?focus=hq-c4pl0.3&req=r-1")).toMatchObject({
      flow: { epic: null, focus: "hq-c4pl0.3" },
      requestId: "r-1",
    });
  });

  it("round-trips, request id included", () => {
    for (const path of ["/projects/hq/flow", "/projects/hq/flow?chart=a-b", "/projects/hq/flow/hq-c4pl0", "/projects/hq/flow/hq-c4pl0?focus=hq-c4pl0.3", "/projects/hq/flow?focus=hq-x"]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
    expect(routePath(parseRoute("/projects/hq/flow?focus=hq-x&req=r-2"))).toBe("/projects/hq/flow?focus=hq-x&req=r-2");
    expect(flowPath("a b", { epic: "x/y" })).toBe("/projects/a%20b/flow/x%2Fy");
  });

  it("leaves every older route parsing exactly as before", () => {
    const table: [string, object][] = [
      ["/projects/chesski", { tab: "projects", projectId: "chesski", requestId: null, termSid: null }],
      ["/projects/chesski/beads/ck-1", { tab: "projects", projectId: "chesski", requestId: null, termSid: null, beadId: "ck-1" }],
      ["/projects/chesski/beads", { tab: "projects", projectId: "chesski", requestId: null, termSid: null }],
      ["/projects/chesski?req=r-1", { tab: "projects", projectId: "chesski", requestId: "r-1", termSid: null }],
      ["/reports/x", { tab: "reports", projectId: null, requestId: null, termSid: null, reportId: "x" }],
      ["/term/w-1", { tab: "now", projectId: null, requestId: null, termSid: "w-1" }],
      ["/now?req=r-5", { tab: "now", projectId: null, requestId: "r-5", termSid: null }],
    ];
    for (const [path, route] of table) expect(parseRoute(path)).toEqual(route);
    expect(routePath(parseRoute("/projects/chesski/beads/ck-1?req=r-1"))).toBe("/projects/chesski/beads/ck-1?req=r-1");
  });

  it("builds the Flow button target only when bead and project are known", () => {
    const ids = ["hq", "acme-avance"];
    expect(flowPathFor(ids, "acme-avance", "hq-a1")).toBe("/projects/acme-avance/flow?focus=hq-a1");
    expect(flowPathFor(ids, null, "hq-a1")).toBe("/projects/hq/flow?focus=hq-a1");
    expect(flowPathFor(ids, "chesski", "ck-1")).toBeNull();
    expect(flowPathFor(ids, "hq", null)).toBeNull();
    expect(flowPathFor(ids, null, "xd-1")).toBeNull();
    expect(flowPathFor([], "hq", "hq-a1")).toBeNull();
  });
});
