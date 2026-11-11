// Mail html for the reading view, without innerHTML.
//
// body_html is already rebuilt from an allowlist on the server (server/src/reports.js).
// The console still does not hand it to innerHTML: the browser parses it into an inert
// document (DOMParser runs no script and fetches nothing), this file walks that tree into
// plain data with its own allowlist, and ReportBody turns the data into React elements.
// Two independent allowlists means a server sanitizer bug alone cannot run code here.

import { sanitizeUrl } from "../projects/markdown";

export type HtmlTree =
  | { t: "text"; value: string }
  | { t: "el"; tag: string; attrs: Record<string, string>; children: HtmlTree[] };

/** The slice of the DOM Node interface the walker reads, so tests can pass plain objects. */
export interface DomLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<DomLike>;
  getAttribute?: (name: string) => string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
export const MAX_DEPTH = 48;

export const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "del", "div", "dl", "dt", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s",
  "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

/** Elements dropped with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "svg", "math",
  "head", "select", "audio", "video", "img", "picture", "form", "button", "input",
]);

const NUMERIC: Record<string, readonly string[]> = { td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], ol: ["start"] };

function attrsFor(tag: string, node: DomLike): Record<string, string> {
  const out: Record<string, string> = {};
  const read = (name: string) => (node.getAttribute ? node.getAttribute(name) : null);
  if (tag === "a") {
    const href = sanitizeUrl(read("href") ?? "");
    if (href) out.href = href;
  }
  for (const name of NUMERIC[tag] ?? []) {
    const raw = read(name);
    if (raw && /^\d{1,3}$/.test(raw.trim())) out[name] = String(Math.min(Number(raw.trim()), 100));
  }
  return out;
}

function walk(node: DomLike, depth: number, out: HtmlTree[]): void {
  if (node.nodeType === TEXT_NODE) {
    if (node.nodeValue) out.push({ t: "text", value: node.nodeValue });
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return; // comments, doctypes, processing instructions
  const tag = node.nodeName.toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return;
  if (depth >= MAX_DEPTH) {
    // Deeper than any real mail: keep the words, drop the structure.
    out.push({ t: "text", value: textOf(node) });
    return;
  }
  const children: HtmlTree[] = [];
  for (let i = 0; i < node.childNodes.length; i += 1) walk(node.childNodes[i]!, depth + 1, children);
  if (ALLOWED_TAGS.has(tag)) out.push({ t: "el", tag, attrs: attrsFor(tag, node), children });
  else out.push(...children); // an unknown wrapper (body, html, font, center) keeps its content
}

function textOf(node: DomLike): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeType !== ELEMENT_NODE || DROP_WITH_CONTENT.has(node.nodeName.toLowerCase())) return "";
  let s = "";
  for (let i = 0; i < node.childNodes.length; i += 1) s += textOf(node.childNodes[i]!);
  return s;
}

/** The children of a parsed body as an allowlisted tree. */
export function treeFrom(root: DomLike): HtmlTree[] {
  const out: HtmlTree[] = [];
  for (let i = 0; i < root.childNodes.length; i += 1) walk(root.childNodes[i]!, 0, out);
  return out;
}

/** Parse in the browser. Null where there is no DOMParser (tests, server render). */
export function parseHtml(html: string): HtmlTree[] | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return treeFrom(doc.body as unknown as DomLike);
}
