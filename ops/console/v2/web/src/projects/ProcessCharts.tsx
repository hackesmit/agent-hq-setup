// Authored process charts (bead hq-c4pl0.4): Mermaid files a person writes in the
// project's vault folder (01 Projects/<rig>/flows/<name>.mmd), drawn on the project
// page with their date so a stale chart is visible. Rendering costs no tokens and
// nothing regenerates a chart: they change only when someone edits the file.
//
// mermaid is loaded with a dynamic import, so it lands in its own chunk and the main
// bundle never carries it. securityLevel "strict" keeps the source from reaching
// HTML or script (mermaid sanitises the SVG it returns).

import { useEffect, useId, useState } from "react";
import { Card, CardBody, CardHead, Chip } from "../ui/primitives";
import { fmtDate } from "../ui/format";
import { errorText, projectsApi } from "./api";
import { useAsync } from "./useAsync";

/** True when a #rgb or #rrggbb colour is dark; anything unparseable counts as dark (the console default). */
export function isDark(color: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return true;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** Mermaid theme variables read from the console tokens, so a chart matches the page. */
export function mermaidTheme(read: (name: string) => string): Record<string, string | boolean> {
  const v = (name: string, fallback: string) => read(name).trim() || fallback;
  const background = v("--panel", "#131312");
  return {
    darkMode: isDark(background),
    background,
    primaryColor: v("--panel2", "#1a1a17"),
    primaryTextColor: v("--ink", "#dcd7cb"),
    primaryBorderColor: v("--mute", "#7c7768"),
    secondaryColor: v("--chip", "#1c1c19"),
    tertiaryColor: v("--panel", "#131312"),
    lineColor: v("--mute", "#7c7768"),
    textColor: v("--ink", "#dcd7cb"),
    clusterBkg: v("--panel", "#131312"),
    clusterBorder: v("--line", "#262521"),
    edgeLabelBackground: v("--panel", "#131312"),
    fontFamily: v("--face", "monospace"),
    fontSize: "12px",
  };
}

let ready: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    const css = getComputedStyle(document.documentElement);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // dagre, not ELK: mermaid 12 otherwise fetches its 1.4 MB ELK chunk for a plain flowchart
      layout: "dagre",
      theme: "base",
      themeVariables: mermaidTheme((name) => css.getPropertyValue(name)),
    });
    return mermaid;
  });
  return ready;
}

export function MermaidChart({ source }: { source: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(
        (out) => live && setSvg(out.svg),
        (e: unknown) => {
          if (!live) return;
          setError(e instanceof Error ? e.message : String(e));
          // a failed render can leave its scratch element behind
          document.getElementById(`d${id}`)?.remove();
        },
      );
    return () => {
      live = false;
    };
  }, [id, source]);
  if (error) {
    return (
      <div role="alert" className="rounded-sub border border-bad/60 bg-bad/10 px-2.5 py-2 text-[12px] text-bad">
        Chart did not render: {error.split("\n")[0]}
      </div>
    );
  }
  if (!svg) return <p className="m-0 text-[12px] text-mute">Drawing.</p>;
  // mermaid output under securityLevel strict, sanitised by mermaid itself
  return <div className="hq-scroll overflow-x-auto [&_svg]:max-w-none" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function ProcessChart({ project, name, title, updatedAt }: { project: string; name: string; title: string; updatedAt: string | null }) {
  const chart = useAsync((signal) => projectsApi.flowChart(project, name, signal), `${project}:chart:${name}`);
  return (
    <Card>
      <CardHead title={title} chip={<Chip tone="mute">{updatedAt ? `updated ${fmtDate(updatedAt)}` : "no date"}</Chip>} />
      <CardBody>
        {chart.error ? <p className="m-0 text-[12px] text-bad">Could not load {name}. {errorText(chart.error)}</p> : null}
        {chart.data ? <MermaidChart source={chart.data.source} /> : chart.loading ? <p className="m-0 text-[12px] text-mute">Loading.</p> : null}
      </CardBody>
    </Card>
  );
}

/** Every chart in the project's flows folder; one quiet line when there are none. */
export function ProcessCharts({ project, only = null }: { project: string; only?: string | null }) {
  const list = useAsync((signal) => projectsApi.flowCharts(project, signal), `${project}:charts`);
  if (list.error) return <p className="m-0 text-[12px] text-bad">Could not list process charts. {errorText(list.error)}</p>;
  if (!list.data) return null;
  const charts = only ? list.data.filter((c) => c.name === only) : list.data;
  if (charts.length === 0) {
    return (
      <p className="m-0 text-[12px] text-mute">
        {only ? `No chart named ${only}.` : `No process charts. Add .mmd files to the vault's ${project} flows folder.`}
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      {charts.map((c) => (
        <ProcessChart key={c.name} project={project} name={c.name} title={c.title} updatedAt={c.updatedAt} />
      ))}
    </div>
  );
}
