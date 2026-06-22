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

  it("scopes new-session to feature pages and gives the agents view its own mod+shift+n", () => {
    const newSession = SHORTCUTS.find((s) => s.id === "new-session");
    const agentsNew = SHORTCUTS.find((s) => s.id === "agents-new-feature");
    expect(newSession?.scope).toBe("feature");
    expect(newSession?.keys).toEqual(["mod", "shift", "n"]);
    expect(agentsNew?.scope).toBe("unified-agents");
    expect(agentsNew?.keys).toEqual(["mod", "shift", "n"]);
  });

  it("registers find-in-conversation on mod+f in the agent scope", () => {
    const conversationSearch = SHORTCUTS.find((s) => s.id === "conversation-search");
    expect(conversationSearch?.keys).toEqual(["mod", "f"]);
    expect(conversationSearch?.scope).toBe("agent");
    // mod+f is shared with the editor's "find in current file" — a deliberate
    // cross-scope reuse, gated by which tab is focused. They must NOT collide
    // within the same scope.
    const editorSearch = SHORTCUTS.find((s) => s.id === "editor-buffer-search");
    expect(editorSearch?.keys).toEqual(["mod", "f"]);
    expect(editorSearch?.scope).not.toBe(conversationSearch?.scope);
  });
});
