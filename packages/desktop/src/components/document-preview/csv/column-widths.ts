import type { CsvSheet } from "./parse-csv";
import type { Cell } from "./sheet";

/**
 * The classes that size a `SheetGrid` cell's text box. Measurement reads them
 * off a probe rather than hardcoding pixels: the app scales `rem`.
 */
export const GRID_CELL_TEXT_CLASSES = "text-xs px-1.5";
/** The cell's 1px border plus a hair of slack against subpixel rounding. */
const CELL_EXTRA_PX = 1 + 2;
/** Rows measured per column: enough to size a column, bounded for 100k-row files. */
const SAMPLE_ROWS = 200;
const MIN_COL_WIDTH_PX = 48;
const MAX_COL_WIDTH_PX = 320;

export interface GridTextMeasure {
  /** Width of `text` in the cell font. */
  text(text: string): number;
  /** Horizontal padding + border around a cell's text. */
  chrome: number;
}

/** Width of a cell's text as the grid renders it. */
function cellTextWidth(cell: Cell, measure: GridTextMeasure): number {
  // One line (breaks show as spaces); numbers use tabular digits, all as wide as "0".
  const text = cell.text.replace(/\s+/g, " ");
  return measure.text(cell.numeric ? text.replace(/\d/g, "0") : text);
}

/** Size each column to its widest cell in the first rows, within readable bounds. */
export function fitColumnWidths(sheet: CsvSheet, measure: GridTextMeasure): CsvSheet {
  const widest = Array.from({ length: sheet.colCount }, () => 0);
  for (let row = 0; row < Math.min(sheet.rowCount, SAMPLE_ROWS); row += 1) {
    for (const [col, cell] of sheet.rows.get(row) ?? []) {
      widest[col] = Math.max(widest[col] ?? 0, cellTextWidth(cell, measure));
    }
  }
  const colWidths = widest.map((width) => {
    const fitted = Math.ceil(width + measure.chrome);
    return Math.min(MAX_COL_WIDTH_PX, Math.max(MIN_COL_WIDTH_PX, fitted));
  });
  return { ...sheet, colWidths };
}

/**
 * Text widths in the grid's own computed font, measured on a canvas: exact
 * for any script or font, unlike a per-character estimate.
 */
export function measureGridText(): GridTextMeasure {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Canvas text measurement is unavailable");
  const probe = document.createElement("span");
  probe.className = GRID_CELL_TEXT_CLASSES;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  context.font = `${style.fontSize} ${style.fontFamily}`;
  const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + CELL_EXTRA_PX;
  probe.remove();
  return { text: (text) => context.measureText(text).width, chrome };
}
