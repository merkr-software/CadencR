// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyThemeToDocument, readPersistedTheme, writePersistedThemeSettings } from "./apply";
import { setUserThemes } from "./user-registry";
import { chromeOf } from "./chrome";
import { FROST_DARK_THEME } from "./frost-dark";

describe("theme paint hint", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-appearance");
    document.documentElement.removeAttribute("data-texture-base");
    document.documentElement.style.removeProperty("--ambient-base");
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("sets data-theme and data-appearance on the document", () => {
    applyThemeToDocument("aurora");
    expect(document.documentElement.dataset.theme).toBe("aurora");
    expect(document.documentElement.dataset.appearance).toBe("light");

    applyThemeToDocument("dracula");
    expect(document.documentElement.dataset.theme).toBe("dracula");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("publishes the theme's chassis and tab style for the stylesheets", () => {
    applyThemeToDocument("cadencr-dark");
    expect(document.documentElement.dataset.chassis).toBe("rail");
    expect(document.documentElement.dataset.tabs).toBe("segmented");

    // A theme that declares no chrome gets the plain default, and must not
    // inherit the shape of whatever was applied before it.
    applyThemeToDocument("dracula");
    expect(document.documentElement.dataset.chassis).toBe("flat");
    expect(document.documentElement.dataset.tabs).toBe("underline");
  });

  it("hands the backdrop root to a texture that declares an opaque base", () => {
    // Frost's base is what makes `backdrop-filter` paint: the backdrop root has
    // to be opaque, so the color has to reach `<html>` itself.
    applyThemeToDocument("frost-dark");
    expect(document.documentElement.dataset.textureBase).toBe("on");
    expect(document.documentElement.style.getPropertyValue("--ambient-base")).not.toBe("");

    applyThemeToDocument("dracula");
    expect(document.documentElement.dataset.textureBase).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--ambient-base")).toBe("");
  });

  it("never hands the backdrop root to a texture that has no opaque base", () => {
    // Otherwise `body` loses its background to make room for a color that was
    // never set, and the canvas shows through as the browser default white.
    const frost = chromeOf(FROST_DARK_THEME);
    setUserThemes([
      {
        ...FROST_DARK_THEME,
        id: "user:halos-only",
        chrome: { ...frost, texture: { ...frost.texture, base: null } },
      },
    ]);

    applyThemeToDocument("user:halos-only");
    expect(document.documentElement.dataset.textureBase).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--ambient-base")).toBe("");
    setUserThemes([]);
  });

  it("resolves the cached light system theme before React mounts", () => {
    writePersistedThemeSettings({
      followSystem: true,
      manualTheme: "dracula",
      systemLightTheme: "aurora",
      systemDarkTheme: "dracula",
    });

    expect(readPersistedTheme()).toBe("aurora");
  });

  it("resolves the cached dark system theme before React mounts", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    writePersistedThemeSettings({
      followSystem: true,
      manualTheme: "aurora",
      systemLightTheme: "aurora",
      systemDarkTheme: "dracula",
    });

    expect(readPersistedTheme()).toBe("dracula");
  });
});
