import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_CONFIG } from "./sidebar-config";
import { moveWithinGroup } from "./sidebar-manual-order";
import { foldSection, shiftSection } from "./sidebar-sections";

const ORDER = DEFAULT_SIDEBAR_CONFIG.sectionOrder;

describe("moveWithinGroup over sections", () => {
  it("drops a section before or after another", () => {
    expect(moveWithinGroup(ORDER, "projects", "for-me", "before")).toEqual([
      "projects",
      "for-me",
      "working",
      "recent",
      "pinned",
    ]);
    expect(moveWithinGroup(ORDER, "pinned", "for-me", "after")).toEqual([
      "for-me",
      "pinned",
      "working",
      "recent",
      "projects",
    ]);
  });

  it("says when nothing moves", () => {
    expect(moveWithinGroup(ORDER, "pinned", "pinned", "before")).toBeNull();
    expect(moveWithinGroup(ORDER, "pinned", "projects", "before")).toBeNull();
    expect(moveWithinGroup(ORDER, "working", "for-me", "after")).toBeNull();
  });
});

describe("shiftSection", () => {
  it("moves a section one place, and stops at either end", () => {
    expect(shiftSection(ORDER, "pinned", "up")).toEqual([
      "for-me",
      "working",
      "pinned",
      "recent",
      "projects",
    ]);
    expect(shiftSection(ORDER, "for-me", "up")).toBeNull();
    expect(shiftSection(ORDER, "projects", "down")).toBeNull();
  });
});

describe("foldSection", () => {
  it("adds or removes a section once", () => {
    expect(foldSection([], "projects", true)).toEqual(["projects"]);
    expect(foldSection(["projects"], "projects", true)).toEqual(["projects"]);
    expect(foldSection(["pinned", "projects"], "pinned", false)).toEqual(["projects"]);
  });
});
