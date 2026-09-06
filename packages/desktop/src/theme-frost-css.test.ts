import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FROST_DARK_THEME } from "./lib/themes/frost-dark";
import { FROST_LIGHT_THEME } from "./lib/themes/frost-light";

/**
 * Guards the two production-build pitfalls that silently killed the frost
 * `backdrop-filter` blur in packaged builds while `pnpm dev` looked fine.
 * Both are invisible at dev time, so a source-level assertion is the only
 * cheap regression net. See the comments in `theme-frost.css`.
 */
describe("frost theme CSS", () => {
  const frostCss = readFileSync(join(process.cwd(), "src/theme-frost.css"), "utf8");
  // Strip block comments so the rule below doesn't trip on the explanatory note.
  const frostRules = frostCss.replace(/\/\*[\s\S]*?\*\//g, "");

  it("never hand-writes -webkit-backdrop-filter (Lightning CSS collapses the pair to the webkit-only form Chromium ignores)", () => {
    expect(frostRules).not.toMatch(/-webkit-backdrop-filter/);
    // The standard property must still be present so there is glass to ship.
    expect(frostRules).toMatch(/backdrop-filter:\s*var\(--glass-backdrop\)/);
  });

  it("keeps an opaque backdrop root so backdrop-filter paints (crbug.com/380416865)", () => {
    // The rule is generic now — any theme whose texture declares a base gets an
    // opaque :root and a fully transparent body (not the partial-alpha
    // --background, which disables every backdrop-filter on the page).
    const chromeRules = readFileSync(join(process.cwd(), "src/theme-chrome.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(chromeRules).toMatch(
      /:root\[data-texture-base\]\s*{\s*background-color:\s*var\(--ambient-base\);/s,
    );
    expect(chromeRules).toMatch(
      /:root\[data-texture-base\] body\s*{\s*background-color:\s*transparent;/s,
    );
    // …which only reaches Frost because Frost's own texture declares that base.
    // Without it the glass would be flat again, and nothing else would say so.
    expect(FROST_DARK_THEME.chrome?.texture.base).toBeTruthy();
    expect(FROST_LIGHT_THEME.chrome?.texture.base).toBeTruthy();
  });

  it("gives the sidebar worktree group a visible frost fill without a layout shift", () => {
    // The base rule's foreground wash is too faint on glass. The frost
    // override must:
    //   - reuse --option-card-bg (no redundant --worktree-group-bg token),
    //   - leave the rim to the base rule's --sidebar-border, which frost
    //     already tunes for glass (no duplicate --worktree-group-border),
    //   - set color only (the component reserves a 1px border slot, so a
    //     `border:` shorthand here would add border-width and shift inner
    //     content by 1px on frost themes).
    expect(frostRules).not.toMatch(/--worktree-group-(bg|border)/);
    expect(frostRules).toMatch(
      /:root\[data-theme="frost-dark"\]\s+\.worktree-group,\s*:root\[data-theme="frost-light"\]\s+\.worktree-group\s*{\s*background-color:\s*var\(--option-card-bg\);\s*}/s,
    );
  });

  it("matches Frost Dark terminal chrome to the opaque WebGPU canvas", () => {
    expect(FROST_DARK_THEME.xterm.background).toBe("#141826");
    expect(frostRules).toMatch(/--terminal-bg:\s*#141826;/);
  });

  it("applies the frost blur to tooltip overlays", () => {
    expect(frostRules.match(/\[data-slot="tooltip-content"\]/g)).toHaveLength(2);
  });
});
