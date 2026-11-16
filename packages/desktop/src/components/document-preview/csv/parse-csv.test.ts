import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "./sheet";
import {
  decodeText,
  delimiterForPath,
  detectDelimiter,
  parseDelimited,
  type CsvSheet,
} from "./parse-csv";

function grid(sheet: CsvSheet): string[][] {
  return Array.from({ length: sheet.rowCount }, (_, row) =>
    Array.from({ length: sheet.colCount }, (_, col) => sheet.rows.get(row)?.get(col)?.text ?? ""),
  );
}

describe("parseDelimited", () => {
  it("reads plain rows, ignoring the trailing newline", () => {
    const sheet = parseDelimited("name,qty\nApple,3\nPear,12\n", ",");
    expect(grid(sheet)).toEqual([
      ["name", "qty"],
      ["Apple", "3"],
      ["Pear", "12"],
    ]);
    expect(sheet.truncated).toBe(false);
  });

  it("handles quotes, doubled quotes, embedded separators and line breaks", () => {
    const sheet = parseDelimited('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z', ",");
    expect(grid(sheet)).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("keeps text after a closing quote and survives an unterminated quote", () => {
    expect(grid(parseDelimited('"a"b,c', ","))).toEqual([["ab", "c"]]);
    expect(grid(parseDelimited('x,"open', ","))).toEqual([["x", "open"]]);
  });

  it("strips a BOM, keeps blank lines and ragged rows, counts a trailing separator", () => {
    const sheet = parseDelimited("﻿a;b\n\nc;d;e;", ";");
    expect(grid(sheet)).toEqual([
      ["a", "b", "", ""],
      ["", "", "", ""],
      ["c", "d", "e", ""],
    ]);
    expect(sheet.colCount).toBe(4);
  });

  it("returns an empty sheet for empty text", () => {
    const sheet = parseDelimited("", null);
    expect(sheet.rowCount).toBe(0);
    expect(sheet.colCount).toBe(0);
  });

  it("right-aligns numbers only", () => {
    const sheet = parseDelimited('12,-3.5,1 234,"4,5",12%,1e3,v1.2.3,06 12 34,abc', ",");
    const numeric = Array.from({ length: sheet.colCount }, (_, col) =>
      Boolean(sheet.rows.get(0)?.get(col)?.numeric),
    );
    expect(numeric).toEqual([true, true, true, true, true, true, false, false, false]);
  });

  it("clips to the row and column caps", () => {
    const wide = parseDelimited(Array.from({ length: MAX_COLS + 5 }, () => "v").join(","), ",");
    expect(wide.colCount).toBe(MAX_COLS);
    expect(wide.truncated).toBe(true);
    const tall = parseDelimited("v\n".repeat(MAX_ROWS + 2), ",");
    expect(tall.rowCount).toBe(MAX_ROWS);
    expect(tall.truncated).toBe(true);
    expect(parseDelimited("v\n".repeat(MAX_ROWS), ",").truncated).toBe(false);
  });
});

describe("detectDelimiter", () => {
  it("picks the separator that splits every line evenly", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter('nom;prix\n"Pomme, rouge";1,5\nPoire;2,25')).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("ignores separators inside quotes and defaults to comma", () => {
    expect(detectDelimiter('"a;b;c",d\n"e;f",g')).toBe(",");
    expect(detectDelimiter("single column\nvalue")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });

  it("is forced to tab for .tsv files", () => {
    expect(delimiterForPath("data/export.TSV")).toBe("\t");
    expect(delimiterForPath("data/export.csv")).toBeNull();
  });
});

describe("decodeText", () => {
  const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

  it("decodes UTF-8 and drops its BOM", () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9))).toBe("café");
  });

  it("falls back to Windows-1252 for invalid UTF-8", () => {
    // 0x80–0x9f are left out: Node's decoder maps them as ISO-8859-1, not WHATWG 1252.
    expect(decodeText(bytes(0x63, 0x61, 0x66, 0xe9, 0x3b, 0xe0))).toBe("café;à");
  });

  it("decodes UTF-16 with a BOM", () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x61, 0x00, 0x09, 0x00, 0x62, 0x00))).toBe("a\tb");
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x61))).toBe("a");
  });
});
