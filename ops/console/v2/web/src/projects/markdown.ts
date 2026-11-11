// A small, deliberately incomplete markdown parser for Knowledge.md, the vault hub and
// DECISIONS.md.
//
// Why hand-written (design 4.2, bead hq-tf37): the console renders files that workers and
// the vault write, so the renderer is a trust boundary. This one parses to a plain data
// tree and NOTHING else; the React component turns that tree into elements, so there is
// no innerHTML, no dangerouslySetInnerHTML and no HTML string anywhere in the path. Raw
// HTML in the source is therefore text by construction, not by a filter that can be
// out-thought.
//
// Supported: headings, paragraphs, fenced and indented-free code blocks, inline code,
// bold, italic, links (http/https/mailto only), nested bullet and ordered lists, block
// quotes, horizontal rules, and Obsidian wikilinks rendered as plain text. Images are
// dropped to their alt text: the console must not fetch a URL a file asked it to.

export type Inline =
  | { t: "text"; value: string }
  | { t: "code"; value: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "wiki"; value: string };

export interface ListItem {
  children: Inline[];
  blocks: Block[];
}

export type Block =
  | { t: "heading"; level: number; children: Inline[] }
  | { t: "paragraph"; children: Inline[] }
  | { t: "code"; lang: string | null; value: string }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "quote"; children: Block[] }
  | { t: "hr" };

// ---------- URLs ----------

const NAMED_ENTITIES: Record<string, string> = {
  colon: ":",
  tab: "\t",
  newline: "\n",
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  sol: "/",
};

/**
 * Decode the entity forms a crafted href uses to hide its scheme ("&#106;avascript:",
 * "java&Tab;script:"). Used only to inspect a URL, never to build one: a href that needs
 * decoding to look safe is rejected outright rather than rewritten.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Allowlist by scheme. Anything not http(s)/mailto (javascript:, data:, vbscript:, file:,
 * an unknown app scheme) returns null and the caller renders the label as plain text.
 * Relative and anchor links are kept: they can only ever point back into the console.
 */
export function sanitizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // Whitespace and control characters come out before the scheme check, so
  // "java\tscript:" and "java script:" are judged as what they resolve to.
  // Backslashes become slashes too. A browser resolving an href for a special
  // scheme treats the two as the same character, so "\\evil.example/hq" on an
  // https page navigates to https://evil.example/hq -- a protocol-relative url
  // wearing a different coat. Judge what it resolves to, not how it is spelled.
  const probe = decodeEntities(value)
    .replace(/[\s\p{Cc}\p{Cf}]/gu, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!probe) return null;
  // A protocol-relative url starts with two slashes and is NOT relative:
  // "//host/x" leaves the tailnet while reading like an internal link. It has to
  // come out before the single-slash case below, which would wave it through.
  if (probe.startsWith("//")) return null;
  if (probe.startsWith("#") || probe.startsWith("/") || probe.startsWith("?")) return value;
  const colon = probe.indexOf(":");
  const slash = probe.indexOf("/");
  // No colon before the first slash means a relative path, not a scheme.
  if (colon === -1 || (slash !== -1 && slash < colon)) return value;
  return SAFE_SCHEMES.has(probe.slice(0, colon)) ? value : null;
}

// ---------- inline ----------

function pushText(out: Inline[], buffer: string[]): void {
  if (buffer.length === 0) return;
  const value = buffer.join("");
  buffer.length = 0;
  if (value) out.push({ t: "text", value });
}

