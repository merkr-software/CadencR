// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { ThemeDocument, UserTheme } from "@/api/generated";
import {
  findUnapplicableSelection,
  readThemeCssVars,
  toThemeDefinition,
  toThemeDefinitions,
  userThemeId,
  userThemeLabel,
} from "./user-theme";
import { THEME_TOKEN_KEYS } from "./tokens";
import { DRACULA_THEME } from "./dracula";

function document_(overrides: Partial<ThemeDocument> = {}): ThemeDocument {
  return {
    label: "My Theme",
    appearance: "dark",
    cssVars: { "--background": "#000", "--foreground": "#fff", "--primary": "#f0f" },
    xterm: DRACULA_THEME.xterm,
    ...overrides,
  } as ThemeDocument;
}

function entry(overrides: Partial<UserTheme> = {}): UserTheme {
  return {
    id: "my-theme",
    path: "/themes/my-theme/theme.json",
    content: "{}",
    theme: document_(),
    issues: [],
    ...overrides,
  } as UserTheme;
}

describe("userThemeId", () => {
  it("namespaces the on-disk slug so it can't collide with a built-in", () => {
    expect(userThemeId("dracula")).toBe("user:dracula");
  });
});

describe("toThemeDefinition", () => {
  it("maps the document onto a theme definition", () => {
    const theme = toThemeDefinition("my-theme", document_());
    expect(theme.id).toBe("user:my-theme");
    expect(theme.label).toBe("My Theme");
    expect(theme.cssVars?.["--background"]).toBe("#000");
    expect(theme.swatch.background).toBe("#000");
  });

  it("picks the logo from the declared appearance", () => {
    expect(toThemeDefinition("a", document_({ appearance: "light" })).logo.variant).toBe("light");
    expect(toThemeDefinition("a", document_({ appearance: "dark" })).logo.variant).toBe("dark");
  });
});

describe("toThemeDefinitions", () => {
  it("drops entries the backend rejected", () => {
    const themes = toThemeDefinitions([
      entry({ id: "good" }),
      // Failed validation: listed in the gallery, but never applicable.
      entry({ id: "bad", theme: null, issues: [{ token: "--background", message: "nope" }] }),
    ]);
    expect(themes.map((t) => t.id)).toEqual(["user:good"]);
  });
});

describe("findUnapplicableSelection", () => {
  const broken = entry({
    id: "broken",
    theme: null,
    label: "Broken",
    issues: [{ token: "--background", message: "nope" }],
  });

  it("finds a selected theme that failed validation", () => {
    expect(findUnapplicableSelection([entry(), broken], ["user:broken"])?.id).toBe("broken");
  });

  it("ignores a broken theme the user has not selected", () => {
    expect(findUnapplicableSelection([entry(), broken], ["user:my-theme"])).toBeUndefined();
  });

  it("ignores a selected theme that is fine", () => {
    expect(findUnapplicableSelection([entry()], ["user:my-theme"])).toBeUndefined();
  });

  it("matches the light/dark system selections too", () => {
    expect(findUnapplicableSelection([broken], ["frost-light", "user:broken"])?.id).toBe("broken");
  });
});

describe("userThemeLabel", () => {
  it("prefers the validated label, then the declared one, then the id", () => {
    expect(userThemeLabel(entry())).toBe("My Theme");
    // Failed validation, so `theme` is null — but the file still declared a name.
    expect(userThemeLabel(entry({ theme: null, label: "Declared" }))).toBe("Declared");
    // Not even parseable JSON: nothing to go on but the directory name.
    expect(userThemeLabel(entry({ theme: null, label: null }))).toBe("my-theme");
  });
});

describe("readThemeCssVars", () => {
  afterEach(() => {
    delete window.document.documentElement.dataset.theme;
  });

  it("returns a theme's own token map without touching the document", () => {
    window.document.documentElement.dataset.theme = "frost-dark";
    const vars = readThemeCssVars("dracula", DRACULA_THEME.cssVars);
    expect(Object.keys(vars)).toHaveLength(THEME_TOKEN_KEYS.length);
    expect(vars["--background"]).toBe(DRACULA_THEME.cssVars?.["--background"]);
    expect(window.document.documentElement.dataset.theme).toBe("frost-dark");
  });

  it("carries the optional chrome tokens the source theme declares, and no empty ones", () => {
    // Read off the live document, so seed them the way a stylesheet would.
    const root = window.document.documentElement;
    root.style.setProperty("--tab-track-bg", "#0f1012");
    for (const [key, value] of Object.entries(DRACULA_THEME.cssVars ?? {})) {
      root.style.setProperty(key, value);
    }
    try {
      const vars = readThemeCssVars("cadencr-dark");
      expect(vars["--tab-track-bg"]).toBe("#0f1012");
      // Declared by no stylesheet here, so it must be absent rather than "".
      expect("--pane-border" in vars).toBe(false);
    } finally {
      root.removeAttribute("style");
    }
  });

  it("refuses to copy a theme whose values it cannot actually read", () => {
    // Themes whose values live in CSS are read by briefly flipping
    // `data-theme`. With no stylesheet loaded at all (jsdom here; a failed
    // stylesheet in the app) every token resolves to nothing, and creating a
    // theme out of empty values would fail validation server-side with a far
    // less useful message. It has to fail loudly here instead.
    window.document.documentElement.dataset.theme = "frost-dark";
    expect(() => readThemeCssVars("monokai")).toThrow(/has no value for --background/);
  });

  it("restores the previous theme even when the read fails", () => {
    window.document.documentElement.dataset.theme = "frost-dark";
    expect(() => readThemeCssVars("monokai")).toThrow();
    expect(window.document.documentElement.dataset.theme).toBe("frost-dark");
  });

  it("leaves the attribute absent when it started absent", () => {
    expect(() => readThemeCssVars("monokai")).toThrow();
    expect(window.document.documentElement.dataset.theme).toBeUndefined();
  });
});
