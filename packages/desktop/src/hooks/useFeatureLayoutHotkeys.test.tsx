import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFeatureLayoutHotkeys } from "./useFeatureLayoutHotkeys";

const mockUseScopedShortcut = vi.hoisted(() => vi.fn());

const mockReleaseFocus = vi.hoisted(() => vi.fn());
const mockActivateTab = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/hooks/useShortcut", () => ({
  useShortcut: mockUseScopedShortcut,
}));
vi.mock("@/hooks/useBrowserShortcutRelay", () => ({ useBrowserShortcutRelay: vi.fn() }));
vi.mock("@/stores/feature-layout-store", () => ({ activateFeatureTab: mockActivateTab }));
vi.mock("@/lib/auto-layout/auto-layout-controller", () => ({ noteUserLayoutChange: vi.fn() }));
vi.mock("@/components/feature-layout/tab-focus-preservation", () => ({
  releaseFocusOutsideTab: mockReleaseFocus,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function pressPane(id: string): void {
  const call = mockUseScopedShortcut.mock.calls.find(([shortcut]) => shortcut === id);
  call?.[1]({ preventDefault: vi.fn() });
}

describe("useFeatureLayoutHotkeys", () => {
  it("registers the browser pane shortcut by id", () => {
    renderHook(() => useFeatureLayoutHotkeys(7, { enabled: true }));

    expect(mockUseScopedShortcut).toHaveBeenCalledWith(
      "pane-browser",
      expect.any(Function),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("releases focus stranded in another pane on the frame after activation", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    renderHook(() => useFeatureLayoutHotkeys(7, { enabled: true }));

    pressPane("pane-git");
    expect(mockActivateTab).toHaveBeenCalledWith(7, "git");
    expect(mockReleaseFocus).not.toHaveBeenCalled();

    for (const frame of frames) frame(0);
    expect(mockReleaseFocus).toHaveBeenCalledWith("git");
  });

  it("does not touch focus when the tab could not be activated", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    mockActivateTab.mockReturnValueOnce(false);
    renderHook(() => useFeatureLayoutHotkeys(7, { enabled: true }));

    pressPane("pane-git");
    expect(frames).toHaveLength(0);
  });
});
