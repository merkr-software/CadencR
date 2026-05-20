import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./registry";

function shortcutKeys(id: string): string[] {
  const shortcut = SHORTCUTS.find((entry) => entry.id === id);
  if (!shortcut) throw new Error(`Shortcut not found: ${id}`);
  return shortcut.keys;
}

describe("shortcut registry", () => {
  it("keeps unified-agent open-feature on mod+shift+o so Git can use mod+o", () => {
    expect(shortcutKeys("agents-open-feature")).toEqual(["mod", "shift", "o"]);
    expect(shortcutKeys("diff-open-focused-file")).toEqual(["mod", "o"]);
  });
});
