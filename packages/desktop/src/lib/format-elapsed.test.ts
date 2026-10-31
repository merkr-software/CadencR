import { describe, expect, it } from "vitest";
import { formatElapsed } from "./format-elapsed";

describe("formatElapsed", () => {
  it("formats minutes and hours", () => {
    expect(formatElapsed(7_000)).toBe("0:07");
    expect(formatElapsed(247_000)).toBe("4:07");
    expect(formatElapsed(3_765_000)).toBe("1:02:45");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});
