import { describe, expect, it } from "vitest";
import { parseFormulaRecalc, shareDocumentPayload, type DocumentPayload } from "./document-file";

describe("parseFormulaRecalc", () => {
  it("is null when the workbook carried its own results", () => {
    expect(parseFormulaRecalc(undefined)).toBeNull();
    expect(parseFormulaRecalc("")).toBeNull();
  });

  it("reads the computed and unresolved counts", () => {
    expect(parseFormulaRecalc("computed=27&unresolved=2")).toEqual({
      status: "computed",
      computed: 27,
      unresolved: 2,
    });
  });

  it("decodes a failure reason", () => {
    expect(
      parseFormulaRecalc("error=The%20formula%20engine%20crashed%20on%20this%20workbook"),
    ).toEqual({ status: "failed", reason: "The formula engine crashed on this workbook" });
  });

  it("reports an unreadable summary instead of guessing", () => {
    expect(parseFormulaRecalc("computed=lots&unresolved=0")).toEqual({
      status: "failed",
      reason: "Unreadable recalculation summary: computed=lots&unresolved=0",
    });
    expect(parseFormulaRecalc("computed=3")).toEqual({
      status: "failed",
      reason: "Unreadable recalculation summary: computed=3",
    });
  });
});

describe("shareDocumentPayload", () => {
  const payload = (bytes: number[], computed = 1): DocumentPayload => ({
    bytes: new Uint8Array(bytes).buffer,
    formulas: { status: "computed", computed, unresolved: 0 },
  });

  it("keeps the previous payload for the same bytes and summary", () => {
    const previous = payload([1, 2, 3]);
    expect(shareDocumentPayload(previous, payload([1, 2, 3]))).toBe(previous);
  });

  it("takes the new payload when the bytes or the summary changed", () => {
    const next = payload([1, 2, 4]);
    expect(shareDocumentPayload(payload([1, 2, 3]), next)).toBe(next);
    const recounted = payload([1, 2, 3], 2);
    expect(shareDocumentPayload(payload([1, 2, 3]), recounted)).toBe(recounted);
  });
});
