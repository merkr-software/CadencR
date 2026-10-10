// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserThemesVersion,
  getUserTheme,
  listUserThemes,
  setUserThemes,
  subscribeUserThemes,
} from "./user-registry";
import { getTheme, isThemeId, parseThemeId, DEFAULT_THEME_ID } from "./registry";
import { toThemeDefinition } from "./user-theme";
import { DRACULA_THEME } from "./dracula";
import type { ThemeDocument } from "@/api/generated";

const DOC = {
  label: "Mine",
  appearance: "dark",
  cssVars: DRACULA_THEME.cssVars,
  xterm: DRACULA_THEME.xterm,
} as unknown as ThemeDocument;

describe("user theme registry", () => {
  beforeEach(() => {
    setUserThemes([]);
  });

  it("makes a registered user id resolvable and applicable", () => {
    expect(isThemeId("user:mine")).toBe(false);
    setUserThemes([toThemeDefinition("mine", DOC)]);
    expect(isThemeId("user:mine")).toBe(true);
    expect(getUserTheme("user:mine")?.label).toBe("Mine");
    expect(getTheme("user:mine").cssVars?.["--background"]).toBe(
      DRACULA_THEME.cssVars?.["--background"],
    );
    expect(listUserThemes()).toHaveLength(1);
  });

  it("falls back to the default for an id that is not registered", () => {
    // A deleted, disabled or invalid theme must resolve to something that
    // paints, never to an empty definition.
    expect(parseThemeId("user:gone")).toBe(DEFAULT_THEME_ID);
    expect(getTheme("user:gone")).toBe(getTheme(DEFAULT_THEME_ID));
  });

  it("notifies subscribers and bumps the version only when the set changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUserThemes(listener);
    const before = getUserThemesVersion();

    setUserThemes([toThemeDefinition("mine", DOC)]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getUserThemesVersion()).toBe(before + 1);

    // Re-registering identical data must be a no-op: the caller runs on every
    // refetch, and notifying would re-apply the theme each time.
    setUserThemes([toThemeDefinition("mine", DOC)]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getUserThemesVersion()).toBe(before + 1);

    unsubscribe();
    setUserThemes([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("mirrors the registry into localStorage for the pre-paint hint", () => {
    setUserThemes([toThemeDefinition("mine", DOC)]);
    const cached: unknown = JSON.parse(window.localStorage.getItem("cadencr.theme.user") ?? "[]");
    expect(Array.isArray(cached) && cached).toHaveLength(1);
  });
});
