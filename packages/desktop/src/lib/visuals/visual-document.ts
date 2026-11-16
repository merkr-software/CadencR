import { isSafeTokenValue } from "@/lib/themes/inject";

import type { VisualTheme } from "./live-theme";
import { CHART_JS_THEME_SCRIPT, visualBridgeScript } from "./visual-bridge";
import { VISUAL_KIT_CSS } from "./visual-kit";

/** Libraries an HTML visual can load with `<script src="cadencr:<name>">`. */
export const VISUAL_LIBRARIES = ["d3", "chart.js"] as const;
export type VisualLibrary = (typeof VISUAL_LIBRARIES)[number];

const LIBRARY_TAG = /<script\b[^>]*?\bsrc\s*=\s*(["'])cadencr:([\w.-]+)\1[^>]*>\s*<\/script\s*>/gi;
const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

function isVisualLibrary(name: string): name is VisualLibrary {
  return (VISUAL_LIBRARIES as readonly string[]).includes(name);
}

/** The bundled libraries `html` asks for, so only those get loaded. */
export function requestedLibraries(html: string): VisualLibrary[] {
  const names = new Set<VisualLibrary>();
  for (const match of html.matchAll(LIBRARY_TAG)) {
    const name = match[2]?.toLowerCase() ?? "";
    if (isVisualLibrary(name)) names.add(name);
  }
  return [...names];
}

/** Script text safe to inline: nothing in it may close the `<script>` element. */
function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
}

function libraryScript(name: string, libraries: Partial<Record<VisualLibrary, string>>): string {
  const lower = name.toLowerCase();
  const source = isVisualLibrary(lower) ? libraries[lower] : undefined;
  if (source === undefined) {
    const message = `Unknown Cadencr library "${name}". Available: ${VISUAL_LIBRARIES.join(", ")}.`;
    return inlineScript(`throw new Error(${JSON.stringify(message)});`);
  }
  return inlineScript(lower === "chart.js" ? source + CHART_JS_THEME_SCRIPT : source);
}

/**
 * The live theme as `:root` variables, under the app's own token names. Values
 * pass the app's own token rule (`isSafeTokenValue`), so none can end the
 * declaration, the rule or the `<style>` element.
 */
export function visualThemeCss(theme: VisualTheme): string {
  const declarations = Object.entries(theme.snapshot.tokens)
    .filter(([, value]) => isSafeTokenValue(value))
    .map(([name, value]) => `  --${name}: ${value};`);
  const font = (value: string, fallback: string) => (isSafeTokenValue(value) ? value : fallback);
  declarations.push(`  --font-sans: ${font(theme.fontSans, "sans-serif")};`);
  declarations.push(`  --font-mono: ${font(theme.fontMono, "monospace")};`);
  const scheme = theme.snapshot.appearance === "light" ? "light" : "dark";
  return `:root {\n  color-scheme: ${scheme};\n${declarations.join("\n")}\n}`;
}

function interFontFace(fontDataUrl: string | undefined): string {
  if (!fontDataUrl) return "";
  return `@font-face { font-family: "Inter Variable"; font-style: normal; font-display: block; font-weight: 100 900; src: url(${fontDataUrl}) format("woff2"); }`;
}

interface VisualDocumentInput {
  html: string;
  theme: VisualTheme;
  palette: readonly string[];
  libraries: Partial<Record<VisualLibrary, string>>;
  fontDataUrl?: string;
}

/**
 * The full document posted to the sandbox shell: the bridge first (so it sees
 * every error), the font, theme and kit styles, then the agent's HTML with its
 * `cadencr:` library tags replaced by the bundled sources. A complete document
 * from the agent is accepted too: the parser folds its `<html>`/`<head>` into
 * this one, and its styles and scripts still apply from the body.
 */
export function assembleVisualDocument({
  html,
  theme,
  palette,
  libraries,
  fontDataUrl,
}: VisualDocumentInput): string {
  const body = html
    .replace(LEADING_DOCTYPE, "")
    .replace(LIBRARY_TAG, (_tag, _quote: string, name: string) => libraryScript(name, libraries));
  return [
    "<!doctype html>",
    `<html data-appearance="${theme.snapshot.appearance === "light" ? "light" : "dark"}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    inlineScript(visualBridgeScript(palette)),
    `<style>${interFontFace(fontDataUrl)}\n${visualThemeCss(theme)}\n${VISUAL_KIT_CSS}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}
