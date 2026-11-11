// The kit's Markdown draws headings, lists, quotes, code and links but not tables: this cuts the
// tables out of a note so the preview can draw them as tables, and the rest goes to the kit.
// Pure, so it is tested without a browser.

export type Piece = { kind: "text"; text: string } | { kind: "table"; head: string[]; rows: string[][]; align: ("start" | "center" | "end")[] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-") && (line.includes("|") || /:/.test(line));
const isRow = (line: string) => line.includes("|") && line.trim() !== "";

export function splitTables(source: string): Piece[] {
  const lines = source.split(/\r?\n/);
  const out: Piece[] = [];
  let text: string[] = [];
  let fenced = false;
  const flush = () => {
    if (text.length) out.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && isRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "end" : "start") as "start" | "center" | "end");
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) rows.push(cells(lines[j++]));
      flush();
      out.push({ kind: "table", head, rows, align });
      i = j - 1;
    } else text.push(line);
  }
  flush();
  return out;
}
