import { describe, expect, it } from "vitest";
import { expandCharacterHotkey } from "./character-hotkeys";

describe("expandCharacterHotkey", () => {
  it("expands Mod+Plus for QWERTY and AZERTY plus characters", () => {
    expect(expandCharacterHotkey("Mod+Plus")).toEqual([
      { hotkey: "Mod+=", exactKeys: ["+"] },
      { hotkey: "Mod+Shift+=", exactKeys: ["+", "="] },
      { hotkey: "Mod+/", exactKeys: ["+"] },
      { hotkey: "Mod+Shift+/", exactKeys: ["+"] },
    ]);
  });

  it("does not add a shifted underscore variant for Mod+Minus", () => {
    expect(expandCharacterHotkey("Mod+-")).toEqual([{ hotkey: "Mod+-", exactKeys: ["-"] }]);
  });

  it("expands the help chord (Mod+Shift+?) into layout-robust variants", () => {
    // All three event.key chars the `?` key can report: `?` (Shift optional),
    // plus the QWERTY (`/`) and AZERTY (`,`) base chars macOS reports under Cmd.
    expect(expandCharacterHotkey("Mod+Shift+?")).toEqual([
      { hotkey: "Mod+?", exactKeys: ["?"] },
      { hotkey: "Mod+Shift+?", exactKeys: ["?"] },
      { hotkey: "Mod+Shift+/", exactKeys: ["/"] },
      { hotkey: "Mod+Shift+,", exactKeys: [","] },
    ]);
  });

  it("expands Mod+? the same way regardless of explicit Shift", () => {
    expect(expandCharacterHotkey("Mod+?")).toEqual(expandCharacterHotkey("Mod+Shift+?"));
  });
});
