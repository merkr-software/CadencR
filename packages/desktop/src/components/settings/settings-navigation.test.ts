import { describe, expect, it } from "vitest";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { isLegacyMarketplaceLink, parseSettingsSearch } from "./settings-navigation";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";
import { SETTINGS_PAGES, resolveSettingsTarget } from "./settings-catalog";

describe("settings navigation", () => {
  it("preserves general section deep links", () => {
    expect(parseSettingsSearch({ section: "appearance" })).toEqual({ section: "appearance" });
    expect(isLegacyMarketplaceLink(parseSettingsSearch({ section: "appearance" }))).toBe(false);
  });

  it("sends old marketplace tab and section links to the Marketplace page", () => {
    expect(isLegacyMarketplaceLink(parseSettingsSearch({ tab: "marketplace" }))).toBe(true);
    expect(isLegacyMarketplaceLink(parseSettingsSearch({ section: "marketplace" }))).toBe(true);
  });

  it("validates unknown URL input without rejecting the page", () => {
    expect(parseSettingsSearch({ tab: 3, section: 42 })).toEqual({
      tab: undefined,
      section: undefined,
    });
  });

  it("keeps the Custom tabs create action and drops unknown actions", () => {
    expect(parseSettingsSearch({ section: "custom-tabs", action: "create" })).toEqual({
      section: "custom-tabs",
      action: "create",
    });
    expect(parseSettingsSearch({ action: "delete" }).action).toBeUndefined();
    expect(resolveSettingsTarget("custom-tabs")?.page.id).toBe("custom-tabs");
  });

  it("does not offer Marketplace as a settings page", () => {
    const pages = SETTINGS_PAGES.map((page) => page.id);
    expect(pages).not.toContain("marketplace");
    expect(pages).toContain("appearance");
    expect(pages).toContain("providers");
  });
});

describe("resolveSettingsTarget", () => {
  // Every section id the single-page settings ever had, and where it lives now.
  it.each([
    ["appearance", "appearance", null],
    ["editor", "editor", null],
    ["interface", "general", "interface"],
    ["sidebar-display", "sidebar", "sidebar-display"],
    ["sidebar-views", "sidebar", "sidebar-views"],
    ["notifications", "notifications", null],
    ["browser", "browser", null],
    ["custom-tabs", "custom-tabs", null],
    ["actions", "actions", null],
    ["storage", "storage", null],
    ["mcp", "mcp", null],
    ["auto-naming", "agents", "auto-naming"],
    ["git", "git", null],
    [FORGE_SETTINGS_ANCHOR, "git", FORGE_SETTINGS_ANCHOR],
    ["providers", "providers", null],
    ["stats", "stats", null],
    ["about", "about", null],
  ])("opens the old %s link on the %s page", (section, page, anchor) => {
    expect(resolveSettingsTarget(section)).toEqual({
      page: expect.objectContaining({ id: page }),
      anchor,
    });
  });

  it("resolves nothing for no or unknown sections", () => {
    expect(resolveSettingsTarget(undefined)).toBeNull();
    expect(resolveSettingsTarget("no-such-section")).toBeNull();
  });

  it("only points entries at anchors the pages know", () => {
    const known = new Set<string>([...Object.values(SETTINGS_ANCHORS), FORGE_SETTINGS_ANCHOR]);
    for (const page of SETTINGS_PAGES) {
      for (const entry of page.entries) {
        if (entry.anchor) expect(known).toContain(entry.anchor);
      }
    }
  });

  it("gives every page and anchor a unique id", () => {
    const pageIds = SETTINGS_PAGES.map((page) => page.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    for (const anchor of Object.values(SETTINGS_ANCHORS)) {
      expect(pageIds).not.toContain(anchor);
    }
  });
});
