import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * jsdom doesn't compute `-webkit-app-region`, so this pins the selectors
 * instead. Floating layers paint over the titlebar drag bands without being
 * inside them; dropping one of these selectors brings back "clicking the
 * toast button drags the window".
 */
describe("drag region CSS", () => {
  const indexCss = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const rules = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const noDragSelectors = [...rules.matchAll(/([^{}]+){\s*-webkit-app-region:\s*no-drag;\s*}/g)]
    .flatMap((match) => match[1].split(","))
    .map((selector) => selector.trim());

  it("cuts every floating layer out of the drag area wherever it renders", () => {
    expect(noDragSelectors).toEqual(
      expect.arrayContaining([
        '.titlebar-drag [data-slot="context-menu-trigger"]',
        "body > :not(#root)",
        "body > :not(#root) > *",
        "[data-sonner-toast]",
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[role="menu"]',
        '[role="listbox"]',
        '[role="tooltip"]',
      ]),
    );
  });
});
