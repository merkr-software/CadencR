import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();

// pdf.js and its worker are heavy and browser-only; mock both so the
// extraction logic can be tested in jsdom without loading the real lib.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "blob:worker" }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument,
}));

import { extractPdfText } from "./pdf-text";

/** Build a fake PDFDocumentProxy whose pages yield the given text items. */
function fakeDoc(pages: string[][]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (pageNumber: number) => ({
      getTextContent: vi.fn(async () => ({
        items: pages[pageNumber - 1].map((str) => ({ str })),
      })),
    })),
    destroy: vi.fn(async () => {}),
  };
}

function mockPdf(pages: string[][]): void {
  getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc(pages)) });
}

describe("extractPdfText", () => {
  beforeEach(() => getDocument.mockReset());

  it("joins page text, with a blank line between pages", async () => {
    mockPdf([
      ["Hello", "world"],
      ["Page", "two"],
    ]);
    expect(await extractPdfText(new ArrayBuffer(8))).toBe("Hello world\n\nPage two");
  });

  it("drops pages that have no text", async () => {
    mockPdf([["only"], [""]]);
    expect(await extractPdfText(new ArrayBuffer(8))).toBe("only");
  });

  it("returns an empty string for a scanned / image-only PDF", async () => {
    mockPdf([[""], [""]]);
    expect(await extractPdfText(new ArrayBuffer(8))).toBe("");
  });
});
