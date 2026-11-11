import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDark, mermaidTheme } from "../projects/ProcessCharts";
import { flowPath } from "../app/routes";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("process charts", () => {
  it("takes its colours from the console tokens, with fallbacks", () => {
    const tokens: Record<string, string> = { "--panel": " #111111", "--ink": "#eeeeee" };
    const theme = mermaidTheme((name) => tokens[name] ?? "");
    expect(theme.background).toBe("#111111");
    expect(theme.primaryTextColor).toBe("#eeeeee");
    expect(theme.lineColor).toBe("#7c7768");
    expect(theme.darkMode).toBe(true);
  });

  it("follows the console theme: a light panel is not dark mode", () => {
    expect(mermaidTheme((n) => (n === "--panel" ? "#fafafa" : "")).darkMode).toBe(false);
    expect(mermaidTheme((n) => (n === "--panel" ? "#111" : "")).darkMode).toBe(true);
    expect(isDark("rgb(1,2,3)")).toBe(true);
  });

  it("never imports mermaid statically, so it stays out of the main chunk", () => {
    const offenders = sources(SRC).filter((file) => /^\s*import\s[^;]*from\s+["']mermaid["']/m.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    const charts = readFileSync(join(SRC, "projects", "ProcessCharts.tsx"), "utf8");
    expect(charts).toContain('import("mermaid")');
    expect(charts).toContain('securityLevel: "strict"');
  });

  it("has a route for one chart", () => {
    expect(flowPath("acme-avance", { chart: "avance-netsuite" })).toBe("/projects/acme-avance/flow?chart=avance-netsuite");
  });
});
