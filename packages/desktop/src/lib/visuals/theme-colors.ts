import { CHART_SERIES_TOKENS, OTHER_SERIES_TOKEN } from "@/lib/chart-series";
import { cssColorToHex } from "@/lib/css-color";
import { opaqueBackground } from "@/lib/plugin-tabs/theme-snapshot";

import type { VisualTheme } from "./live-theme";

/** `derive(theme)`, computed once per theme object (a theme is immutable). */
export function perTheme<T>(derive: (theme: VisualTheme) => T): (theme: VisualTheme) => T {
  const cache = new WeakMap<VisualTheme, T>();
  return (theme) => {
    if (cache.has(theme)) return cache.get(theme) as T;
    const value = derive(theme);
    cache.set(theme, value);
    return value;
  };
}

const background = perTheme(({ snapshot }) =>
  opaqueBackground(snapshot.tokens.background ?? "", snapshot.appearance),
);

/**
 * A theme token as opaque `#rrggbb`, composited over the theme background.
 * Theme tokens may be `oklch()` or translucent (Frost); Vega's color math and
 * canvas libraries need a plain color. Keeps the raw value where no canvas
 * exists (tests).
 */
export function resolveThemeColor(theme: VisualTheme, token: string): string | undefined {
  const value = theme.snapshot.tokens[token];
  if (!value) return undefined;
  return cssColorToHex(value, background(theme)) ?? value;
}

/**
 * The categorical palette, resolved: the app's four series colors, then the
 * neutral "Other" tone (`lib/chart-series.ts`, shared with usage statistics).
 * Tokens a theme lacks are skipped.
 */
export const visualPalette = perTheme((theme) =>
  [...CHART_SERIES_TOKENS, OTHER_SERIES_TOKEN]
    .map((token) => resolveThemeColor(theme, token))
    .filter((color): color is string => color !== undefined),
);
