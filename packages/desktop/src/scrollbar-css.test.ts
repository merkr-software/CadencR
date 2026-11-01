import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRACULA_THEME } from "./lib/themes/dracula";
import { THEME_OPTIONAL_TOKEN_KEYS } from "./lib/themes/tokens";

describe("scrollbar CSS", () => {
  const indexCss = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
  const themeCss = readFileSync(join(process.cwd(), "src/theme.css"), "utf8");
  const cadencrCss = readFileSync(join(process.cwd(), "src/theme-cadencr.css"), "utf8");
  const cadencrMaterialCss = readFileSync(
    join(process.cwd(), "src/theme-cadencr-material.css"),
    "utf8",
  );
  const chromeCss = readFileSync(join(process.cwd(), "src/theme-chrome.css"), "utf8");
  // Comments in this file explain the fallbacks at length, naming the tokens
  // they deliberately avoid — so any assertion about the *rules* reads them out.
  const chromeRules = chromeCss.replace(/\/\*[\s\S]*?\*\//g, "");

  it("keeps native scrollbar tracks transparent instead of browser-white", () => {
    expect(indexCss).toContain("::-webkit-scrollbar");
    expect(indexCss).toMatch(
      /::-webkit-scrollbar-track,\s*::-webkit-scrollbar-corner\s*{[^}]*background:\s*transparent;/s,
    );
    expect(indexCss).toMatch(/scrollbar-color:\s*var\(--scrollbar-thumb\)\s+transparent;/);
  });

  it("declares the browser color scheme for each app theme", () => {
    // Dracula carries its tokens as data, so its `color-scheme` comes from the
    // declared appearance and is injected by `applyThemeToDocument` (see
    // `lib/themes/inject.ts`) rather than authored in this stylesheet.
    expect(DRACULA_THEME.appearance).toBe("dark");
    expect(themeCss).toMatch(/:root\[data-theme="aurora"\]\s*{[^}]*color-scheme:\s*light;/s);
    // CadencR Dark doubles as the `data-theme`-absent first-paint default.
    expect(cadencrCss).toMatch(
      /:root,\s*:root\[data-theme="cadencr-dark"\]\s*{[^}]*color-scheme:\s*dark;/s,
    );
    expect(cadencrCss).toMatch(
      /:root\[data-theme="cadencr-light"\]\s*{[^}]*color-scheme:\s*light;/s,
    );
  });

  it("pins Emerald Reserve's neutral hierarchy and primary colors", () => {
    expect(cadencrCss).toMatch(
      /:root,\s*:root\[data-theme="cadencr-dark"\]\s*{[^}]*--background:\s*#131416;[^}]*--primary:\s*#2db47d;[^}]*--border:\s*#34373a;[^}]*--sidebar:\s*#090a0c;[^}]*--block-edit-accent:\s*#f09a5b;/s,
    );
    expect(cadencrCss).toMatch(
      /:root\[data-theme="cadencr-light"\]\s*{[^}]*--background:\s*#fafafb;[^}]*--primary:\s*#087653;[^}]*--border:\s*#d7dadd;[^}]*--sidebar:\s*#eff0f2;[^}]*--block-edit-accent:\s*#a84f00;/s,
    );
  });

  it("keeps the CadencR material layer scoped and free of relational selectors", () => {
    expect(indexCss).toContain('@import "./theme-cadencr-material.css";');
    expect(cadencrMaterialCss).toContain('[data-theme="cadencr-dark"]');
    expect(cadencrMaterialCss).toContain('[data-theme="cadencr-light"]');
    expect(cadencrMaterialCss).not.toContain(":has(");
    expect(cadencrMaterialCss).toContain('[data-has-floating-pane="true"]');
  });

  it("reserves end padding on floating-pane and closable tabs for their close control", () => {
    const rule =
      /\[data-pane-frame="floating"\]\s*\[data-pane-tab-strip\]\s*\[data-slot="tabs-trigger"\],\s*:root\[data-tabs="segmented"\]\s*\[data-pane-tab-strip\]\s*\[data-slot="tabs-trigger"\]\[data-tab-closable\]\s*{[^}]*padding-inline-end:\s*2rem;/s;
    expect(chromeCss).toMatch(rule);
  });

  it("keys the chrome layer on the theme's declared shape, never on a theme id", () => {
    // The whole point of chrome being data: chassis, tabs and texture belong to
    // whatever theme asks for them. A `data-theme` selector creeping back in
    // here is the regression that made a duplicated theme lose its shape.
    expect(indexCss).toContain('@import "./theme-chrome.css";');
    expect(chromeCss).not.toMatch(/\[data-theme=/);
    expect(chromeCss).toContain('[data-chassis="rail"]');
    expect(chromeCss).toContain('[data-tabs="segmented"]');
  });

  it("gives a theme that opts into the rail or segmented tabs a fallback for every chrome token", () => {
    // Four of these are optional *theme* tokens and two are shadows the app
    // keeps. Either way a theme may leave them unset, and referenced bare, one
    // asking for that shape would get a control with no track and no edge.
    for (const token of [
      "--pane-border",
      "--page-shadow",
      "--tab-track-bg",
      "--tab-track-border",
      "--tab-active-bg",
      "--tab-active-shadow",
    ]) {
      // The formatter breaks a long `var()` across lines, so both patterns
      // have to tolerate whitespace around the token name.
      expect(chromeCss, `${token} must carry a fallback`).not.toMatch(
        new RegExp(`var\\(\\s*${token}\\s*\\)`),
      );
      expect(chromeCss).toMatch(new RegExp(`var\\(\\s*${token}\\s*,`));
    }
  });

  it("derives the segmented-tab fallbacks from --foreground, so a quiet theme is untinted", () => {
    // These four tokens are the theme's to set (`THEME_OPTIONAL_TOKEN_KEYS`);
    // what is asserted here is what a theme that sets *none* of them gets.
    //
    // Mixing `--foreground` into `--background` is the only pair guaranteed to
    // be far apart in any palette — `--muted` and `--card` are the same color in
    // the CadencR pair, and `--primary` would paint every quiet theme's tabs in
    // an accent it never asked for. This is also the regression: an agent asked
    // to recolor one theme's tabs edited these fallbacks instead, which is a
    // change to every theme at once and one no installed Cadencr can receive.
    // `--chart-6` is the optional palette slot, not chrome: the marketplace reads it.
    for (const key of THEME_OPTIONAL_TOKEN_KEYS.filter((token) => token !== "--chart-6")) {
      expect(chromeCss, `${key} must be a token a theme can set`).toMatch(
        new RegExp(`var\\(\\s*${key}\\s*,`),
      );
    }
    const fallbacks = chromeRules.match(/var\(\s*--tab-(?:track-bg|active-bg)\s*,[^;]+;/gs) ?? [];
    expect(fallbacks).toHaveLength(2);
    for (const fallback of fallbacks) {
      expect(fallback).toContain("var(--foreground)");
      expect(fallback).toContain("var(--background)");
      expect(fallback).not.toContain("var(--primary)");
    }
  });

  it("never sets an optional token on bare :root, where every other theme would inherit it", () => {
    // A theme that leaves an optional token out must reach its fallback, so
    // first-party values sit on theme-specific selectors only.
    const blocks = [themeCss, cadencrCss].flatMap((css) =>
      [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) =>
        // The capture starts after the previous rule, comments included.
        selector.split(",").some((part) => part.trim().split(/\s+/).pop() === ":root"),
      ),
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, , body] of blocks) {
      for (const key of THEME_OPTIONAL_TOKEN_KEYS) {
        expect(body, `${key} on bare :root`).not.toMatch(new RegExp(`${key}\\s*:`));
      }
    }
  });

  it("keeps the sidebar worktree group off palette tokens that collide with --sidebar", () => {
    // `--muted` IS `--sidebar` in cadencr-light (#eff0f2 both) and one step
    // from it in cadencr-dark, so a muted/accent fill leaves the grouping
    // invisible in exactly the themes that need it. The fill must stay a
    // foreground wash; the rim reuses the sidebar's own hairline token.
    const groupRule = indexCss.match(/@utility worktree-group\s*{[^}]*}/s)?.[0] ?? "";
    expect(groupRule).toMatch(
      /background-color:\s*color-mix\(in oklab, var\(--sidebar-foreground\)[^)]*\);/,
    );
    expect(groupRule).toMatch(/border-color:\s*var\(--sidebar-border\);/);
    expect(groupRule).not.toMatch(/var\(--(muted|sidebar|sidebar-accent|accent|card)\)/);
  });

  it("derives the control border from the muted foreground in both color schemes", () => {
    // `--input` is a field *fill*, not an edge: in CadencR Dark it sits at
    // 1.07:1 against the card, which left every unchecked checkbox and switch
    // track with no visible outline. Both arms must stay on the audited muted
    // foreground, which is the only palette entry with a contrast floor.
    const token = themeCss.match(/--control-border:\s*light-dark\([^;]*\);/)?.[0] ?? "";
    const mixes = token.match(/color-mix\(in oklab, var\(--muted-foreground\) \d+%/g) ?? [];

    expect(mixes).toHaveLength(2);
    expect(token).not.toMatch(/var\(--input\)/);
  });

  it("keeps Dracula hover and active accents subdued", () => {
    // Same invariant as before Dracula moved off this stylesheet — only the
    // source of truth changed.
    expect(DRACULA_THEME.cssVars?.["--accent"]).toBe("oklch(0.34 0.032 277.821)");
    expect(DRACULA_THEME.cssVars?.["--sidebar-accent"]).toBe("oklch(0.34 0.032 277.821)");
  });

  it("no longer carries a Dracula block, so the data path is its only source", () => {
    expect(themeCss).not.toMatch(/:root\[data-theme="dracula"\]\s*{/);
  });
});
