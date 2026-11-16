import { beforeEach, describe, expect, it } from "vitest";
import {
  clearProjectAutoExpandSkip,
  shouldSkipProjectAutoExpand,
  skipProjectAutoExpand,
} from "./project-auto-expand";

describe("project auto-expand skip marker", () => {
  beforeEach(() => {
    clearProjectAutoExpandSkip();
  });

  it("skips only the marked project", () => {
    skipProjectAutoExpand(1);
    expect(shouldSkipProjectAutoExpand(1)).toBe(true);
    expect(shouldSkipProjectAutoExpand(2)).toBe(false);
  });

  it("does not consume the marker on read, so StrictMode's double-invoked effect stays consistent", () => {
    skipProjectAutoExpand(1);
    expect(shouldSkipProjectAutoExpand(1)).toBe(true);
    expect(shouldSkipProjectAutoExpand(1)).toBe(true);
  });

  it("clears the marker", () => {
    skipProjectAutoExpand(1);
    clearProjectAutoExpandSkip();
    expect(shouldSkipProjectAutoExpand(1)).toBe(false);
  });
});
