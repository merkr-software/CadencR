import { describe, expect, it } from "vitest";
import { DEFAULT_VIM_MODE_LEVEL, parseVimModeLevel, VIM_MODE_LEVELS } from "./vim-mode-level";

describe("VIM_MODE_LEVELS", () => {
  it("has exactly three levels: off, vim motion, full neovim", () => {
    expect(VIM_MODE_LEVELS).toEqual(["0", "1", "2"]);
  });
});

describe("parseVimModeLevel", () => {
  it("accepts each valid level", () => {
    expect(parseVimModeLevel("0")).toBe("0");
    expect(parseVimModeLevel("1")).toBe("1");
    expect(parseVimModeLevel("2")).toBe("2");
  });

  it("falls back to the default for an unknown or stale value", () => {
    // "3" existed before this migration (old "full UI integration" level);
    // a workspace that persisted it before upgrading must not crash — it
    // silently falls back to the default rather than being treated as valid.
    expect(parseVimModeLevel("3")).toBe(DEFAULT_VIM_MODE_LEVEL);
    expect(parseVimModeLevel(null)).toBe(DEFAULT_VIM_MODE_LEVEL);
    expect(parseVimModeLevel(undefined)).toBe(DEFAULT_VIM_MODE_LEVEL);
    expect(parseVimModeLevel("garbage")).toBe(DEFAULT_VIM_MODE_LEVEL);
  });
});
