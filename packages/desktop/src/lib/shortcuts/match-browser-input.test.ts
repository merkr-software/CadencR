import { describe, expect, it } from "vitest";

import { matchesBrowserShortcutInput } from "./match-browser-input";

describe("matchesBrowserShortcutInput", () => {
  it.each(["mac", "linux"] as const)(
    "preserves distinct glyph and Shift chords on %s",
    (platform) => {
      const modifier = platform === "mac" ? { meta: true } : { control: true };
      for (const [key, code, token] of [
        ["[", "BracketLeft", "lbracket"],
        ["]", "BracketRight", "rbracket"],
      ] as const) {
        const input = { key, code, ...modifier };
        expect(matchesBrowserShortcutInput(input, { keys: ["mod", token] }, platform)).toBe(true);
        expect(
          matchesBrowserShortcutInput(
            { ...input, shift: true },
            { keys: ["mod", token] },
            platform,
          ),
        ).toBe(false);
        expect(
          matchesBrowserShortcutInput(
            { ...input, shift: true },
            { keys: ["mod", "shift", token] },
            platform,
          ),
        ).toBe(true);
      }
      expect(
        matchesBrowserShortcutInput(
          { key: "-", code: "Minus", shift: true, ...modifier },
          { keys: ["mod", "minus"] },
          platform,
        ),
      ).toBe(false);
      expect(
        matchesBrowserShortcutInput(
          { key: "0", code: "Digit0", shift: true, ...modifier },
          { keys: ["mod", "0"] },
          platform,
        ),
      ).toBe(true);
      expect(
        matchesBrowserShortcutInput(
          { key: "+", code: "Slash", ...modifier },
          { keys: ["mod", "plus"] },
          platform,
        ),
      ).toBe(true);
      expect(
        matchesBrowserShortcutInput(
          { key: "?", code: "Comma", shift: true, ...modifier },
          { keys: ["mod", "shift", "question"] },
          platform,
        ),
      ).toBe(true);
    },
  );

  it("matches letters by layout-aware key rather than physical code", () => {
    expect(
      matchesBrowserShortcutInput(
        { key: "f", code: "KeyG", meta: true },
        { keys: ["mod", "f"] },
        "mac",
      ),
    ).toBe(true);
  });

  it("honors overrides and alternate bindings without retaining Cmd+F", () => {
    const binding = { keys: ["mod", "k"], altKeys: ["ctrl", "shift", "f"] };
    expect(
      matchesBrowserShortcutInput({ key: "f", code: "KeyF", meta: true }, binding, "mac"),
    ).toBe(false);
    expect(
      matchesBrowserShortcutInput({ key: "k", code: "KeyK", meta: true }, binding, "mac"),
    ).toBe(true);
    expect(
      matchesBrowserShortcutInput(
        { key: "f", code: "KeyF", control: true, shift: true },
        binding,
        "mac",
      ),
    ).toBe(true);
  });

  it("supports control-mangled keys and treats an empty chord as disabled", () => {
    expect(
      matchesBrowserShortcutInput(
        { key: "\u0006", code: "KeyF", control: true },
        { keys: ["mod", "f"] },
        "linux",
      ),
    ).toBe(true);
    expect(
      matchesBrowserShortcutInput({ key: "f", code: "KeyF", control: true }, { keys: [] }, "linux"),
    ).toBe(false);
  });
});
