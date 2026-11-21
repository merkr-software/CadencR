import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import type { BrowserShortcut } from "@/lib/desktop-bridge";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import { getFocusedTab, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { useFeatureLayoutHotkeys } from "./useFeatureLayoutHotkeys";

const relayListeners = vi.hoisted(() => [] as Array<(shortcut: BrowserShortcut) => void>);

vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: {
    onBrowserShortcut: (listener: (shortcut: BrowserShortcut) => void) => {
      relayListeners.push(listener);
      return () => undefined;
    },
  },
}));
// The window key bindings are covered elsewhere; only the relay matters here.
vi.mock("@/hooks/useShortcut", () => ({ useShortcut: vi.fn() }));

function inWorkspace(activity: WorkspaceActivityController) {
  return {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
    ),
  };
}

function relay(shortcut: BrowserShortcut): void {
  for (const listener of relayListeners) listener(shortcut);
}

const focusedTabOf = (featureId: number) =>
  getFocusedTab(useFeatureLayoutStore.getState().features[featureId] ?? flatLayoutState());

describe("pane chords relayed from a browser guest page", () => {
  beforeEach(() => {
    relayListeners.length = 0;
    useFeatureLayoutStore.setState({
      features: { 1: flatLayoutState("agent"), 2: flatLayoutState("agent") },
    });
  });

  afterEach(() => useFeatureLayoutStore.setState({ features: {} }));

  it("change the layout of the conversation on screen, not of a hidden one", () => {
    renderHook(() => useFeatureLayoutHotkeys(1), inWorkspace(createWorkspaceActivity(true)));
    renderHook(() => useFeatureLayoutHotkeys(2), inWorkspace(createWorkspaceActivity(false)));

    relay("pane-git");

    expect(focusedTabOf(1)).toBe("git");
    expect(focusedTabOf(2)).toBe("agent");
  });
});
