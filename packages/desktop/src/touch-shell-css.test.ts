import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Neither happy-dom nor jsdom evaluates pointer media queries or computes the
 * cascade of these files, so this pins the rules instead. Dropping the hint
 * rule brings key badges back on phones; an ungated rail rule brings the
 * desktop chassis (a detached band over a bordered card) into the phone layout.
 */
function cssRules(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every selector in a stylesheet, comma groups split, whitespace collapsed. */
function selectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+){[^{}]*}/g)]
    .flatMap((match) => match[1].split(","))
    .map((selector) => selector.replace(/\s+/g, " ").trim())
    .filter((selector) => selector !== "" && !selector.startsWith("@"));
}

describe("touch-shell CSS", () => {
  const touchShell = cssRules("./touch-shell.css");

  it("hides every keyboard hint wherever the primary pointer is a finger", () => {
    expect(touchShell).toMatch(
      /@media \(pointer: coarse\)\s*{\s*\[data-kbd-hint\]\s*{\s*display:\s*none !important;\s*}\s*}/,
    );
  });

  it("is imported unlayered, after Tailwind, so its rules beat utilities", () => {
    const indexCss = cssRules("./index.css");
    const imports = [...indexCss.matchAll(/@import\s+"([^"]+)"([^;]*);/g)];
    const touch = imports.find(([, path]) => path === "./touch-shell.css");
    expect(touch?.[2].trim()).toBe("");
    const order = imports.map(([, path]) => path);
    expect(order.indexOf("./touch-shell.css")).toBeGreaterThan(order.indexOf("tailwindcss"));
  });
});

describe("rail chassis CSS", () => {
  const railSelectors = selectors(cssRules("./theme-chrome.css")).filter((selector) =>
    selector.includes('[data-chassis="rail"]'),
  );

  it("styles only the desktop layout", () => {
    expect(railSelectors.length).toBeGreaterThan(0);
    for (const selector of railSelectors) {
      expect(selector).toMatch(
        /^:root\[data-chassis="rail"\]:where\(:not\(\[data-shell="phone"\]\)\)/,
      );
    }
  });
});
