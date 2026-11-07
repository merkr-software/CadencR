import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";

const mocks = vi.hoisted(() => ({
  killTerminals: vi.fn(async () => undefined),
  invalidateQueries: vi.fn(async () => undefined),
  closePanel: vi.fn(),
  promiseToast: vi.fn(),
}));
vi.mock("@/api/generated", () => ({
  useKillTerminalSessions: () => ({ mutateAsync: mocks.killTerminals }),
  getListFeatureActivityQueryKey: () => ["activity"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("@/hooks/useTerminalState", () => ({
  useTerminalStore: { getState: () => ({ closePanel: mocks.closePanel }) },
}));
vi.mock("sonner", () => ({ toast: { promise: mocks.promiseToast } }));

const { useCloseFeatureActivity } = await import("./useCloseFeatureActivity");
const counts = { projectId: 1, featureId: 2, shellCount: 0, browserCount: 2, downloadCount: 1 };

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
  vi.clearAllMocks();
});

describe("useCloseFeatureActivity", () => {
  it("ignores native-only counts remotely without claiming to close anything", () => {
    const closeBrowserTabsForScope = vi.fn();
    setDesktopBridgeOverrideForTests({ isElectron: false, closeBrowserTabsForScope });
    const { result } = renderHook(() => useCloseFeatureActivity());
    act(() => result.current(counts));
    expect(closeBrowserTabsForScope).not.toHaveBeenCalled();
    expect(mocks.killTerminals).not.toHaveBeenCalled();
    expect(mocks.promiseToast).not.toHaveBeenCalled();
  });

  it("still closes remote shells without touching the native browser", async () => {
    const closeBrowserTabsForScope = vi.fn();
    setDesktopBridgeOverrideForTests({ isElectron: false, closeBrowserTabsForScope });
    const { result } = renderHook(() => useCloseFeatureActivity());
    await act(async () => result.current({ ...counts, shellCount: 1 }));
    expect(mocks.killTerminals).toHaveBeenCalledWith({ params: { feature_id: 2 } });
    expect(mocks.closePanel).toHaveBeenCalledWith(2);
    expect(closeBrowserTabsForScope).not.toHaveBeenCalled();
    expect(mocks.promiseToast).toHaveBeenCalledWith(
      expect.any(Promise),
      expect.objectContaining({
        loading: "Closing terminal…",
      }),
    );
  });

  it("still closes browser activity in the desktop shell", async () => {
    const closeBrowserTabsForScope = vi.fn(async () => ({
      scopeId: 2,
      tabs: [],
      activeTabId: null,
      error: null,
    }));
    setDesktopBridgeOverrideForTests({ isElectron: true, closeBrowserTabsForScope });
    const { result } = renderHook(() => useCloseFeatureActivity());
    await act(async () => result.current(counts));
    expect(closeBrowserTabsForScope).toHaveBeenCalledWith(2);
    expect(mocks.promiseToast).toHaveBeenCalled();
  });
});
