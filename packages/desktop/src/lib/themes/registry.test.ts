import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_ID, THEME_LIST, getTheme, isThemeId, parseThemeId } from "./registry";

vi.mock("../../../assets/cadencr-logo3.svg", () => ({ default: "cadencr-logo3.svg" }));
vi.mock("../../../assets/cadencr-logo3-light.svg", () => ({
  default: "cadencr-logo3-light.svg",
}));

describe("theme registry", () => {
  it("ships dracula, aurora, one-dark, one-light, monokai, monokai-light, and the frost pair", () => {
    const ids = THEME_LIST.map((t) => t.id);
    expect(ids).toContain("dracula");
    expect(ids).toContain("aurora");
    expect(ids).toContain("one-dark");
    expect(ids).toContain("one-light");
    expect(ids).toContain("monokai");
    expect(ids).toContain("monokai-light");
    expect(ids).toContain("frost-dark");
    expect(ids).toContain("frost-light");
    expect(ids).toContain("carbon-owl");
    expect(ids).toContain("paper-owl");
  });

  it("isThemeId narrows to known ids", () => {
    expect(isThemeId("dracula")).toBe(true);
    expect(isThemeId("aurora")).toBe(true);
    expect(isThemeId("one-dark")).toBe(true);
    expect(isThemeId("one-light")).toBe(true);
    expect(isThemeId("monokai")).toBe(true);
    expect(isThemeId("monokai-light")).toBe(true);
    expect(isThemeId("carbon-owl")).toBe(true);
    expect(isThemeId("paper-owl")).toBe(true);
    expect(isThemeId("solarized")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(isThemeId(42)).toBe(false);
  });

  it("parseThemeId falls back to default for unknown values", () => {
    expect(parseThemeId("aurora")).toBe("aurora");
    expect(parseThemeId("one-dark")).toBe("one-dark");
    expect(parseThemeId("nope")).toBe(DEFAULT_THEME_ID);
    expect(parseThemeId(null)).toBe(DEFAULT_THEME_ID);
  });

  it("getTheme returns a definition with a label and xterm palette", () => {
    const aurora = getTheme("aurora");
    expect(aurora.label).toBe("Aurora");
    expect(aurora.appearance).toBe("light");
    expect(aurora.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);

    const oneLight = getTheme("one-light");
    expect(oneLight.label).toBe("One Light");
    expect(oneLight.appearance).toBe("light");
    expect(oneLight.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("declares appearance and logo choices per theme", () => {
    const dracula = getTheme("dracula");
    const aurora = getTheme("aurora");
    const oneDark = getTheme("one-dark");
    const oneLight = getTheme("one-light");

    expect(dracula.appearance).toBe("dark");
    expect(dracula.logo.variant).toBe("dark");
    expect(dracula.logo.src).toContain("cadencr-logo3.svg");
    expect(dracula.logo.displayScale).toBeCloseTo(1.24);

    expect(aurora.appearance).toBe("light");
    expect(aurora.logo.variant).toBe("light");
    expect(aurora.logo.src).toContain("cadencr-logo3-light.svg");
    expect(aurora.logo.displayScale).toBe(dracula.logo.displayScale);

    expect(oneDark.appearance).toBe("dark");
    expect(oneDark.logo.variant).toBe("dark");
    expect(oneLight.appearance).toBe("light");
    expect(oneLight.logo.variant).toBe("light");

    const monokai = getTheme("monokai");
    const monokaiLight = getTheme("monokai-light");
    expect(monokai.appearance).toBe("dark");
    expect(monokai.logo.variant).toBe("dark");
    expect(monokai.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(monokaiLight.appearance).toBe("light");
    expect(monokaiLight.logo.variant).toBe("light");
    expect(monokaiLight.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);

    const frostDark = getTheme("frost-dark");
    const frostLight = getTheme("frost-light");
    expect(frostDark.appearance).toBe("dark");
    expect(frostDark.logo.variant).toBe("dark");
    expect(frostDark.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(frostLight.appearance).toBe("light");
    expect(frostLight.logo.variant).toBe("light");
    expect(frostLight.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);

    const carbonOwl = getTheme("carbon-owl");
    const paperOwl = getTheme("paper-owl");
    expect(carbonOwl.appearance).toBe("dark");
    expect(carbonOwl.logo.variant).toBe("dark");
    expect(carbonOwl.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(paperOwl.appearance).toBe("light");
    expect(paperOwl.logo.variant).toBe("light");
    expect(paperOwl.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
