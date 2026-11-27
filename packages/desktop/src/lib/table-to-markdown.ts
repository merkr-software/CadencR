import { fragmentToMarkdown } from "@/lib/selection-to-markdown";

/**
 * A cell's content as one line of Markdown, its inline marks kept: a line
 * break (a `<br>`, a newline) is written `<br>`, the only break a GFM table
 * cell can hold, and a pipe is escaped so it does not end the cell.
 */
function cellMarkdown(cell: HTMLTableCellElement): string {
  const fragment = document.createDocumentFragment();
  for (const child of cell.childNodes) fragment.append(child.cloneNode(true));
  return fragmentToMarkdown(fragment)
    .trim()
    .replace(/[^\S\n]*\n[^\S\n]*/g, "<br>")
    .replaceAll("|", "\\|");
}

/**
 * A rendered table back to a GitHub-flavored Markdown table: the first row is
 * the header, short rows are padded to the widest one.
 */
export function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows, (row) => Array.from(row.cells, cellMarkdown));
  const [header, ...body] = rows;
  if (!header) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(header), line(Array<string>(width).fill("---")), ...body.map(line)].join("\n");
}
