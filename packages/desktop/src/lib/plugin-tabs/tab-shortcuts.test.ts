import { describe, expect, it } from "vitest";

import {
  activeShortcuts,
  appShortcutBindings,
  chordKey,
  resolveTabShortcuts,
} from "./tab-shortcuts";

const shortcut = (id: string, keys: string[]) => ({ id, keys, description: id });

describe("appShortcutBindings", () => {
  it("lists the conversation-wide shortcuts that hold a command modifier", () => {
    const ids = appShortcutBindings({}).map((binding) => binding.id);
    expect(ids).toContain("command-palette");
    expect(ids).toContain("pane-agent");
    expect(ids).toContain("git-commit");
    // The menu owns ⌘Q; Git-tab and terminal keys only apply in their tab.
    expect(ids).not.toContain("quit");
    expect(ids).not.toContain("git-next-item");
    expect(ids).not.toContain("settings-back");
  });

  it("follows rebinding", () => {
    const palette = appShortcutBindings({ "command-palette": { keys: ["mod", "p"] } }).find(
      (binding) => binding.id === "command-palette",
    );
    expect(palette?.keys).toEqual(["mod", "p"]);
  });

  it("drops a rebinding that no longer holds a command modifier", () => {
    const ids = appShortcutBindings({ "command-palette": { keys: ["shift", "k"] } }).map(
      (binding) => binding.id,
    );
    expect(ids).not.toContain("command-palette");
  });
});

describe("chordKey", () => {
  it("compares chords as the keys pressed on this platform", () => {
    expect(chordKey(["shift", "mod", "K"], true)).toBe(chordKey(["mod", "shift", "k"], true));
    // `mod` is Ctrl off macOS, so it collides with a literal ctrl there only.
    expect(chordKey(["mod", "k"], false)).toBe(chordKey(["ctrl", "k"], false));
    expect(chordKey(["mod", "k"], true)).not.toBe(chordKey(["ctrl", "k"], true));
    expect(chordKey(["mod", "question"], true)).toBe(chordKey(["mod", "shift", "slash"], true));
  });
});

describe("resolveTabShortcuts", () => {
  it("names the Cadencr shortcut that takes a tab shortcut's keys", () => {
    const resolved = resolveTabShortcuts(
      [shortcut("palette", ["mod", "k"]), shortcut("refresh", ["mod", "alt", "shift", "r"])],
      appShortcutBindings({}),
      true,
    );
    expect(resolved[0]?.takenBy?.id).toBe("command-palette");
    expect(resolved[1]?.takenBy).toBeNull();
    expect(activeShortcuts(resolved).map(({ id }) => id)).toEqual(["refresh"]);
  });
});
