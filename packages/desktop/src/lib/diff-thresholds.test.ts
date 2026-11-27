import { describe, expect, it } from "vitest";
import { uiI18n } from "./i18n/ui";
import { formatBytes, isLargeDiff, LARGE_DIFF_BYTES, utf8ByteLength } from "./diff-thresholds";

describe("diff-thresholds", () => {
  it("formats binary sizes with the active decimal separator and original precision", () => {
    expect(formatBytes(1536, uiI18n.getFixedT("en", "ui"))).toBe("1.5 KB");
    expect(formatBytes(1536, uiI18n.getFixedT("fr", "ui"))).toBe("1,5 KB");
    expect(formatBytes(1024 ** 3, uiI18n.getFixedT("en", "ui"), "GB")).toBe("1.0 GB");
  });

  it("measures multibyte content using encoded UTF-8 bytes", () => {
    const cjkContent = "界".repeat(70_000);

    expect(cjkContent.length).toBeLessThan(LARGE_DIFF_BYTES);
    expect(utf8ByteLength(cjkContent)).toBe(210_000);
    expect(isLargeDiff(0, utf8ByteLength(cjkContent))).toBe(true);
  });
});
