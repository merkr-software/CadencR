import { describe, expect, it, vi } from "vitest";

// Stub the platform check so we can exercise both branches in one process.
// `resolve.ts` reads `PLATFORM_IS_MAC` at module load, so the mock has to be
// declared before the import.
const platformMock = vi.hoisted(() => ({ isMac: true }));
vi.mock("./format", () => ({
  get PLATFORM_IS_MAC() {
    return platformMock.isMac;
  },
}));

async function importResolve() {
  vi.resetModules();
  return await import("./resolve");
}

describe("tokensToHotkeyString", () => {
  it('preserves "mod" as TanStack "Mod"', async () => {
    platformMock.isMac = true;
    const { tokensToHotkeyString } = await importResolve();
    expect(tokensToHotkeyString(["mod", "k"])).toBe("Mod+K");
  });

  it('translates "plus" to a project token that matches the literal + character', async () => {
    platformMock.isMac = true;
    const { tokensToHotkeyString } = await importResolve();
    expect(tokensToHotkeyString(["mod", "plus"])).toBe("Mod+Plus");
  });

  it("emits TanStack-compatible aliases and punctuation", async () => {
    platformMock.isMac = true;
    const { tokensToHotkeyString } = await importResolve();
    expect(tokensToHotkeyString(["mod", "shift", "rbracket"])).toBe("Mod+Shift+]");
    expect(tokensToHotkeyString(["mod", "slash"])).toBe("Mod+/");
    expect(tokensToHotkeyString(["mod", "comma"])).toBe("Mod+,");
    expect(tokensToHotkeyString(["mod", "alt", "left"])).toBe("Mod+Alt+ArrowLeft");
    expect(tokensToHotkeyString(["shift", "tab"])).toBe("Shift+Tab");
  });

  it("passes letters uppercased and digits unchanged", async () => {
    platformMock.isMac = true;
    const { tokensToHotkeyString } = await importResolve();
    expect(tokensToHotkeyString(["mod", "shift", "N"])).toBe("Mod+Shift+N");
    expect(tokensToHotkeyString(["mod", "0"])).toBe("Mod+0");
  });

  it('keeps "mod" platform-adaptive on non-mac too', async () => {
    platformMock.isMac = false;
    const { tokensToHotkeyString } = await importResolve();
    expect(tokensToHotkeyString(["mod", "b"])).toBe("Mod+B");
  });

  it('normalizes literal "ctrl" to TanStack "Control"', async () => {
    platformMock.isMac = false;
    const { tokensToHotkeyString } = await importResolve();
    expect(tokensToHotkeyString(["ctrl", "j"])).toBe("Control+J");
  });
});

describe("resolveHotkeyTrigger", () => {
  it("returns a plain string when there are no altKeys", async () => {
    platformMock.isMac = true;
    const { resolveHotkeyTrigger } = await importResolve();
    expect(resolveHotkeyTrigger({ keys: ["mod", "k"] })).toBe("Mod+K");
  });

  it("returns [primary, alt] when altKeys is set — both bound to the same action", async () => {
    platformMock.isMac = true;
    const { resolveHotkeyTrigger } = await importResolve();
    expect(resolveHotkeyTrigger({ keys: ["mod", "shift", "p"], altKeys: ["alt", "p"] })).toEqual([
      "Mod+Shift+P",
      "Alt+P",
    ]);
  });

  it("expands digit-range shortcuts for TanStack registrations", async () => {
    platformMock.isMac = true;
    const { resolveHotkeyTrigger } = await importResolve();
    expect(resolveHotkeyTrigger({ keys: ["1-9"] })).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });
});

describe("modified digit ranges", () => {
  it("binds one combo per digit, keeping the modifiers", async () => {
    platformMock.isMac = true;
    const { resolveHotkeyTrigger } = await importResolve();
    const combos = resolveHotkeyTrigger({ keys: ["mod", "alt", "1-3"] });
    expect(combos).toEqual(["Mod+Alt+1", "Mod+Alt+2", "Mod+Alt+3"]);
  });
});

describe("getRegistryShortcut", () => {
  it("returns the registry entry for a known id", async () => {
    platformMock.isMac = true;
    const { getRegistryShortcut } = await importResolve();
    expect(getRegistryShortcut("command-palette")).toMatchObject({
      id: "command-palette",
      keys: ["mod", "k"],
      scope: "global",
    });
  });
});
