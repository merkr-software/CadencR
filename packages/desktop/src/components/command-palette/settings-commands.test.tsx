import { createInstance } from "i18next";
import { rankCommands, type RankContext } from "@/lib/command-palette/palette-ranking";
import { queryTokens } from "@/lib/command-palette/palette-score";
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

  it("searches translated and English labels with the same command id and settings anchor", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "fr",
      defaultNS: "ui",
      resources: {
        fr: {
          ui: {
            palette: { settings: { title: "Réglages · {{label}}" } },
            settings: { nav: { editor: { entries: { "vim-mode": { label: "Émulation Vim" } } } } },
          },
        },
      },
    });
    const navigate = vi.fn();
    const list = settingsCommands(navigate as never, i18n.getFixedT("fr", "ui"));
    const context: RankContext = {
      activeFeatureId: null,
      activeProjectId: null,
      attention: new Map(),
      projectNames: new Map(),
      frecency: {},
      now: 0,
      scope: "all",
    };
    for (const query of ["émulation vim", "vim mode"]) {
      const entries = rankCommands(queryTokens(query), list, context, 6).entries;
      const command = entries.find(
        ({ command }) => command.id === "settings-editor-vim-mode",
      )?.command;
      expect(command?.title, query).toBe("Réglages · Émulation Vim");
      void command?.run?.();
    }
    expect(navigate.mock.calls).toEqual([
      [{ to: "/settings", search: { section: "editing" } }],
      [{ to: "/settings", search: { section: "editing" } }],
    ]);
  });
});
