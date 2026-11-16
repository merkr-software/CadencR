import { describe, expect, it } from "vitest";
import { fitColumnWidths } from "./column-widths";
import { parseDelimited } from "./parse-csv";

const sevenPerChar = { text: (text: string): number => text.length * 7, chrome: 19 };

describe("fitColumnWidths", () => {
  it("sizes each column to its widest value plus the cell chrome", () => {
    const sheet = fitColumnWidths(
      parseDelimited("Region,July\nNorth America,182000\nEurope,54300", ","),
      sevenPerChar,
    );
    // "North America": 13 × 7 + 19; "182000": 6 × 7 + 19.
    expect(sheet.colWidths).toEqual([110, 61]);
  });

  it("keeps widths within readable bounds", () => {
    const sheet = fitColumnWidths(parseDelimited(`a,${"x".repeat(200)}`, ","), sevenPerChar);
    expect(sheet.colWidths).toEqual([48, 320]);
  });

  it("measures numbers with every digit as wide as a zero (tabular digits)", () => {
    const measured: string[] = [];
    fitColumnWidths(parseDelimited("195500,Q1-2024", ","), {
      text: (text) => {
        measured.push(text);
        return 0;
      },
      chrome: 0,
    });
    expect(measured).toEqual(["000000", "Q1-2024"]);
  });

  it("measures line breaks as spaces, the way the grid shows them", () => {
    const measured: string[] = [];
    fitColumnWidths(parseDelimited('"two\nlines"', ","), {
      text: (text) => {
        measured.push(text);
        return 0;
      },
      chrome: 0,
    });
    expect(measured).toEqual(["two lines"]);
  });
});
