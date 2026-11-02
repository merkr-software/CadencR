import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_CONFIG, LEGACY_PROVIDER_LOGOS_KEY } from "./sidebar-config";
import {
  matchSidebarPreset,
  nearestSidebarPreset,
  SIDEBAR_PRESETS,
  sidebarDisplayValues,
  sidebarPresetValues,
} from "./sidebar-presets";

describe("sidebar presets", () => {
  it("makes Classic the defaults", () => {
    expect(matchSidebarPreset(DEFAULT_SIDEBAR_CONFIG)).toBe("classic");
    expect(Object.values(sidebarPresetValues("classic")).every((value) => value === null)).toBe(
      true,
    );
  });

  it("recognizes each preset and nothing once an option is customized", () => {
    for (const preset of SIDEBAR_PRESETS) {
      expect(matchSidebarPreset(preset.config)).toBe(preset.id);
    }
    expect(matchSidebarPreset({ ...DEFAULT_SIDEBAR_CONFIG, density: "spacious" })).toBeNull();
  });

  it("keeps the presets far enough apart that no two read alike", () => {
    for (const preset of SIDEBAR_PRESETS) {
      const config = preset.config;
      for (const other of SIDEBAR_PRESETS) {
        if (other.id === preset.id) continue;
        const differing = Object.keys(config).filter(
          (key) => config[key as keyof typeof config] !== other.config[key as keyof typeof config],
        );
        expect(differing.length, `${preset.id} vs ${other.id}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("names the preset a customized sidebar came from and how far it moved", () => {
    const focus = SIDEBAR_PRESETS.find((preset) => preset.id === "focus");
    if (!focus) throw new Error("Focus preset missing");
    const moved = nearestSidebarPreset({ ...focus.config, time: "relative", density: "compact" });
    expect([moved.preset.id, moved.changes]).toEqual(["focus", 2]);
    const classic = nearestSidebarPreset(DEFAULT_SIDEBAR_CONFIG);
    expect([classic.preset.id, classic.changes]).toEqual(["classic", 0]);
  });

  it("leaves behaviour switches out of presets", () => {
    expect(matchSidebarPreset({ ...DEFAULT_SIDEBAR_CONFIG, typeToFilter: false })).toBe("classic");
    const values = sidebarPresetValues("focus");
    expect(values).not.toHaveProperty("sidebar_type_to_filter");
    expect(values).not.toHaveProperty("sidebar_block_order");
    expect(values).not.toHaveProperty("sidebar_folded_blocks");
    expect(values).not.toHaveProperty("sidebar_reveal_active");
    expect(values).not.toHaveProperty("sidebar_gate_popover");
    expect(values).not.toHaveProperty("sidebar_auto_collapse");
    expect(matchSidebarPreset({ ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" })).toBe("classic");
  });

  it("sets and clears the block switches with the rest", () => {
    expect(sidebarPresetValues("supervise")).toMatchObject({
      sidebar_block_working: "true",
      sidebar_block_recent: null,
      sidebar_for_me_limit: "all",
    });
    expect(sidebarPresetValues("focus")).toMatchObject({
      sidebar_for_me_limit: null,
      sidebar_block_counts: "dot",
      sidebar_flash_on_change: "false",
    });
  });

  it("writes a preset's own values and clears every other key", () => {
    const values = sidebarPresetValues("detailed");
    expect(values).toMatchObject({
      sidebar_density: null,
      sidebar_title_lines: null,
      sidebar_row_worktree_icon: "false",
      sidebar_row_height: "fixed",
      sidebar_color_mode: "increased",
      sidebar_row_branch: "true",
      sidebar_row_ports: null,
      [LEGACY_PROVIDER_LOGOS_KEY]: null,
    });
  });

  it("puts back a whole config for undo, clearing the options at their default", () => {
    const values = sidebarDisplayValues({ ...DEFAULT_SIDEBAR_CONFIG, density: "spacious" });
    expect(values).toMatchObject({
      sidebar_density: "spacious",
      sidebar_row_time: null,
      [LEGACY_PROVIDER_LOGOS_KEY]: null,
    });
    expect(values).not.toHaveProperty("sidebar_type_to_filter");
    expect(values).not.toHaveProperty("sidebar_block_order");
    expect(values).not.toHaveProperty("sidebar_folded_blocks");
  });
});
