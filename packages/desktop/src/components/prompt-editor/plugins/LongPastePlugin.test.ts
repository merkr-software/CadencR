import { describe, expect, it } from "vitest";
import { isLongPaste, LONG_PASTE_MIN_CHARS, LONG_PASTE_MIN_LINES } from "./LongPastePlugin";

describe("isLongPaste", () => {
  it("chips pastes past either threshold and leaves ordinary ones inline", () => {
    expect(isLongPaste("short")).toBe(false);
    expect(isLongPaste("x".repeat(LONG_PASTE_MIN_CHARS))).toBe(true);
    expect(isLongPaste(Array.from({ length: LONG_PASTE_MIN_LINES }, () => "a").join("\n"))).toBe(
      true,
    );
  });
});
