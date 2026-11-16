/**
 * The grid model the CSV / TSV reader (`parse-csv.ts`) produces and
 * `SheetGrid` renders.
 */

export interface Cell {
  text: string;
  /** Numbers (and dates) right-align, like Excel. */
  numeric: boolean;
}

export interface Sheet {
  rowCount: number;
  colCount: number;
  /** Sparse: row index → column index → cell. */
  rows: Map<number, Map<number, Cell>>;
  /** Column widths in px, indexed by column; missing entries use the default. */
  /** Pixel width per column, sized to the content (see `fitColumnWidths`). */
  colWidths: number[];
  /** True when the sheet was clipped to `MAX_ROWS` × `MAX_COLS`. */
  truncated: boolean;
}

export const MAX_ROWS = 100_000;
export const MAX_COLS = 200;
export const DEFAULT_COL_WIDTH_PX = 64;

/** Zero-based column index → `"A"`, `"Z"`, `"AA"`, … */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * Status-bar summary: `"12 rows × 4 columns"`, flagged when the sheet was
 * clipped to `MAX_ROWS` × `MAX_COLS` (the counts are then what's shown).
 */
export function sheetSummary(sheet: Sheet): string {
  const size = `${sheet.rowCount.toLocaleString()} rows × ${sheet.colCount} columns`;
  return sheet.truncated ? `${size} · truncated` : size;
}
