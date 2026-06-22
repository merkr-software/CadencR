import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    // :root carries an opaque base; body drops to fully transparent (not the
    // partial-alpha --background, which disables every backdrop-filter).
    expect(frostRules).toMatch(
      /:root\[data-theme="frost-dark"\],\s*:root\[data-theme="frost-light"\]\s*{\s*background-color:\s*var\(--ambient-base\);/s,
    );
    expect(frostRules).toMatch(
      /:root\[data-theme="frost-dark"\] body,\s*:root\[data-theme="frost-light"\] body\s*{\s*background-color:\s*transparent;/s,
    );
  });

  it("gives the sidebar worktree group a visible frost fill + rim without a layout shift", () => {
    // The default `bg-muted/30` vanishes in frost. The frost override must:
    //   - reuse --option-card-bg (no redundant --worktree-group-bg token),
    //   - swap border-COLOR only (the component reserves a transparent border
    //     slot, so a `border:` shorthand here would add border-width and shift
    //     inner content by 1px on frost themes).
    expect(frostRules).not.toMatch(/--worktree-group-bg/);
    expect(frostRules).toMatch(
      /:root\[data-theme="frost-dark"\]\s+\.worktree-group,\s*:root\[data-theme="frost-light"\]\s+\.worktree-group\s*{\s*background-color:\s*var\(--option-card-bg\);\s*border-color:\s*var\(--worktree-group-border\);\s*}/s,
    );
  });
});
