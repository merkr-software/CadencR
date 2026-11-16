import { renderMermaidSVG } from "beautiful-mermaid";

import { LruCache } from "@/lib/lru-cache";

/**
 * Mermaid → SVG for chat diagrams.
 *
 * beautiful-mermaid draws the diagram kinds agents emit most (flowchart,
 * state, sequence, class, ER, XY chart) far more legibly than mermaid, and
 * does it synchronously without touching the DOM. Every other kind (gantt,
 * pie, mindmap, …), and any source it fails to parse, falls back to mermaid.
 */

const CACHE_MAX = 100;

/** `null` records "not beautiful-mermaid's", so a rejected source is not re-parsed per mount. */
const beautifulCache = new LruCache<string | null>(CACHE_MAX);
const mermaidCache = new LruCache<string>(CACHE_MAX);

/** First lines beautiful-mermaid lays out; it would misread anything else as a flowchart. */
const BEAUTIFUL_HEADER =
  /^(?:(?:graph|flowchart)\s+(?:TD|TB|LR|BT|RL)\b|stateDiagram(?:-v2)?\s*$|sequenceDiagram\s*$|classDiagram\s*$|erDiagram\s*$|xychart(?:-beta)?\b)/i;

/**
 * Colors are CSS variable references, so a theme switch restyles the SVG
 * without re-rendering. beautiful-mermaid writes them onto the `<svg>` as
 * `--bg`, `--fg`, `--accent` and `--muted`; each must read a token with a
 * different name (`--border: var(--border)` would be a self-reference).
 */
const THEME_COLORS = {
  bg: "var(--background)",
  fg: "var(--foreground)",
  accent: "var(--primary)",
  muted: "var(--muted-foreground)",
  transparent: true,
} as const;

const SCOPE_ATTR = "data-beautiful-mermaid";

/** Drop mermaid `%%` comment/directive lines so the header is the first line. */
function stripLeadingComments(code: string): string {
  const lines = code.split("\n");
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("%%");
  });
  return start <= 0 ? code : lines.slice(start).join("\n");
}

/**
 * Agents often end flowchart statements with mermaid's optional `;`
 * (`flowchart LR;`, `A --> B;`), which beautiful-mermaid's parser rejects.
 * Only a trailing `;` is dropped; one-liners joined by `;` still go to mermaid.
 */
function dropTrailingSemicolons(source: string): string {
  return /^(?:graph|flowchart)\b/i.test(source) ? source.replace(/;[ \t]*$/gm, "") : source;
}

/**
 * The SVG carries its own `<style>` written for a standalone file: Google
 * Fonts `@import`s (blocked by our CSP), a global `text { font-family }` and
 * bare `svg { … }` rules. Inlined into the app those would restyle every SVG
 * on the page, so drop the font rules (text inherits the app's Inter) and
 * scope the rest to beautiful-mermaid's own root.
 */
export function scopeBeautifulSvg(svg: string): string {
  return svg
    .replace("<svg ", `<svg ${SCOPE_ATTR} `)
    .replace(/^\s*@import url\([^)]*\);\s*$/gm, "")
    .replace(/^\s*text \{[^}]*\}\s*$/m, "")
    .replace(
      /\.mono \{ font-family:[^}]*\}/,
      `svg[${SCOPE_ATTR}] .mono { font-family: var(--font-mono); }`,
    )
    .replace(/^(\s*)svg \{/gm, `$1svg[${SCOPE_ATTR}] {`);
}

/**
 * beautiful-mermaid emits fixed ids (`arrowhead`, and node ids such as `A`
 * or `root`) that would collide with other diagrams and with app elements.
 * Prefix every id and every `url(#…)` / `href="#…"` reference to it.
 */
export function namespaceSvgIds(svg: string, prefix: string): string {
  return svg
    .replace(/(\s)id="([^"]+)"/g, (_, space: string, id: string) => `${space}id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`);
}

/**
 * Render with beautiful-mermaid, or `null` when the diagram kind is not one
 * it supports or its parser rejects the source. `null` is not an error: the
 * caller hands the source to mermaid, which renders it or surfaces its own
 * parse error to the user.
 */
export function renderBeautifulMermaid(code: string): string | null {
  const cached = beautifulCache.get(code);
  if (cached !== undefined) return cached;
  const svg = renderBeautifulUncached(code);
  beautifulCache.set(code, svg);
  return svg;
}

function renderBeautifulUncached(code: string): string | null {
  const source = dropTrailingSemicolons(stripLeadingComments(code).trimStart());
  const header = source.split("\n", 1)[0]?.trim() ?? "";
  if (!BEAUTIFUL_HEADER.test(header)) return null;
  try {
    return scopeBeautifulSvg(renderMermaidSVG(source, THEME_COLORS));
  } catch {
    // Falls through to mermaid, which reports the problem if it is real.
    return null;
  }
}

/** Load mermaid once across every diagram so it stays out of the main chunk. */
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
const loadMermaid = (): Promise<typeof import("mermaid")> => (mermaidPromise ??= import("mermaid"));

let mermaidIdCounter = 0;

type Appearance = "light" | "dark";

const mermaidKey = (code: string, appearance: Appearance): string => `${appearance}\0${code}`;

/** A mermaid render already done for this source and appearance, read synchronously. */
export function cachedMermaidSvg(code: string, appearance: Appearance): string | undefined {
  return mermaidCache.get(mermaidKey(code, appearance));
}

/** Render with mermaid itself; rejects with mermaid's parse error on invalid source. */
export async function renderWithMermaid(code: string, appearance: Appearance): Promise<string> {
  const cached = cachedMermaidSvg(code, appearance);
  if (cached !== undefined) return cached;
  const { default: mermaid } = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
    // Never let mermaid inject its error "bomb" diagram into document.body;
    // on a failed render it leaks a stray, un-React-managed node there.
    suppressErrorRendering: true,
    theme: appearance === "dark" ? "dark" : "default",
  });
  // Validate first: parse() throws on invalid syntax without touching the
  // DOM, so render() (and its DOM-leaking error path) never sees bad input.
  await mermaid.parse(code);
  const { svg } = await mermaid.render(`mermaid-${mermaidIdCounter++}`, code);
  mermaidCache.set(mermaidKey(code, appearance), svg);
  return svg;
}
