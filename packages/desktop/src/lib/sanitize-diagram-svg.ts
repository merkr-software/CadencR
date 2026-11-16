import createDOMPurify, { type DOMPurify } from "dompurify";

const LOCAL_REFERENCE = /^#[\w:.-]+$/;
const LOCAL_URL = /url\(\s*(["']?)#[\w:.-]+\1\s*\)/gi;
const SAFE_FUNCTIONS = new Set([
  "var",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "oklch",
  "oklab",
  "color",
  "color-mix",
  "calc",
  "min",
  "max",
  "clamp",
  "translate",
  "translatex",
  "translatey",
  "scale",
  "scalex",
  "scaley",
  "rotate",
  "skew",
  "matrix",
  "linear-gradient",
  "radial-gradient",
]);
const SAFE_PROPERTIES = new Set([
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "fill-opacity",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "white-space",
  "color",
  "background",
  "background-color",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "width",
  "height",
  "max-width",
  "overflow",
  "display",
  "visibility",
  "transform",
  "transform-origin",
  "marker-start",
  "marker-mid",
  "marker-end",
  "clip-path",
  "filter",
  "paint-order",
  "rx",
  "ry",
  "x",
  "y",
]);

let purifier: DOMPurify | undefined;
let diagramCounter = 0;
let currentScope = "";

/** CSS is restricted in addition to DOMPurify's markup/URI sanitization. */
function safeCssValue(value: string): boolean {
  const remainder = value.replace(LOCAL_URL, "");
  if (/[\\@<>]|\/\*|expression\s*\(/i.test(remainder)) return false;
  return [...remainder.matchAll(/([\w-]+)\s*\(/g)].every((match) =>
    SAFE_FUNCTIONS.has(match[1].toLowerCase()),
  );
}

function sanitizeDeclarations(source: string): string {
  const style = document.createElement("span").style;
  style.cssText = source;
  for (const property of Array.from(style)) {
    if (
      (!SAFE_PROPERTIES.has(property) && !property.startsWith("--")) ||
      !safeCssValue(style.getPropertyValue(property))
    ) {
      style.removeProperty(property);
    }
  }
  return style.cssText;
}

function sanitizeStylesheet(source: string): string {
  // A constructed sheet parses CSS without adoption, network imports or host styles.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(source);
  return Array.from(sheet.cssRules)
    .flatMap((rule) => {
      // Drop @import, @font-face, animations and all nested/unknown rules.
      if (rule.type !== 1) return [];
      const cssRule = rule as CSSStyleRule;
      if (/[\\@<>]/.test(cssRule.selectorText)) return [];
      const declarations = sanitizeDeclarations(cssRule.style.cssText);
      if (!declarations) return [];
      const scope = `[data-cadencr-diagram="${currentScope}"]`;
      return [
        `${scope}:is(${cssRule.selectorText}),${scope} :is(${cssRule.selectorText}){${declarations}}`,
      ];
    })
    .join("\n");
}

function diagramPurifier(): DOMPurify {
  if (purifier) return purifier;
  purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    if (
      ["href", "xlink:href", "src"].includes(data.attrName) &&
      !LOCAL_REFERENCE.test(data.attrValue)
    )
      data.keepAttr = false;
    if (data.attrName === "style") data.attrValue = sanitizeDeclarations(data.attrValue);
    else if (!safeCssValue(data.attrValue)) data.keepAttr = false;
  });
  purifier.addHook("uponSanitizeElement", (node) => {
    if (node.nodeName.toLowerCase() === "style")
      node.textContent = sanitizeStylesheet(node.textContent ?? "");
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.localName === "svg") node.setAttribute("data-cadencr-diagram", currentScope);
  });
  return purifier;
}

/** Sanitize the final output from either diagram renderer, directly before injection. */
export function sanitizeDiagramSvg(svg: string): string {
  currentScope = `diagram-${diagramCounter++}`;
  return diagramPurifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["target", "xml:base"],
    ALLOW_DATA_ATTR: true,
  });
}
