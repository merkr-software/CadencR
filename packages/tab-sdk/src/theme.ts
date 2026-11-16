import type { ThemeSnapshot } from "./protocol.js";

/** Prefix of every theme custom property: `background` → `--cadencr-background`. */
export const THEME_VARIABLE_PREFIX = "--cadencr-";

const TOKEN_NAME = /^[a-z0-9][a-z0-9-]*$/;
// A value is spliced into CSS text by `themeToCss`; anything that could close
// the declaration or the rule (or open an at-rule) is refused. Same guard and
// length cap as the desktop's own theme injection (`lib/themes/inject.ts`), so
// a host stylesheet and this SDK always accept the same values.
const UNSAFE_VALUE = /[{}<>;@\\]|\/\*/;
const MAX_VALUE_LENGTH = 256;

function isSafeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    !UNSAFE_VALUE.test(value)
  );
}

/** `--cadencr-<token>` → value, for every well-formed token of the snapshot. */
export function themeVariables(theme: ThemeSnapshot): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [token, value] of Object.entries(theme.tokens)) {
    if (!TOKEN_NAME.test(token) || !isSafeValue(value)) continue;
    variables[`${THEME_VARIABLE_PREFIX}${token}`] = value.trim();
  }
  return variables;
}

/** The snapshot as one CSS rule — what a host injects before first paint. */
export function themeToCss(theme: ThemeSnapshot, selector = ":root"): string {
  const declarations = Object.entries(themeVariables(theme)).map(
    ([name, value]) => `  ${name}: ${value};`,
  );
  const scheme = theme.appearance === "light" ? "light" : "dark";
  return `${selector} {\n  color-scheme: ${scheme};\n${declarations.join("\n")}\n}\n`;
}

const applied = new WeakMap<HTMLElement, Set<string>>();

/**
 * Writes the snapshot onto `root` (default `<html>`): one `--cadencr-<token>`
 * inline property per token, `data-appearance`, `data-cadencr-theme` and
 * `color-scheme`. Properties a previous snapshot set but this one lacks are
 * removed.
 *
 * Inside Cadencr the guest preload has already inserted the same variables as
 * a stylesheet (`themeToCss` output) before the first script ran, so the page
 * never paints unthemed. This still writes them: the values are identical
 * (same guard, same tokens), so applying both is harmless — at most one extra
 * style pass per theme change — and it keeps the SDK correct on its own: under
 * `createTestHost`, in a plain browser, or before the host has pushed a theme.
 */
export function applyTheme(theme: ThemeSnapshot, root?: HTMLElement): void {
  const target = root ?? (typeof document === "undefined" ? undefined : document.documentElement);
  if (!target) return;
  const variables = themeVariables(theme);
  const previous = applied.get(target) ?? new Set<string>();
  for (const name of previous) {
    if (!(name in variables)) target.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value);
  applied.set(target, new Set(Object.keys(variables)));
  target.dataset.appearance = theme.appearance;
  target.dataset.cadencrTheme = theme.id;
  target.style.colorScheme = theme.appearance === "light" ? "light" : "dark";
}
