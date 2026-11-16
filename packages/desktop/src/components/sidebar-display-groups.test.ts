import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDEBAR_OPTIONS } from "@/lib/sidebar-config";
import { DISPLAY_GROUPS, resolveDisplayItem } from "./sidebar-display-groups";
import { ROW_ELEMENTS } from "./sidebar-display-rows";

describe("DISPLAY_GROUPS", () => {
  it("lays out every option exactly once, row elements in their grid, folds in the sidebar", () => {
    const grouped = DISPLAY_GROUPS.flatMap((group) => group.items).filter(
      (item) => item !== "rowElements",
    );
    // Folds are set from each section's header, not from the options.
    const all = [...grouped, ...ROW_ELEMENTS.map((element) => element.id), "foldedSections"];
    expect([...all].sort()).toEqual(Object.keys(SIDEBAR_OPTIONS).sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("resolves every item to a control", () => {
    for (const item of DISPLAY_GROUPS.flatMap((group) => group.items)) {
      expect(() => resolveDisplayItem(item)).not.toThrow();
    }
  });

  it("outlines only real options when one is pointed at", () => {
    const css = readFileSync(new URL("../sidebar-rows.css", import.meta.url), "utf8");
    const highlighted = [...css.matchAll(/data-sidebar-highlight="(\w+)"/g)].map(
      (match) => match[1],
    );
    expect(highlighted.length).toBeGreaterThan(0);
    for (const option of highlighted) expect(Object.keys(SIDEBAR_OPTIONS)).toContain(option);
  });
});
