import { describe, expect, it } from "vitest";
import { isLegacyMarketplaceLink, parseSettingsSearch } from "./settings-navigation";
import { NAV_GROUPS } from "./settings-nav-groups";

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
    expect(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))).toContain(
      "custom-tabs",
    );
  });

  it("does not offer Marketplace as a general scrolling section", () => {
    const sections = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(sections).not.toContain("marketplace");
    expect(sections).toContain("appearance");
    expect(sections).toContain("providers");
  });
});
