// Renders the parsed markdown tree as React elements. There is no HTML string in this
// file and there must never be one: no innerHTML, no dangerouslySetInnerHTML. Text lands
// in text nodes, so anything the source called markup is shown as the characters it is.

import type { ReactNode } from "react";
import type { Block, Inline, ListItem } from "./markdown";
import { parseMarkdown } from "./markdown";

function renderInline(nodes: readonly Inline[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${index}`;
    switch (node.t) {
      case "text":
        return <span key={key}>{node.value}</span>;
      case "code":
        return (
          <code key={key} className="rounded-sub bg-panel2 px-1 py-px font-mono text-[12px] text-accent">
            {node.value}
          </code>
        );
      case "strong":
        return <b key={key}>{renderInline(node.children, key)}</b>;
      case "em":
        return <i key={key}>{renderInline(node.children, key)}</i>;
      case "wiki":
        // A vault link the console cannot resolve: shown as what it says, not as a link.
        return (
          <span key={key} className="text-mute underline decoration-dotted">
            {node.value}
          </span>
        );
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInline(node.children, key)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderItems(items: readonly ListItem[], prefix: string): ReactNode[] {
  return items.map((item, index) => {
    const key = `${prefix}.i${index}`;
    return (
      <li key={key} className="my-0.5">
        {renderInline(item.children, key)}
        {item.blocks.length > 0 ? renderBlocks(item.blocks, key) : null}
      </li>
    );
  });
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-4 mb-2 text-[16px] font-semibold",
  2: "mt-4 mb-1.5 text-[14px] font-semibold",
  3: "mt-3 mb-1 text-[13px] font-semibold",
  4: "mt-3 mb-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-mute",
  5: "mt-2 mb-1 text-[12px] font-semibold text-mute",
  6: "mt-2 mb-1 text-[12px] font-semibold text-mute",
};

function renderBlocks(blocks: readonly Block[], prefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${prefix}.b${index}`;
    switch (block.t) {
      case "heading": {
        const level = Math.min(Math.max(block.level, 1), 6);
        const Tag = (`h${level}` as unknown) as "h1";
        return (
          <Tag key={key} className={HEADING_CLASS[level]}>
            {renderInline(block.children, key)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={key} className="my-2 text-[13px] leading-[1.55]">
            {renderInline(block.children, key)}
          </p>
        );
      case "code":
        return (
          <pre
            key={key}
            className="hq-scroll my-2 overflow-x-auto rounded-sub border border-line bg-code px-2.5 py-2 font-mono text-[12px] leading-[1.5]"
          >
            <code>{block.value}</code>
          </pre>
        );
      case "list":
        return block.ordered ? (
          <ol key={key} className="my-2 list-decimal pl-5 text-[13px]">
            {renderItems(block.items, key)}
          </ol>
        ) : (
          <ul key={key} className="my-2 list-disc pl-5 text-[13px]">
            {renderItems(block.items, key)}
          </ul>
        );
      case "quote":
        return (
          <blockquote key={key} className="my-2 border-l-2 border-line pl-2.5 text-[13px] text-mute">
            {renderBlocks(block.children, key)}
          </blockquote>
        );
      case "hr":
        return <hr key={key} className="my-3 border-0 border-t border-line" />;
      default:
        return null;
    }
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) {
    return <p className="m-0 text-[12px] text-mute">Empty file.</p>;
  }
  return <div className={className}>{renderBlocks(blocks, "md")}</div>;
}
