import { translateUi, uiI18n } from "@/lib/i18n/ui";
import type { ThemeChrome as ApiThemeChrome, ThemeDocument, UserTheme } from "@/api/generated";
import { PLAIN_CHROME, type ThemeChrome } from "./chrome";
import { CADENCR_THEME_LOGOS } from "./logos";
import { THEME_OPTIONAL_TOKEN_KEYS, THEME_TOKEN_KEYS, type ThemeCssVars } from "./tokens";
import {
  isUserThemeId,
  USER_THEME_ID_PREFIX,
  type ThemeDefinition,
  type UserThemeId,
} from "./types";

/**
 * Bridge between the theme *file* (what the API returns) and the theme
 * *definition* the app applies.
 *
 * The backend has already validated the document — known tokens only, values
 * that parse as colors, contrast pairs cleared — so this is a shape conversion,
 * not a second gate. It only runs for entries the backend marked valid.
 */

export function userThemeId(id: string): UserThemeId {
  return `${USER_THEME_ID_PREFIX}${id}`;
}

/**
 * The inverse: the on-disk folder name behind a `user:` id, or `undefined` for
 * a built-in. Kept beside `userThemeId` so both halves of the encoding stay in
 * one place — a caller that slices the prefix off by hand is a caller that will
 * still be slicing it if the prefix ever changes.
 */
export function userThemeSlug(id: string): string | undefined {
  return isUserThemeId(id) ? id.slice(USER_THEME_ID_PREFIX.length) : undefined;
}

/**
 * What to call a theme in the UI. The declared label when the file parsed —
 * even if validation then rejected it, so a broken theme is still identifiable
 * — falling back to its on-disk id.
 */
export function userThemeLabel(entry: UserTheme): string {
  return entry.theme?.label ?? entry.label ?? entry.id;
}

export function toThemeDefinition(
  id: string,
  document: ThemeDocument,
  assets: Record<string, string> = {},
): ThemeDefinition {
  return {
    id: userThemeId(id),
    label: document.label,
    appearance: document.appearance,
    // A theme carries colors, not brand assets: the logo follows its
    // light/dark classification, exactly as the first-party themes do.
    logo: CADENCR_THEME_LOGOS[document.appearance],
    cssVars: document.cssVars as ThemeCssVars,
    chrome: toThemeChrome(document.chrome),
    assets,
    swatch: {
      background: document.cssVars["--background"] ?? "",
      foreground: document.cssVars["--foreground"] ?? "",
      primary: document.cssVars["--primary"] ?? "",
      accent: document.cssVars["--acc-pink"] ?? document.cssVars["--primary"] ?? "",
    },
    xterm: document.xterm,
  };
}

/**
 * Fill in a chrome block the file left partly unsaid.
 *
 * Every field is optional over the wire — the backend defaults them so a theme
 * written before chrome existed still loads — while the renderer wants a total
 * value it can read without a chain of `?.`. An older theme therefore lands on
 * exactly the plain chrome it had before.
 */
function toThemeChrome(chrome: ApiThemeChrome | undefined): ThemeChrome {
  if (!chrome) return PLAIN_CHROME;
  const texture = chrome.texture;
  return {
    chassis: chrome.chassis ?? PLAIN_CHROME.chassis,
    tabs: chrome.tabs ?? PLAIN_CHROME.tabs,
    texture: {
      base: texture?.base ?? null,
      halos: texture?.halos ?? [],
      image: texture?.image ?? null,
      grain: texture?.grain ?? null,
      veil: texture?.veil ?? false,
    },
  };
}

/**
 * The theme the user selected that can't actually be applied, if any.
 *
 * Matches on the *selection* rather than on `<html data-theme>`: by the time
 * anything checks, the app has already fallen back to the default, so the
 * document no longer names the broken theme. Checking the document instead is
 * how a bad theme file reverted silently — the exact outcome validation exists
 * to prevent.
 */
export function findUnapplicableSelection(
  entries: UserTheme[],
  selectedThemeIds: string[],
): UserTheme | undefined {
  return entries.find(
    (entry) => entry.theme == null && selectedThemeIds.includes(userThemeId(entry.id)),
  );
}

/** The definitions for every entry that passed validation, in gallery order. */
export function toThemeDefinitions(themes: UserTheme[]): ThemeDefinition[] {
  return themes.flatMap((entry) =>
    entry.theme ? [toThemeDefinition(entry.id, entry.theme, entry.assets)] : [],
  );
}

/**
 * Read a theme's token values out of the live document.
 *
 * Duplication has to work for *any* built-in, including the ones whose values
 * still live in a stylesheet rather than in `cssVars`. Rather than maintain a
 * second copy of those values, ask the browser: flip `data-theme` to the source
 * theme, read the computed custom properties off `<html>`, and flip back. Both
 * writes happen in one synchronous task, so no frame is ever painted with the
 * wrong theme.
 *
 * The risk this can't detect at runtime is a theme with no matching rule: the
 * flip then falls through to the bare `:root` block and reads the *default*
 * palette under another theme's name. It is not detectable by comparing against
 * an unmatchable id, because CadencR Dark deliberately *is* the `:root` block
 * (`theme-cadencr.css` declares `:root, :root[data-theme="cadencr-dark"]`) and
 * any theme may legitimately share a token with it. So that invariant — every
 * built-in carries `cssVars` or has a block of its own — is enforced where it
 * can be checked exactly, by `registry.test.ts`, and what remains here is the
 * one failure a runtime read can see: tokens that resolve to nothing at all.
 */
export function readThemeCssVars(themeId: string, cssVars?: ThemeCssVars): ThemeCssVars {
  if (cssVars) return { ...cssVars };
  const root = document.documentElement;
  const previous = root.dataset.theme;
  try {
    const fromTheme = readTokensWithThemeApplied(root, themeId);
    const missing = THEME_TOKEN_KEYS.filter((key) => fromTheme[key] === "");
    if (missing.length > 0) {
      const tokens = missing.slice(0, 3).join(", ");
      const count = missing.length - 3;
      throw new Error(
        count > 0
          ? translateUi(
              "appearance.library.missingTokensAndMore",
              'Theme "{{themeId}}" has no value for {{tokens}} and {{count, number}} more — its stylesheet may not have loaded.',
              { themeId, tokens, count, formatParams: { count: { locale: uiI18n.language } } },
            )
          : translateUi(
              "appearance.library.missingTokens",
              'Theme "{{themeId}}" has no value for {{tokens}} — its stylesheet may not have loaded.',
              { themeId, tokens },
            ),
      );
    }
    return fromTheme;
  } finally {
    if (previous === undefined) delete root.dataset.theme;
    else root.dataset.theme = previous;
  }
}

/**
 * The optional chrome tokens are read the same way and kept only when the source
 * theme actually declares them. That is what carries CadencR Dark's tab colors
 * into a duplicate: they live in `theme-cadencr.css`, so without this the copy
 * arrives with `tabs: "segmented"` and falls back to the neutral derived track —
 * the shape, again, without its colors. A theme that declares none of them
 * yields none, and the fallback is the right answer.
 */
function readTokensWithThemeApplied(root: HTMLElement, themeId: string): ThemeCssVars {
  root.dataset.theme = themeId;
  const computed = window.getComputedStyle(root);
  const read = (key: string) => computed.getPropertyValue(key).trim();
  const required = THEME_TOKEN_KEYS.map((key) => [key, read(key)]);
  const optional = THEME_OPTIONAL_TOKEN_KEYS.map((key) => [key, read(key)]).filter(
    ([, value]) => value !== "",
  );
  return Object.fromEntries([...required, ...optional]) as ThemeCssVars;
}
