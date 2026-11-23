import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import type { BrowserShortcut } from "@/lib/desktop-bridge";
import { useBrowserShortcutRelay } from "./useBrowserShortcutRelay";

const onBrowserShortcut = vi.hoisted(() => vi.fn());

vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: { onBrowserShortcut },
}));

describe("useBrowserShortcutRelay", () => {
  beforeEach(() => {
    onBrowserShortcut.mockReset();
  });

  it("subscribes once, forwards shortcuts, and unsubscribes on unmount", () => {
    const unsubscribe = vi.fn();
    let emit: ((shortcut: BrowserShortcut) => void) | undefined;
    onBrowserShortcut.mockImplementation((cb: (shortcut: BrowserShortcut) => void) => {
      emit = cb;
      return unsubscribe;
    });

    const handler = vi.fn();
    const { unmount } = renderHook(() => useBrowserShortcutRelay(handler));

    expect(onBrowserShortcut).toHaveBeenCalledTimes(1);
    emit?.("pane-agent");
    expect(handler).toHaveBeenCalledWith("pane-agent");

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("invokes the latest handler without re-subscribing on re-render", () => {
    let emit: ((shortcut: BrowserShortcut) => void) | undefined;
    onBrowserShortcut.mockImplementation((cb: (shortcut: BrowserShortcut) => void) => {
      emit = cb;
      return () => undefined;
    });

    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useBrowserShortcutRelay(handler), {
      initialProps: { handler: first },
    });

    rerender({ handler: second });
    emit?.("reload");

    expect(onBrowserShortcut).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("reload");
  });

  it("runs only the handler of the workspace on screen", () => {
    // The main process sends a relay to every listener.
    const listeners: Array<(shortcut: BrowserShortcut) => void> = [];
    onBrowserShortcut.mockImplementation((cb: (shortcut: BrowserShortcut) => void) => {
      listeners.push(cb);
      return () => undefined;
    });
    const inWorkspace = (activity: WorkspaceActivityController) => ({
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
      ),
    });
    const shownActivity = createWorkspaceActivity(true);
    const hiddenActivity = createWorkspaceActivity(false);
    const shown = vi.fn();
    const hidden = vi.fn();
    renderHook(() => useBrowserShortcutRelay(shown), inWorkspace(shownActivity));
    renderHook(() => useBrowserShortcutRelay(hidden), inWorkspace(hiddenActivity));
    const relay = (shortcut: BrowserShortcut): void => {
      for (const listener of listeners) listener(shortcut);
    };

    relay("pane-git");
    expect(shown).toHaveBeenCalledWith("pane-git");
    expect(hidden).not.toHaveBeenCalled();

    // Read when the relay arrives: switching needs no render.
    shownActivity.set(false);
    hiddenActivity.set(true);
    relay("reload");
    expect(hidden).toHaveBeenCalledWith("reload");
    expect(shown).toHaveBeenCalledTimes(1);
  });
});
