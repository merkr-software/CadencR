import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useFeatureLayoutHydration } from "./useFeatureLayoutHydration";
import { useFeatureLayoutPersistence } from "./useFeatureLayoutPersistence";
import {
  LAYOUT_STATE_KEY,
  ROOT_LEAF_ID,
  parseLayoutState,
  serializeLayoutState,
  type FeatureLayoutState,
} from "@/stores/feature-layout-schema";
import { findPaneContaining, useFeatureLayoutStore } from "@/stores/feature-layout-store";

const FEATURE_ID = 7;
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  toastError: vi.fn(),
  layouts: [] as LayoutFixture[],
  settings: [] as SettingFixture[],
  layoutsLoading: false,
  settingsLoading: false,
}));

interface SettingFixture {
  key: string;
  value: string;
}

interface LayoutFixture {
  id: number;
  name: string;
  config: string;
  is_default: boolean;
}

vi.mock("@/api/generated", () => ({
  useListLayouts: (): { data: LayoutFixture[]; isLoading: boolean } => ({
    data: mocks.layouts,
    isLoading: mocks.layoutsLoading,
  }),
  useGetFeatureSettings: (): { data: SettingFixture[]; isLoading: boolean } => ({
    data: mocks.settings,
    isLoading: mocks.settingsLoading,
  }),
  useSetFeatureSetting: (): { mutate: typeof mocks.mutate } => ({ mutate: mocks.mutate }),
  getGetFeatureSettingsQueryKey: (id: number): readonly [string, number] => [
    "feature-settings",
    id,
  ],
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

function makeLayout(activeTabId: "agent" | "git" | "editor"): FeatureLayoutState {
  return {
    version: 1,
    splitRoot: {
      type: "leaf",
      id: ROOT_LEAF_ID,
      tabIds: ["agent", "terminal", "git", "editor"],
      activeTabId,
    },
    focusedPaneId: ROOT_LEAF_ID,
    appliedLayoutId: null,
  };
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("feature layout hydration and persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.mutate.mockReset();
    mocks.toastError.mockReset();
    mocks.layouts = [];
    mocks.settings = [];
    mocks.layoutsLoading = false;
    mocks.settingsLoading = false;
    useFeatureLayoutStore.setState({ features: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates from feature_settings.layout_state before the default layout", () => {
    const savedCurrent = makeLayout("editor");
    const defaultLayout = makeLayout("git");
    mocks.settings = [{ key: LAYOUT_STATE_KEY, value: serializeLayoutState(savedCurrent) }];
    mocks.layouts = [
      { id: 12, name: "Default", config: serializeLayoutState(defaultLayout), is_default: true },
    ];

    renderHook(() => useFeatureLayoutHydration(FEATURE_ID));

    const state = useFeatureLayoutStore.getState().features[FEATURE_ID];
    expect(state?.splitRoot.type).toBe("leaf");
    if (state?.splitRoot.type === "leaf") {
      expect(state.splitRoot.activeTabId).toBe("editor");
    }
    expect(state?.appliedLayoutId).toBeNull();
  });

  it("falls back to the default layout when layout_state is absent", () => {
    const defaultLayout = makeLayout("git");
    mocks.layouts = [
      { id: 12, name: "Default", config: serializeLayoutState(defaultLayout), is_default: true },
    ];

    renderHook(() => useFeatureLayoutHydration(FEATURE_ID));

    const state = useFeatureLayoutStore.getState().features[FEATURE_ID];
    expect(state?.appliedLayoutId).toBe(12);
    expect(state).toBeDefined();
    if (state) {
      expect(findPaneContaining(state.splitRoot, "git")?.activeTabId).toBe("git");
    }
  });

  it("skips malformed layout_state and surfaces the fallback", () => {
    const defaultLayout = makeLayout("git");
    mocks.settings = [{ key: LAYOUT_STATE_KEY, value: "not-json" }];
    mocks.layouts = [
      { id: 12, name: "Default", config: serializeLayoutState(defaultLayout), is_default: true },
    ];

    renderHook(() => useFeatureLayoutHydration(FEATURE_ID));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Saved feature layout is malformed and was skipped.",
    );
    expect(useFeatureLayoutStore.getState().features[FEATURE_ID]?.appliedLayoutId).toBe(12);
  });

  it("persists layout_state after a user layout mutation, not on initial hydration", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useFeatureLayoutStore.getState().setState(FEATURE_ID, makeLayout("agent"));

    renderHook(() => useFeatureLayoutPersistence(FEATURE_ID), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mocks.mutate).not.toHaveBeenCalled();

    act(() => {
      useFeatureLayoutStore.getState().splitTabAt(FEATURE_ID, "git", ROOT_LEAF_ID, "right");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: FEATURE_ID,
        data: expect.objectContaining({ key: LAYOUT_STATE_KEY }),
      }),
      expect.any(Object),
    );
  });

  it("keeps the gesture's layout on a failed save, says so, and retries on demand", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useFeatureLayoutStore.getState().setState(FEATURE_ID, makeLayout("agent"));
    renderHook(() => useFeatureLayoutPersistence(FEATURE_ID), {
      wrapper: makeWrapper(queryClient),
    });
    act(() => {
      useFeatureLayoutStore.getState().splitTabAt(FEATURE_ID, "git", ROOT_LEAF_ID, "right");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const callbacks = mocks.mutate.mock.calls[0]?.[1] as { onError: (error: Error) => void };
    act(() => callbacks.onError(new Error("disk full")));
    expect(useFeatureLayoutStore.getState().features[FEATURE_ID]?.splitRoot.type).toBe("split");
    expect(mocks.toastError).toHaveBeenCalledWith("Could not save the layout: disk full", {
      id: `layout-save-${FEATURE_ID}`,
      description: "This arrangement is kept until the app restarts.",
      action: { label: "Retry", onClick: expect.any(Function) },
    });

    const toastOptions = mocks.toastError.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    act(() => toastOptions.action.onClick());
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.mutate.mock.calls[1]?.[0]).toEqual(mocks.mutate.mock.calls[0]?.[0]);
  });

  it("persists focused pane changes for the current feature layout", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const splitLayout: FeatureLayoutState = {
      version: 1,
      splitRoot: {
        type: "split",
        orientation: "horizontal",
        children: [
          {
            type: "leaf",
            id: ROOT_LEAF_ID,
            tabIds: ["agent", "git", "editor"],
            activeTabId: "agent",
          },
          {
            type: "leaf",
            id: "terminal-pane",
            tabIds: ["terminal"],
            activeTabId: "terminal",
          },
        ],
      },
      focusedPaneId: ROOT_LEAF_ID,
      appliedLayoutId: null,
    };
    useFeatureLayoutStore.getState().setState(FEATURE_ID, splitLayout);

    renderHook(() => useFeatureLayoutPersistence(FEATURE_ID), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      useFeatureLayoutStore.getState().setFocusedPane(FEATURE_ID, "terminal-pane");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const firstCall = mocks.mutate.mock.calls[0]?.[0];
    expect(firstCall?.data.key).toBe(LAYOUT_STATE_KEY);
    const parsed = parseLayoutState(firstCall?.data.value);
    expect(parsed?.focusedPaneId).toBe("terminal-pane");
  });
});
