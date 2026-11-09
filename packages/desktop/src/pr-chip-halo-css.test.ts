import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * jsdom doesn't paint shadows, so this pins the rule instead. A chip with
 * running checks that wraps onto the title fold's clipped line must not glow
 * under the title: in the fold, its halo stays inside the chip's box.
 */
describe("running-checks halo CSS", () => {
  const indexCss = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const rules = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");

  it("keeps the halo inside the chip beside the title", () => {
    const fold = rules.match(
      /\[data-feature-title-fold\]\s+\.pr-chip-checks-running::after\s*{([^}]*)}/,
    );
    expect(fold?.[1]).toMatch(/box-shadow:\s*inset\b/);
  });
});
