import { describe, expect, it } from "vitest";
import { formatAge } from "./notch-format";

describe("formatAge", () => {
  it("compacts ages", () => {
    expect(formatAge(20_000)).toBe("now");
    expect(formatAge(4 * 60_000)).toBe("4m");
    expect(formatAge(2 * 3_600_000)).toBe("2h");
    expect(formatAge(3 * 86_400_000)).toBe("3d");
  });
});