/** Index of the matching closing bracket, honouring nesting and backslash escapes. */
function matchBracket(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readDelimiterRun(src: string, at: number, ch: string): number {
  let run = 0;
  while (at + run < src.length && src[at + run] === ch) run += 1;
  return run;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const buffer: string[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === "\\" && i + 1 < src.length) {
      buffer.push(src[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = readDelimiterRun(src, i, "`");
      const fence = "`".repeat(run);
      const end = src.indexOf(fence, i + run);
      if (end !== -1) {
        pushText(out, buffer);
        out.push({ t: "code", value: src.slice(i + run, end).trim() });
        i = end + run;
        continue;
      }
      buffer.push(fence);
      i += run;
      continue;
    }

    // Images are stripped to their alt text; the console never loads a remote asset a
    // markdown file names.
    if (ch === "!" && src[i + 1] === "[") {
      const close = matchBracket(src, i + 1, "[", "]");
      if (close !== -1) {
        const alt = src.slice(i + 2, close);
        let next = close + 1;
        if (src[next] === "(") {
          const paren = matchBracket(src, next, "(", ")");
          if (paren !== -1) next = paren + 1;
        }
        buffer.push(alt);
        i = next;
        continue;
      }
    }

    // Obsidian wikilink: [[target|display]] renders as plain text, never a link. The
    // console cannot resolve vault paths and must not invent a URL for one.
    if (ch === "[" && src[i + 1] === "[") {
      const end = src.indexOf("]]", i + 2);
      if (end !== -1) {
        const body = src.slice(i + 2, end);
        const pipe = body.indexOf("|");
        const shown = (pipe === -1 ? body : body.slice(pipe + 1)).trim();
        pushText(out, buffer);
        out.push({ t: "wiki", value: shown || body.trim() });
        i = end + 2;
        continue;
      }
    }

    if (ch === "[") {
      const close = matchBracket(src, i, "[", "]");
      if (close !== -1 && src[close + 1] === "(") {
        const paren = matchBracket(src, close + 1, "(", ")");
        if (paren !== -1) {
          const label = src.slice(i + 1, close);
          const target = src.slice(close + 2, paren).trim().split(/\s+/)[0] ?? "";
          const href = sanitizeUrl(target);
          pushText(out, buffer);
          const children = parseInline(label);
          if (href === null) {
            // Dropped protocol: keep the words, lose the trap.
            out.push(...(children.length > 0 ? children : [{ t: "text", value: label } as Inline]));
          } else {
            out.push({ t: "link", href, children });
          }
          i = paren + 1;
          continue;
        }
      }
    }

    if (ch === "*" || ch === "_") {
      const run = readDelimiterRun(src, i, ch);
      const width = run >= 2 ? 2 : 1;
      const fence = ch.repeat(width);
      const end = src.indexOf(fence, i + width);
      if (end !== -1 && end > i + width) {
        pushText(out, buffer);
        const inner = parseInline(src.slice(i + width, end));
        out.push(width === 2 ? { t: "strong", children: inner } : { t: "em", children: inner });
        i = end + width;
        continue;
      }
      buffer.push(fence);
      i += width;
      continue;
    }

    buffer.push(ch);
    i += 1;
  }

  pushText(out, buffer);
  return out;
}

// ---------- blocks ----------

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)\s*([^`\s]*)\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const CLOSE_TICK = /^ {0,3}```+\s*$/;
const CLOSE_TILDE = /^ {0,3}~~~+\s*$/;

interface RawItem {
  indent: number;
  ordered: boolean;
  text: string;
}

function listMatch(line: string): RawItem | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { indent: bullet[1]!.replace(/\t/g, "  ").length, ordered: false, text: bullet[3]! };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return { indent: ordered[1]!.replace(/\t/g, "  ").length, ordered: true, text: ordered[3]! };
  }
  return null;
}

/** Build one list level; nested lines (deeper indent) recurse into the item's blocks. */
function buildList(raw: RawItem[], start: number, indent: number, ordered: boolean): { block: Block; next: number } {
  const items: ListItem[] = [];
  let i = start;
  while (i < raw.length) {
    const entry = raw[i]!;
    if (entry.indent < indent || entry.ordered !== ordered) break;
    if (entry.indent > indent) {
      const nested = buildList(raw, i, entry.indent, entry.ordered);
      const target = items[items.length - 1];
      if (target) target.blocks.push(nested.block);
      else items.push({ children: [], blocks: [nested.block] });
      i = nested.next;
      continue;
    }
    items.push({ children: parseInline(entry.text), blocks: [] });
    i += 1;
  }
  return { block: { t: "list", ordered, items }, next: i };
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const closing = fence[1]!.startsWith("~") ? CLOSE_TILDE : CLOSE_TICK;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      // An unclosed fence runs to the end of the file; drop the trailing blank the final
      // newline leaves behind so the block reads the same either way.
      if (i >= lines.length) {
        while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
      }
      i += 1; // closing fence (or end of file)
      blocks.push({ t: "code", lang: fence[2] || null, value: body.join("\n") });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        t: "heading",
        level: heading[1]!.length,
        children: parseInline(heading[2]!.replace(/\s+#+\s*$/, "")),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ t: "quote", children: parseMarkdown(body.join("\n")) });
      continue;
    }

    if (listMatch(line)) {
      const raw: RawItem[] = [];
      while (i < lines.length) {
        const entry = listMatch(lines[i]!);
        if (entry) {
          raw.push(entry);
          i += 1;
          continue;
        }
        // A blank line inside a list keeps the list open only if a list line follows.
        if (lines[i]!.trim() === "" && listMatch(lines[i + 1] ?? "")) {
          i += 1;
          continue;
        }
        break;
      }
      const base = Math.min(...raw.map((entry) => entry.indent));
      const built = buildList(raw, 0, base, raw[0]!.ordered);
      blocks.push(built.block);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      if (current.trim() === "" || HR.test(current) || HEADING.test(current) || FENCE.test(current) || QUOTE.test(current) || listMatch(current)) break;
      paragraph.push(current.trim());
      i += 1;
    }
    if (paragraph.length > 0) blocks.push({ t: "paragraph", children: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}

/** Plain-text projection, used for previews and for the truths mirror preview. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
        case "code":
        case "wiki":
          return node.value;
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}
