/**
 * Build email-safe HTML from the rendered conversation selection.
 *
 * The fragment is staged in the live document so Tailwind/theme classes can
 * resolve through `getComputedStyle()`. We then rebuild it with a small HTML
 * allowlist and inline only portable text/spacing/table styles. Backgrounds
 * are intentionally omitted: email compose surfaces provide their own.
 */

import { cssColorToRgb, type RgbColor } from "@/lib/css-color";
import { isUserOpenableUrl } from "@/lib/safe-url";

const SAFE_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const SKIPPED_TAGS = new Set(["button", "iframe", "input", "script", "style", "svg"]);

const EMAIL_STYLE_PROPERTIES = [
  "border-bottom-color",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-top-color",
  "border-top-style",
  "border-top-width",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "list-style-position",
  "list-style-type",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "vertical-align",
  "white-space",
  "word-break",
] as const;

const RGB_RE = /^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i;

/** Convert one DOM range to transparent-background, inline-styled email HTML. */
export function rangeToEmailHtml(range: Range): string {
  const context = elementForNode(range.commonAncestorContainer);
  const stagedRoot = context ? context.cloneNode(false) : document.createElement("div");
  if (!(stagedRoot instanceof Element)) return "";
  stagedRoot.append(range.cloneContents());
  const selectionRoot = wrapSemanticAncestors(stagedRoot, context);

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;visibility:hidden;";
  host.append(selectionRoot);
  document.body.append(host);
  try {
    const output = emailNode(selectionRoot);
    if (!output) return "";
    const container = document.createElement("div");
    container.append(output);
    return container.innerHTML;
  } finally {
    host.remove();
  }
}

function wrapSemanticAncestors(stagedRoot: Element, context: Element | null): Element {
  if (!context) return stagedRoot;
  const semanticRoot = context.closest("ol, table, ul");
  if (!semanticRoot || semanticRoot === context) return stagedRoot;

  let output = stagedRoot;
  let ancestor = context.parentElement;
  while (ancestor) {
    const wrapper = ancestor.cloneNode(false);
    if (!(wrapper instanceof Element)) break;
    wrapper.append(output);
    output = wrapper;
    if (ancestor === semanticRoot) break;
    ancestor = ancestor.parentElement;
  }
  return output;
}

function elementForNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function emailNode(node: Node): HTMLElement | Text | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const source = node as Element;
  const computed = getComputedStyle(source);
  if (computed.display === "none") return null;
  const sourceTag = source.tagName.toLowerCase();
  if (SKIPPED_TAGS.has(sourceTag)) return null;

  const tag = SAFE_TAGS.has(sourceTag) ? sourceTag : computed.display === "inline" ? "span" : "div";
  const target = document.createElement(tag);
  copySafeAttributes(source, target, sourceTag);
  const style = inlineEmailStyle(computed);
  if (style) target.setAttribute("style", style);
  for (const child of source.childNodes) {
    const copied = emailNode(child);
    if (copied) target.append(copied);
  }
  return target;
}

function copySafeAttributes(source: Element, target: HTMLElement, tag: string): void {
  if (tag === "a") {
    const href = safeEmailHref(source.getAttribute("href"));
    if (href) target.setAttribute("href", href);
  }
  if (tag === "img") {
    const src = safeEmailImageSrc(source.getAttribute("src"));
    if (src) target.setAttribute("src", src);
    for (const attribute of ["alt", "title", "width", "height"] as const) {
      const value = source.getAttribute(attribute);
      if (value) target.setAttribute(attribute, value);
    }
  }
  if (tag === "td" || tag === "th") {
    for (const attribute of ["colspan", "rowspan"] as const) {
      const value = source.getAttribute(attribute);
      if (value) target.setAttribute(attribute, value);
    }
  }
}

function safeEmailImageSrc(src: string | null): string | null {
  if (!src) return null;
  if (/^data:image\/(?:gif|jpeg|png|webp);/i.test(src)) return src;
  return safeAbsoluteHttpUrl(src);
}

function safeEmailHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return url.href;
    return isUserOpenableUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

function safeAbsoluteHttpUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return isUserOpenableUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

function inlineEmailStyle(computed: CSSStyleDeclaration): string {
  const entries: string[] = [];
  for (const property of EMAIL_STYLE_PROPERTIES) {
    const value = computed.getPropertyValue(property);
    if (value) entries.push(`${property}:${value}`);
  }
  const color = readableEmailColor(computed.color);
  if (color) entries.unshift(`color:${color}`);
  return entries.join(";");
}

/** Keep the source hue while making light-theme-independent text legible on white. */
function readableEmailColor(value: string): string {
  const rgb = parseRgb(value) ?? cssColorToRgb(value);
  if (!rgb) return value;
  let { red, green, blue } = rgb;
  while (contrastAgainstWhite({ red, green, blue }) < 4.5) {
    red *= 0.88;
    green *= 0.88;
    blue *= 0.88;
  }
  return `rgb(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)})`;
}

function parseRgb(value: string): RgbColor | null {
  const match = RGB_RE.exec(value);
  if (!match) return null;
  return { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]) };
}

function contrastAgainstWhite(color: RgbColor): number {
  const luminance = relativeLuminance(color);
  return 1.05 / (luminance + 0.05);
}

function relativeLuminance({ red, green, blue }: RgbColor): number {
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}
