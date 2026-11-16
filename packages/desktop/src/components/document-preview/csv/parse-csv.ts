/**
 * CSV / TSV reader for the spreadsheet grid (RFC 4180 plus the usual
 * real-world slack): quoted fields with `""` escapes and embedded line breaks,
 * CRLF / LF / CR line ends, a UTF-8 BOM, and stray text after a closing quote
 * kept as-is instead of failing the whole file.
 *
 * The separator is the file's own: tab for `.tsv`, otherwise sniffed from the
 * first lines — a French Excel writes `;`, not `,`.
 */
import { getFileExtension } from "@/lib/file-language";
import { MAX_COLS, MAX_ROWS, type Cell, type Sheet } from "./sheet";

export type Delimiter = "," | ";" | "\t" | "|";

export interface CsvSheet extends Sheet {
  delimiter: Delimiter;
}

export const DELIMITER_LABELS: Readonly<Record<Delimiter, string>> = {
  ",": "comma-separated",
  ";": "semicolon-separated",
  "\t": "tab-separated",
  "|": "pipe-separated",
};

const CANDIDATES: readonly Delimiter[] = [",", ";", "\t", "|"];
const CANDIDATE_INDEX: ReadonlyMap<string, number> = new Map(
  CANDIDATES.map((candidate, index) => [candidate, index]),
);
const SNIFF_LINES = 10;
const SNIFF_CHARS = 64 * 1024;
const QUOTE = 34;
const LF = 10;
const CR = 13;
/** Plain, thousands-grouped (`1,234` / `1 234`) or decimal-comma numbers, % and exponents. */
const NUMERIC = /^[-+]?(\d{1,3}([, \u00a0\u202f]\d{3})+|\d+)?([.,]\d+)?([eE][-+]?\d+)?%?$/;
const DIGIT = /\d/;

/** The separator a path's extension implies, or null to sniff the content. */
export function delimiterForPath(filePath: string): Delimiter | null {
  return getFileExtension(filePath) === "tsv" ? "\t" : null;
}

/**
 * Decode raw file bytes: UTF-16 when it carries a BOM (Excel's "Unicode
 * Text" export), UTF-8 when the bytes are valid UTF-8, else Windows-1252 —
 * what older Excel versions write on Windows.
 */
export function decodeText(data: ArrayBuffer): string {
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (error) {
    // Invalid UTF-8 is the signal to fall back, not a failure to surface.
    if (!(error instanceof TypeError)) throw error;
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Per-line candidate counts (outside quotes) for the first complete lines. */
function sniffCounts(text: string): number[][] {
  const lines: number[][] = [];
  let counts = CANDIDATES.map(() => 0);
  let inQuotes = false;
  let hasContent = false;
  const end = Math.min(text.length, SNIFF_CHARS);
  for (let index = 0; index < end && lines.length < SNIFF_LINES; index += 1) {
    const char = text.charAt(index);
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) {
      if (hasContent) lines.push(counts);
      counts = CANDIDATES.map(() => 0);
      hasContent = false;
    } else if (!inQuotes) {
      const candidate = CANDIDATE_INDEX.get(char);
      if (candidate !== undefined) counts[candidate] += 1;
      hasContent = true;
    }
  }
  if (lines.length === 0 && hasContent) lines.push(counts);
  return lines;
}

/**
 * The candidate that splits the first line, preferring the one that splits
 * every sniffed line into the same number of fields. Comma when none does.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = sniffCounts(text);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const [index, candidate] of CANDIDATES.entries()) {
    const first = lines[0]?.[index] ?? 0;
    if (first === 0) continue;
    const consistent = lines.filter((counts) => counts[index] === first).length / lines.length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function isNumeric(value: string): boolean {
  return DIGIT.test(value) && NUMERIC.test(value);
}

class SheetBuilder {
  readonly rows = new Map<number, Map<number, Cell>>();
  row = 0;
  col = 0;
  colCount = 0;
  truncated = false;

  addField(value: string): void {
    const col = this.col;
    this.col += 1;
    if (col >= MAX_COLS) {
      this.truncated = true;
      return;
    }
    if (value === "") return;
    let cells = this.rows.get(this.row);
    if (!cells) this.rows.set(this.row, (cells = new Map()));
    cells.set(col, { text: value, numeric: isNumeric(value.trim()) });
  }

  endRow(): void {
    this.colCount = Math.max(this.colCount, Math.min(this.col, MAX_COLS));
    this.row += 1;
    this.col = 0;
  }
}

/** Read a quoted field starting at the opening quote; returns its value and the end index. */
function readQuoted(text: string, start: number, delimiter: number): [string, number] {
  let value = "";
  let index = start + 1;
  let chunk = index;
  while (index < text.length) {
    if (text.charCodeAt(index) === QUOTE) {
      if (text.charCodeAt(index + 1) !== QUOTE) break;
      value += text.slice(chunk, index + 1);
      index += 2;
      chunk = index;
    } else index += 1;
  }
  value += text.slice(chunk, index);
  // Past the closing quote: keep anything before the next separator verbatim.
  const tail = index + 1;
  index = readUnquotedEnd(text, tail, delimiter);
  return [value + text.slice(Math.min(tail, index), index), index];
}

function readUnquotedEnd(text: string, start: number, delimiter: number): number {
  let index = start;
  while (index < text.length) {
    const char = text.charCodeAt(index);
    if (char === delimiter || char === LF || char === CR) break;
    index += 1;
  }
  return index;
}

/** Parse delimited text into a sheet, clipped to `MAX_ROWS` × `MAX_COLS`. */
export function parseDelimited(text: string, delimiter: Delimiter | null): CsvSheet {
  const separator = delimiter ?? detectDelimiter(text);
  const code = separator.charCodeAt(0);
  const sheet = new SheetBuilder();
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    let value: string;
    if (text.charCodeAt(index) === QUOTE) [value, index] = readQuoted(text, index, code);
    else {
      const start = index;
      index = readUnquotedEnd(text, index, code);
      value = text.slice(start, index);
    }
    sheet.addField(value);
    if (index >= text.length) {
      sheet.endRow();
      break;
    }
    if (text.charCodeAt(index) === code) {
      index += 1;
      if (index >= text.length) {
        sheet.addField("");
        sheet.endRow();
      }
      continue;
    }
    index += text.charCodeAt(index) === CR && text.charCodeAt(index + 1) === LF ? 2 : 1;
    sheet.endRow();
    if (sheet.row >= MAX_ROWS) {
      sheet.truncated ||= index < text.length;
      break;
    }
  }
  return {
    rowCount: sheet.row,
    colCount: sheet.colCount,
    rows: sheet.rows,
    colWidths: [],
    truncated: sheet.truncated,
    delimiter: separator,
  };
}
