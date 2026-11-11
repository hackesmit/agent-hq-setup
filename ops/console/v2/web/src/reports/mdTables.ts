// Pipe tables for the markdown reports. The console's markdown parser (projects/markdown.ts)
// has no tables, and the stack usage report is mostly tables, so the reader lifts them out
// here and hands everything between them to the shared parser. Cells stay plain text.

export type MdSegment = { t: "md"; text: string } | { t: "table"; head: string[]; rows: string[][] };

const DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function isRow(line: string): boolean {
  return line.trim().startsWith("|") && line.includes("|", line.indexOf("|") + 1);
}

export function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((cell) => cell.trim().replace(/^`([^`]*)`$/, "$1"));
}

/** Split a markdown source into prose runs and pipe tables, outside fenced code. */
export function splitTables(source: string): MdSegment[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: MdSegment[] = [];
  let prose: string[] = [];
  let fenced = false;
  const flush = () => {
    if (prose.length > 0) out.push({ t: "md", text: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const next = lines[i + 1];
    if (!fenced && isRow(line) && next !== undefined && DIVIDER.test(next)) {
      const head = splitCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i]!)) {
        rows.push(splitCells(lines[i]!));
        i += 1;
      }
      i -= 1;
      flush();
      out.push({ t: "table", head, rows });
      continue;
    }
    prose.push(line);
  }
  flush();
  return out;
}
