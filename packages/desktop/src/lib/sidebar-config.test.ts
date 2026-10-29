import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_CONFIG,
  LEGACY_PROVIDER_LOGOS_KEY,
  parseSidebarConfig,
  SIDEBAR_SETTING_KEYS,
  serializeSidebarOption,
} from "./sidebar-config";

function reader(values: Record<string, string>) {
  return (key: string): string | undefined => values[key];
}

describe("parseSidebarConfig", () => {
  it("reads typed values and falls back on unset or invalid ones", () => {
    const config = parseSidebarConfig(
      reader({ sidebar_density: "compact", sidebar_row_diff: "false", sidebar_font_size: "99" }),
    );
    expect(config.density).toBe("compact");
    expect(config.diff).toBe(false);
    expect(config.fontSize).toBe(DEFAULT_SIDEBAR_CONFIG.fontSize);
    expect(config.time).toBe("relative");
  });

  it("keeps provider logos off for users who turned the old switch off", () => {
    expect(parseSidebarConfig(reader({ [LEGACY_PROVIDER_LOGOS_KEY]: "false" })).provider).toBe(
      "hidden",
    );
    expect(
      parseSidebarConfig(
        reader({ [LEGACY_PROVIDER_LOGOS_KEY]: "false", sidebar_row_provider: "logo_model" }),
      ).provider,
    ).toBe("logo_model");
  });

  it("lists the legacy key among the keys a reset clears", () => {
    expect(SIDEBAR_SETTING_KEYS).toContain(LEGACY_PROVIDER_LOGOS_KEY);
    expect(SIDEBAR_SETTING_KEYS).toContain("sidebar_density");
  });

  it("serializes booleans the way the settings file stores them", () => {
    expect(serializeSidebarOption(false)).toBe("false");
    expect(serializeSidebarOption("compact")).toBe("compact");
    expect(serializeSidebarOption(["projects", "pinned"])).toBe("projects,pinned");
  });

  it("keeps every section once in the block order, missing ones at their default place", () => {
    expect(DEFAULT_SIDEBAR_CONFIG.sectionOrder).toEqual([
      "for-me",
      "working",
      "recent",
      "pinned",
      "projects",
    ]);
    const config = parseSidebarConfig(
      reader({ sidebar_block_order: "projects,bogus,pinned,projects" }),
    );
    expect(config.sectionOrder).toEqual(["projects", "pinned", "for-me", "working", "recent"]);
  });

  it("reads folded sections as a subset, empty by default", () => {
    expect(DEFAULT_SIDEBAR_CONFIG.foldedSections).toEqual([]);
    expect(parseSidebarConfig(reader({ sidebar_folded_blocks: "" })).foldedSections).toEqual([]);
    expect(
      parseSidebarConfig(reader({ sidebar_folded_blocks: "pinned,nope,projects" })).foldedSections,
    ).toEqual(["pinned", "projects"]);
  });
});
