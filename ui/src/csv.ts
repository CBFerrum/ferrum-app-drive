// Comma- or tab-separated text read into rows for the preview: quoted cells with commas, quotes and
// line breaks, and no more rows than the table is asked to draw. Pure, so it is tested without a browser.

export interface Table {
  rows: string[][];
  /** Rows in the text read, counted past the ones kept. */
  total: number;
}

/** `text` as rows of cells (the delimiter is guessed from the first line: tab, else comma, else semicolon). Keeps the first `keep` rows. */
export function parseCsv(text: string, keep: number): Table {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const first = src.slice(0, src.search(/\r?\n/) === -1 ? undefined : src.search(/\r?\n/));
  const count = (c: string) => first.split(c).length - 1;
  const delimiter = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    // A line with nothing on it is not a row.
    if (row.length > 1 || row[0] !== "") {
      total++;
      if (rows.length < keep) rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') (cell += '"', i++);
        else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else cell += c;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, total };
}
