import { describe, expect, it } from "vitest";
import { msUntilNextTick } from "./useNow";

describe("msUntilNextTick", () => {
  it("waits for the anchor's own next whole second, not the wall clock's", () => {
    expect(msUntilNextTick(10_250, 9_000, 1_000)).toBe(755);
    expect(msUntilNextTick(10_250, 9_600, 1_000)).toBe(355);
  });

  it("waits a full interval on a boundary and handles an anchor in the future", () => {
    expect(msUntilNextTick(10_000, 9_000, 1_000)).toBe(1_005);
    expect(msUntilNextTick(10_000, 10_400, 1_000)).toBe(405);
  });
});
