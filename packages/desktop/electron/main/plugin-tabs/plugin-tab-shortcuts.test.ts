import { describe, expect, it } from "vitest";

import {
  PluginTabShortcuts,
  parseAppShortcutBindings,
  parseTabShortcuts,
} from "./plugin-tab-shortcuts";

const key = (overrides: Partial<Parameters<PluginTabShortcuts["match"]>[1]>) => ({
  key: "k",
  code: "KeyK",
  meta: true,
  control: false,
  alt: false,
  shift: false,
  ...overrides,
});

describe("PluginTabShortcuts", () => {
  it("matches Cadencr's shortcuts before the instance's, and only its own instance's", () => {
    const shortcuts = new PluginTabShortcuts("mac");
    shortcuts.setApp([{ keys: ["mod", "k"] }]);
    shortcuts.setOwn("i1", [
      { id: "palette", keys: ["mod", "k"] },
      { id: "refresh", keys: ["mod", "shift", "r"] },
    ]);
    expect(shortcuts.match("i1", key({}))).toEqual({ kind: "app" });
    const refresh = key({ key: "r", code: "KeyR", shift: true });
    expect(shortcuts.match("i1", refresh)).toEqual({ kind: "tab", id: "refresh" });
    expect(shortcuts.match("i2", refresh)).toBeNull();
    expect(shortcuts.match("i1", key({ meta: false }))).toBeNull();
    shortcuts.forget("i1");
    expect(shortcuts.match("i1", refresh)).toBeNull();
  });

  it("matches letters by the character typed, whatever the layout", () => {
    const shortcuts = new PluginTabShortcuts("mac");
    shortcuts.setApp([{ keys: ["mod", "a"] }]);
    // AZERTY: the key labelled A sits where QWERTY has Q.
    expect(shortcuts.match("i1", key({ key: "a", code: "KeyQ" }))).toEqual({ kind: "app" });
    expect(shortcuts.match("i1", key({ key: "q", code: "KeyA" }))).toBeNull();
  });

  it("lets typing through without a Cmd, Ctrl or Alt chord", () => {
    const shortcuts = new PluginTabShortcuts("mac");
    shortcuts.setApp([{ keys: ["shift", "k"] }]);
    expect(shortcuts.match("i1", key({ meta: false, shift: true }))).toBeNull();
  });

  it("forgets every instance's shortcuts at once", () => {
    const shortcuts = new PluginTabShortcuts("mac");
    shortcuts.setOwn("i1", [{ id: "palette", keys: ["mod", "k"] }]);
    shortcuts.setOwn("i2", [{ id: "palette", keys: ["mod", "k"] }]);
    shortcuts.forgetAll();
    expect(shortcuts.match("i1", key({}))).toBeNull();
    expect(shortcuts.match("i2", key({}))).toBeNull();
  });

  it("takes nothing before the renderer's first table", () => {
    expect(new PluginTabShortcuts("mac").match("i1", key({}))).toBeNull();
  });

  it("refuses malformed bindings at the IPC boundary", () => {
    for (const bindings of [[{ keys: ["mod"] }], [{ keys: ["mod", "k"], extra: true }], "nope"]) {
      expect(() => parseAppShortcutBindings(bindings), JSON.stringify(bindings)).toThrow();
    }
    expect(() => parseTabShortcuts([{ id: "x", keys: ["mod", "a", "b"] }])).toThrow();
    expect(() => parseTabShortcuts([{ id: "", keys: ["mod", "a"] }])).toThrow();
    expect(parseAppShortcutBindings([{ keys: ["mod", "k"] }])).toEqual([{ keys: ["mod", "k"] }]);
  });
});
