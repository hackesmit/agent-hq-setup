// The body of one report, in one of three shapes (model.bodyMode). Like projects/Markdown,
// there is no innerHTML and no dangerouslySetInnerHTML here: html arrives as the data
// tree from html.ts and becomes React elements, markdown goes through the console's own
// parser (plus the chart and keypoints fences of blocks.ts, drawn from validated data),
// and plain mail text lands in a text node.

import { createElement, useMemo, type ReactNode } from "react";
import type { ReportDetail } from "@shared/api";
import { Markdown } from "../projects/Markdown";
import { bodyMode, plainBody } from "./model";
import { parseHtml, type HtmlTree } from "./html";
import { splitReport, splitTag, TONE_VAR, type KeyPoint, type Tone } from "./blocks";
import { ReportChart } from "./ReportChart";
import { cx } from "../ui/primitives";

const TAG_CLASS: Record<string, string> = {
  p: "my-2",
  h1: "mt-4 mb-2 text-[16px] font-semibold",
  h2: "mt-4 mb-1.5 text-[14px] font-semibold",
  h3: "mt-3 mb-1 text-[13px] font-semibold",
  h4: "mt-3 mb-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-mute",
  h5: "mt-2 mb-1 text-[12px] font-semibold text-mute",
  h6: "mt-2 mb-1 text-[12px] font-semibold text-mute",
  ul: "my-2 list-disc pl-5",
  ol: "my-2 list-decimal pl-5",
  li: "my-0.5",
  blockquote: "my-2 border-l-2 border-line pl-2.5 text-mute",
  pre: "hq-scroll my-2 overflow-x-auto rounded-sub border border-line bg-code px-2.5 py-2 font-mono text-[12px] leading-[1.5]",
  code: "font-mono text-[12px]",
  hr: "my-3 border-0 border-t border-line",
  table: "my-2 w-full border-collapse text-[12px]",
  th: "border-b border-line px-2 py-1 text-left font-semibold text-mute",
  td: "border-b border-line px-2 py-1 align-top",
  caption: "py-1 text-left text-[12px] text-mute",
  small: "text-[12px] text-mute",
  mark: "bg-warn/20 text-ink",
  a: "underline",
};

function renderTree(nodes: readonly HtmlTree[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${index}`;
    if (node.t === "text") return node.value;
    const props: Record<string, unknown> = { key, className: TAG_CLASS[node.tag] };
    if (node.tag === "a" && node.attrs.href) {
      props.href = node.attrs.href;
      props.target = "_blank";
      props.rel = "noreferrer noopener";
    }
    if (node.attrs.colspan) props.colSpan = Number(node.attrs.colspan);
    if (node.attrs.rowspan) props.rowSpan = Number(node.attrs.rowspan);
    if (node.attrs.start) props.start = Number(node.attrs.start);
    if (node.tag === "br" || node.tag === "hr") return createElement(node.tag, props);
    const element = createElement(node.tag, props, ...renderTree(node.children, key));
    // A mail table is laid out for a desktop client; on a phone it scrolls inside the
    // reader rather than pushing the whole page sideways.
    return node.tag === "table" ? (
      <div key={key} className="hq-scroll overflow-x-auto">
        {element}
      </div>
    ) : (
      element
    );
  });
}

function HtmlBody({ html }: { html: string }) {
  const tree = useMemo(() => parseHtml(html), [html]);
  if (tree === null) return null;
  return <div className="max-w-[78ch] text-[13px] leading-[1.55] break-words">{renderTree(tree, "h")}</div>;
}

const TONE_CELL: Record<Tone, string> = { good: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-ink" };
const TONE_WORD: Record<Tone, string> = { good: "good", warn: "warning", bad: "bad", info: "note" };

/** A dot in the tone's ink, so a tagged point or cell carries a mark and not only a color. */
function ToneDot({ tone }: { tone: Tone | null }) {
  return (
    <span
      className="mt-[0.45em] inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: tone ? `var(${TONE_VAR[tone]})` : "var(--faint)" }}
      role={tone ? "img" : undefined}
      aria-label={tone ? TONE_WORD[tone] : undefined}
      aria-hidden={tone ? undefined : true}
    />
  );
}

/** The keypoints fences, gathered into one card above the body wherever they sat. */
function KeyPoints({ points }: { points: readonly KeyPoint[] }) {
  return (
    <section className="mb-4 rounded-sub border border-line bg-panel2 px-3.5 py-3" aria-label="Key points" data-keypoints="">
      <h2 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-mute">Key points</h2>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] leading-[1.5]">
        {points.map((point, index) => (
          <li key={index} className="flex gap-2.5" data-tone={point.tone ?? undefined}>
            <ToneDot tone={point.tone} />
            <span className="min-w-0">{point.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Cell({ value, head }: { value: string; head?: boolean }) {
  const { tone, text } = splitTag(value);
  const Tag = head ? "th" : "td";
  if (!tone) return <Tag className={head ? TAG_CLASS.th : TAG_CLASS.td}>{value}</Tag>;
  return (
    <Tag className={cx(head ? TAG_CLASS.th : TAG_CLASS.td, TONE_CELL[tone])} data-tone={tone}>
      <span className="inline-flex gap-1.5">
        <ToneDot tone={tone} />
        <span>{text}</span>
      </span>
    </Tag>
  );
}

// Prose keeps a reading measure; tables, charts and the key-point card take the whole
// reader, which is the point of giving the reader the width.
const PROSE = "max-w-[78ch]";

function MarkdownBody({ source }: { source: string }) {
  const { keypoints, segments } = useMemo(() => splitReport(source), [source]);
  return (
    <div className="break-words">
      {keypoints.length > 0 ? <KeyPoints points={keypoints} /> : null}
      {segments.map((segment, index) => {
        if (segment.t === "md") return segment.text.trim() ? <Markdown key={index} source={segment.text} className={PROSE} /> : null;
        if (segment.t === "chart") return <ReportChart key={index} spec={segment.spec} />;
        if (segment.t === "code") {
          // A chart fence that did not parse: shown as the code it is, never thrown.
          return (
            <pre key={index} className={TAG_CLASS.pre} data-chart-error="">
              <code>{segment.text}</code>
            </pre>
          );
        }
        return (
          <div key={index} className="hq-scroll overflow-x-auto">
            <table className={TAG_CLASS.table}>
              <thead>
                <tr>
                  {segment.head.map((cell, c) => (
                    <Cell key={c} value={cell} head />
                  ))}
                </tr>
              </thead>
              <tbody>
                {segment.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <Cell key={c} value={cell} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

export function ReportBody({ report, plain }: { report: ReportDetail; plain?: boolean }) {
  const mode = plain ? "text" : bodyMode(report);
  if (mode === "html" && report.body_html) return <HtmlBody html={report.body_html} />;
  if (mode === "markdown") return <MarkdownBody source={report.body_md} />;
  const text = plainBody(report.body_md);
  if (!text) return <p className="m-0 text-[12px] text-mute">This report has no text.</p>;
  return <div className="max-w-[78ch] whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.55]">{text}</div>;
}
