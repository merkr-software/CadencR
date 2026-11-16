import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGetFeatureSettingsQueryKey, type Feature } from "@/api/generated";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { useViewedPrStore } from "@/stores/viewed-pr-store";
import { useOpenFeaturePr } from "./useOpenFeaturePr";

const mocks = vi.hoisted(() => ({ setFeatureSetting: vi.fn() }));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  setFeatureSetting: mocks.setFeatureSetting,
}));

const FEATURE = { id: 7, project_id: 3 } as Feature;

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function activeTab(): string | null | undefined {
  const root = useFeatureLayoutStore.getState().features[FEATURE.id]?.splitRoot;
  return root?.type === "leaf" ? root.activeTabId : undefined;
}

describe("useOpenFeaturePr", () => {
  beforeEach(() => {
    mocks.setFeatureSetting.mockReset().mockResolvedValue({});
    useFeatureLayoutStore.setState({ features: {} });
    useViewedPrStore.setState({ byFeature: {} });
  });

  it("opens the conversation on its Git tab's PR view, showing that proposal", async () => {
    const onNavigate = vi.fn();
    const { result } = renderHook(() => useOpenFeaturePr(FEATURE, onNavigate), { wrapper });

    act(() => result.current(21));

    expect(onNavigate).toHaveBeenCalledWith(FEATURE, { focusTab: "git" });
    expect(useViewedPrStore.getState().byFeature[FEATURE.id]).toBe(21);
    await waitFor(() =>
      expect(mocks.setFeatureSetting).toHaveBeenCalledWith(FEATURE.id, {
        key: "git_view_mode",
        value: "pr",
      }),
    );
  });

  it("leaves the view setting alone when it already shows pull requests", () => {
    const client = new QueryClient();
    client.setQueryData(getGetFeatureSettingsQueryKey(FEATURE.id), [
      { key: "git_view_mode", value: "pr" },
    ]);
    const { result } = renderHook(() => useOpenFeaturePr(FEATURE, vi.fn()), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    act(() => result.current(21));

    expect(useViewedPrStore.getState().byFeature[FEATURE.id]).toBe(21);
    expect(mocks.setFeatureSetting).not.toHaveBeenCalled();
  });

  it("switches an already-open conversation directly", () => {
    // Its URL may already ask for the Git tab, so navigating requests nothing new.
    useFeatureLayoutStore.getState().setState(FEATURE.id, flatLayoutState());
    const { result } = renderHook(() => useOpenFeaturePr(FEATURE, vi.fn()), { wrapper });

    act(() => result.current(null));

    expect(activeTab()).toBe("git");
  });

  it("never seeds a layout for a conversation that hasn't hydrated one", () => {
    const { result } = renderHook(() => useOpenFeaturePr(FEATURE, vi.fn()), { wrapper });

    act(() => result.current(null));

    // Hydration would take a seeded layout for saved state and skip the real one.
    expect(useFeatureLayoutStore.getState().features[FEATURE.id]).toBeUndefined();
  });
});
