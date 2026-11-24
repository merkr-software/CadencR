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

describe("phone tab bar CSS", () => {
  const bar = cssRules("./phone-tab-bar.css");

  it("owns the bottom safe area: the pane it closes zeroes the inset for what sits above", () => {
    expect(bar).toMatch(/\[data-phone-tab-bar-host\]\s*{\s*--app-inset-bottom:\s*0px;\s*}/);
    expect(bar).toMatch(/padding:[^;]*env\(safe-area-inset-bottom/);
  });

  it("steps aside while the on-screen keyboard is up", () => {
    expect(bar).toMatch(/html\[data-keyboard-open\] \.phone-tab-bar\s*{\s*display:\s*none;\s*}/);
  });

  it("shrinks to 44px of icons on a short screen", () => {
    expect(bar).toMatch(
      /@media \(max-height: 499px\)\s*{\s*\.phone-tab-bar\s*{\s*height:\s*calc\(44px/,
    );
  });

  it("is imported unlayered, after Tailwind", () => {
    const imports = [...cssRules("./index.css").matchAll(/@import\s+"([^"]+)"([^;]*);/g)];
    const entry = imports.find(([, path]) => path === "./phone-tab-bar.css");
    expect(entry?.[2].trim()).toBe("");
    const order = imports.map(([, path]) => path);
    expect(order.indexOf("./phone-tab-bar.css")).toBeGreaterThan(order.indexOf("tailwindcss"));
  });
});
