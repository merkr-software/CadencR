// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { injectThemeCssVars, isSafeTokenValue } from "./inject";
import { THEME_TOKEN_KEYS } from "./tokens";
import { DRACULA_THEME } from "./dracula";
import { CADENCR_THEME_LOGOS } from "./logos";
import type { ThemeCssVars } from "./tokens";
import type { ThemeAppearance, ThemeDefinition } from "./types";

function theme(
  id: string,
  cssVars: ThemeCssVars | undefined,
  appearance: ThemeAppearance = "dark",
): ThemeDefinition {
  return {
    ...DRACULA_THEME,
    id: id as ThemeDefinition["id"],
    appearance,
    logo: CADENCR_THEME_LOGOS[appearance],
    cssVars,
  };
}

function injectedCss(): string {
  return document.getElementById("cadencr-theme-vars")?.textContent ?? "";
}

describe("theme token set", () => {
  it("dracula carries a value for every token in the closed set", () => {
    // Dracula is the first theme ported off `theme.css` to the data path. It
    // must cover the whole token set, or the ported theme paints less than the
    // stylesheet block it replaced.
    expect(Object.keys(DRACULA_THEME.cssVars ?? {}).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
  });
});

describe("injectThemeCssVars", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  const vars = { "--background": "#000", "--foreground": "#fff" } as unknown as ThemeCssVars;
  const mine = theme("user:mine", vars);

  it("writes a scoped rule with the theme's color-scheme", () => {
    injectThemeCssVars(mine);
    expect(injectedCss()).toBe(
      ':root[data-theme="user:mine"] {\n' +
        "  color-scheme: dark;\n" +
        "  --background: #000;\n" +
        "  --foreground: #fff;\n" +
        "}\n",
    );
  });

  it("replaces the previous theme's rule instead of accumulating", () => {
    injectThemeCssVars(mine);
    injectThemeCssVars(DRACULA_THEME);
    expect(injectedCss()).not.toContain("user:mine");
    expect(document.querySelectorAll("#cadencr-theme-vars")).toHaveLength(1);
  });

  it("clears the rule for a theme whose tokens live in a stylesheet", () => {
    injectThemeCssVars(mine);
    injectThemeCssVars(theme("cadencr-dark", undefined));
    expect(injectedCss()).toBe("");
  });

  it("drops values that could break out of the declaration", () => {
    const hostile = {
      "--background": "#000",
      "--foreground": "red} :root { --background: red",
    } as unknown as ThemeCssVars;
    injectThemeCssVars(theme("user:mine", hostile));
    expect(injectedCss()).toContain("--background: #000;");
    expect(injectedCss()).not.toContain("--foreground");
  });

  it("rejects unsafe token values", () => {
    expect(isSafeTokenValue("oklch(0.22 0.022 277.497)")).toBe(true);
    expect(isSafeTokenValue("var(--code-fg)")).toBe(true);
    expect(isSafeTokenValue("")).toBe(false);
    expect(isSafeTokenValue("red; background: url(x)")).toBe(false);
    expect(isSafeTokenValue("red /* c */")).toBe(false);
    expect(isSafeTokenValue("@import 'x'")).toBe(false);
  });
});
