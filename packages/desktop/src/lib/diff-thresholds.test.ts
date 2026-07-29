import { describe, expect, it } from "vitest";
import { isLargeDiff, LARGE_DIFF_BYTES, utf8ByteLength } from "./diff-thresholds";

describe("diff-thresholds", () => {
  it("measures multibyte content using encoded UTF-8 bytes", () => {
    const cjkContent = "界".repeat(70_000);

    expect(cjkContent.length).toBeLessThan(LARGE_DIFF_BYTES);
    expect(utf8ByteLength(cjkContent)).toBe(210_000);
    expect(isLargeDiff(0, utf8ByteLength(cjkContent))).toBe(true);
  });
});
