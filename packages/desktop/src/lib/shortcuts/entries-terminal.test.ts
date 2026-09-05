import { describe, expect, it, vi } from "vitest";
import { matchesKeyboardEvent, parseHotkey } from "@tanstack/hotkeys";

const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock("./format", () => ({
  get PLATFORM_IS_MAC() {
    return platform.isMac;
  },
}));

describe("terminal clipboard shortcut defaults", () => {
  it.each([true, false])("preserves shell control keys on platform isMac=%s", async (isMac) => {
    platform.isMac = isMac;
    vi.resetModules();
    const { TERMINAL_SHORTCUTS } = await import("./entries-terminal");
    for (const [id, key] of [
      ["terminal-copy", "c"],
      ["terminal-paste", "v"],
    ]) {
      const shortcut = TERMINAL_SHORTCUTS.find((entry) => entry.id === id);
      expect(shortcut?.keys).toEqual(isMac ? ["mod", key] : ["mod", "shift", key]);
      const hotkey = parseHotkey(
        shortcut!.keys
          .map((token) => (token === "mod" ? (isMac ? "Meta" : "Control") : token))
          .join("+"),
      );
      expect(
        matchesKeyboardEvent(
          new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true }),
          hotkey,
        ),
      ).toBe(false);
      expect(
        matchesKeyboardEvent(
          new KeyboardEvent("keydown", {
            key: isMac ? key : key.toUpperCase(),
            code: "KeyJ",
            metaKey: isMac,
            ctrlKey: !isMac,
            shiftKey: !isMac,
          }),
          hotkey,
        ),
      ).toBe(true);
    }
  });
});
