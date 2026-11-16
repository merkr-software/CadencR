import { describe, expect, it } from "vitest";
import { firstSearchTarget, highlightRanges, searchSettings } from "./settings-search";

function flatten(query: string): string[] {
  return searchSettings(query).flatMap((group) =>
    group.pages.flatMap(({ page, entries }) => [
      page.id,
      ...entries.map((entry) => `${page.id}/${entry.label}`),
    ]),
  );
}

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings("   ")).toEqual([]);
  });

  it("answers a page name with the page alone", () => {
    const [group] = searchSettings("appearance");
    expect(group?.pages).toHaveLength(1);
    expect(group?.pages[0]?.pageMatched).toBe(true);
    expect(group?.pages[0]?.entries).toEqual([]);
  });

  it("finds a setting by its label or keywords, case- and accent-blind", () => {
    expect(flatten("VIM")).toEqual(["editor", "editor/Vim mode"]);
    expect(flatten("néovim")).toEqual(["editor", "editor/Vim mode"]);
    expect(flatten("bitbucket")).toEqual(["git", "git/Remote connections"]);
  });

  it("finds a page by a retired section's name", () => {
    expect(flatten("interface")).toEqual(["general"]);
  });

  it("lets a page's name narrow its settings", () => {
    expect(flatten("editor vim")).toEqual(["editor", "editor/Vim mode"]);
    expect(flatten("cli providers")).toContain("providers/Provider versions & updates");
  });

  it("requires every word to match", () => {
    expect(flatten("browser tools")).toContain("mcp/Browser tools for agents");
    expect(flatten("browser zebra")).toEqual([]);
  });

  it("keeps the rail's group order", () => {
    expect(searchSettings("mode").map((group) => group.label)).toEqual([
      "Preferences",
      "Agents",
      "Tools",
    ]);
  });

  it("opens the first result's anchor, else its page", () => {
    expect(firstSearchTarget(searchSettings("blame"))).toBe("editing");
    expect(firstSearchTarget(searchSettings("storage"))).toBe("storage");
    expect(firstSearchTarget([])).toBeNull();
  });
});

describe("highlightRanges", () => {
  it("marks every occurrence of each word, merged and in order", () => {
    expect(highlightRanges("Vim mode", "mo vi")).toEqual([
      [0, 2],
      [4, 6],
    ]);
    expect(highlightRanges("Auto-save", "auto save")).toEqual([
      [0, 4],
      [5, 9],
    ]);
  });

  it("keeps offsets on accented text", () => {
    expect(highlightRanges("Résumé mode", "resume")).toEqual([[0, 6]]);
  });

  it("marks nothing without a query", () => {
    expect(highlightRanges("Git", "")).toEqual([]);
  });
});
