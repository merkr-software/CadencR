import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useAgentLetterFocus } from "@/hooks/useAgentLetterFocus";
import { useGlobalShortcutById, useShortcut } from "@/hooks/useShortcut";
import { runShortcutAction, useShortcutActionStore } from "@/lib/command-palette/shortcut-actions";

// `test-setup.ts` pins `navigator.platform = "MacIntel"`, so `mod` is `meta`.

function ToggleSidebar({ onFire }: { onFire: () => void }) {
  useShortcut("toggle-sidebar", onFire);
  return null;
}

function ShortcutsHelp({ onFire }: { onFire: () => void }) {
  useGlobalShortcutById("shortcuts-help", onFire);
  return null;
}

function Commit({ onFire }: { onFire: () => void }) {
  useShortcut("git-commit", onFire);
  return null;
}

function LetterFocus({ onFocus }: { onFocus: () => void }) {
  useAgentLetterFocus({ enabled: true, onFocus });
  return null;
}

function renderInWorkspace(activity: WorkspaceActivityController, children: ReactNode) {
  return render(<WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>);
}

function pressToggleSidebar(): void {
  fireEvent.keyDown(document.body, { key: "b", code: "KeyB", metaKey: true });
}

function pressShortcutsHelp(): void {
  // ⌘⇧/ on QWERTY: the key labelled "?".
  fireEvent.keyDown(window, { key: "?", code: "Slash", metaKey: true, shiftKey: true });
}

describe("a workspace kept mounted but hidden", () => {
  afterEach(() => useShortcutActionStore.setState({ byId: {} }));

  it("handles no bubbling shortcut until it is shown, without re-rendering", () => {
    const onFire = vi.fn();
    const activity = createWorkspaceActivity(false);
    renderInWorkspace(activity, <ToggleSidebar onFire={onFire} />);

    pressToggleSidebar();
    expect(onFire).not.toHaveBeenCalled();

    // No `act`: nothing renders, the handler reads the activity when the key arrives.
    activity.set(true);
    pressToggleSidebar();
    expect(onFire).toHaveBeenCalledTimes(1);

    activity.set(false);
    pressToggleSidebar();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("handles no capture-phase shortcut until it is shown", () => {
    const onFire = vi.fn();
    const activity = createWorkspaceActivity(false);
    renderInWorkspace(activity, <ShortcutsHelp onFire={onFire} />);

    pressShortcutsHelp();
    expect(onFire).not.toHaveBeenCalled();

    activity.set(true);
    pressShortcutsHelp();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("offers its actions to the command palette only while it is on screen", () => {
    const hidden = vi.fn();
    const shown = vi.fn();
    const hiddenActivity = createWorkspaceActivity(false);
    const shownActivity = createWorkspaceActivity(true);
    renderInWorkspace(shownActivity, <Commit onFire={shown} />);
    // Mounted last: it would win the palette if it registered.
    renderInWorkspace(hiddenActivity, <Commit onFire={hidden} />);

    act(() => void runShortcutAction("git-commit"));
    expect(shown).toHaveBeenCalledTimes(1);
    expect(hidden).not.toHaveBeenCalled();

    act(() => {
      shownActivity.set(false);
      hiddenActivity.set(true);
    });
    act(() => void runShortcutAction("git-commit"));
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("does not pull a typed letter into its prompt", () => {
    const onFocus = vi.fn();
    const activity = createWorkspaceActivity(false);
    renderInWorkspace(activity, <LetterFocus onFocus={onFocus} />);

    fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    expect(onFocus).not.toHaveBeenCalled();

    activity.set(true);
    fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
