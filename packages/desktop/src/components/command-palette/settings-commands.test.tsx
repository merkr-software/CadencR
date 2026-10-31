import { describe, expect, it, vi } from "vitest";
import { resolveSettingsTarget, SETTINGS_PAGES } from "@/components/settings/settings-catalog";
import { settingsCommands } from "./usePaletteCommands";

function commands() {
  const navigate = vi.fn();
  return { navigate, list: settingsCommands(navigate as never) };
}

describe("settingsCommands", () => {
  it("gives every page and setting its own command id", () => {
    const ids = commands().list.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of SETTINGS_PAGES) expect(ids).toContain(`settings-${page.id}`);
  });

  it("opens a section the settings page resolves", () => {
    const { navigate, list } = commands();
    for (const command of list) void command.run?.();
    expect(navigate).toHaveBeenCalledTimes(list.length);
    for (const [options] of navigate.mock.calls as [{ search: { section: string } }][]) {
      expect(resolveSettingsTarget(options.search.section), options.search.section).not.toBeNull();
    }
  });

  it("opens a setting at its anchor", () => {
    const { navigate, list } = commands();
    void list.find((command) => command.id === "settings-editor-vim-mode")?.run?.();
    expect(navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "editing" } });
  });
});
