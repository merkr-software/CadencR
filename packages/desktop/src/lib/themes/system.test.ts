import { describe, expect, it } from "vitest";
import { getTheme } from "./registry";
import { setManagedThemes } from "./user-registry";
import {
  DEFAULT_SYSTEM_DARK_THEME_ID,
  DEFAULT_SYSTEM_LIGHT_THEME_ID,
  isFollowSystemThemeEnabled,
  parseSystemAppearance,
  resolveActiveThemeId,
} from "./system";

describe("system theme resolution", () => {
  it("resolves saved managed system references only for the effective mode and appearance", () => {
    setManagedThemes([{ ...getTheme("cadencr-dark"), id: "managed:midnight" }]);
    const selection = {
      manualTheme: "cadencr-light",
      systemLightTheme: "cadencr-light",
      systemDarkTheme: "managed:midnight",
    };
    expect(
      resolveActiveThemeId({ ...selection, followSystem: false, systemAppearance: "dark" }),
    ).toBe("cadencr-light");
    expect(
      resolveActiveThemeId({ ...selection, followSystem: true, systemAppearance: "dark" }),
    ).toBe("managed:midnight");
    expect(
      resolveActiveThemeId({ ...selection, followSystem: true, systemAppearance: "light" }),
    ).toBe("cadencr-light");
    setManagedThemes([]);
  });

  it("uses the manual theme when follow-system is disabled", () => {
    expect(
      resolveActiveThemeId({
        followSystem: false,
        manualTheme: "aurora",
        systemLightTheme: "dracula",
        systemDarkTheme: "dracula",
        systemAppearance: "dark",
      }),
    ).toBe("aurora");
  });

  it("uses the configured light theme when follow-system sees a light system theme", () => {
    expect(
      resolveActiveThemeId({
        followSystem: true,
        manualTheme: "dracula",
        systemLightTheme: "aurora",
        systemDarkTheme: "dracula",
        systemAppearance: "light",
      }),
    ).toBe("aurora");
  });

  it("uses the configured dark theme when follow-system sees a dark system theme", () => {
    expect(
      resolveActiveThemeId({
        followSystem: true,
        manualTheme: "aurora",
        systemLightTheme: "aurora",
        systemDarkTheme: "dracula",
        systemAppearance: "dark",
      }),
    ).toBe("dracula");
  });

  it("falls back to appearance-specific defaults for invalid synced theme ids", () => {
    expect(
      resolveActiveThemeId({
        followSystem: true,
        manualTheme: "aurora",
        systemLightTheme: "missing",
        systemDarkTheme: "missing",
        systemAppearance: "light",
      }),
    ).toBe(DEFAULT_SYSTEM_LIGHT_THEME_ID);

    expect(
      resolveActiveThemeId({
        followSystem: true,
        manualTheme: "aurora",
        systemLightTheme: "missing",
        systemDarkTheme: "missing",
        systemAppearance: "dark",
      }),
    ).toBe(DEFAULT_SYSTEM_DARK_THEME_ID);
  });

  it("parses persisted follow-system and system appearance values", () => {
    expect(isFollowSystemThemeEnabled("true")).toBe(true);
    expect(isFollowSystemThemeEnabled("false")).toBe(false);
    expect(isFollowSystemThemeEnabled(null)).toBe(false);
    expect(parseSystemAppearance("light")).toBe("light");
    expect(parseSystemAppearance("dark")).toBe("dark");
    expect(parseSystemAppearance(null)).toBe("dark");
  });
});
