// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const mockWsSessionStore = vi.fn();

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: (selector: (s: unknown) => unknown) => mockWsSessionStore(selector),
}));

import { useFeatureTitle } from "./useFeatureTitle";

interface StoreOpts {
  sessionTitle?: string | null;
  sessionAutoNaming?: boolean;
}

function setupStores(opts: StoreOpts) {
  mockWsSessionStore.mockImplementation(
    (
      selector: (s: {
        sessions: Record<string, { featureTitle?: string | null; isAutoNaming?: boolean }>;
      }) => unknown,
    ) =>
      selector({
        sessions:
          opts.sessionTitle || opts.sessionAutoNaming
            ? {
                "ws-feature-42": {
                  featureTitle: opts.sessionTitle ?? null,
                  isAutoNaming: opts.sessionAutoNaming ?? false,
                },
              }
            : {},
      }),
  );
}

describe("useFeatureTitle", () => {
  beforeEach(() => {
    mockWsSessionStore.mockReset();
  });

  it("returns null title and not auto-naming when stores are empty", () => {
    setupStores({});
    expect(renderHook(() => useFeatureTitle(42)).result.current).toEqual({
      title: null,
      isAutoNaming: false,
    });
  });

  it("returns session store title when set", () => {
    setupStores({ sessionTitle: "Session Title" });
    expect(renderHook(() => useFeatureTitle(42)).result.current.title).toBe("Session Title");
  });

  it("returns null title when session entry is empty", () => {
    setupStores({ sessionTitle: null });
    expect(renderHook(() => useFeatureTitle(42)).result.current.title).toBeNull();
  });

  it("reflects session-store auto-naming flag", () => {
    setupStores({ sessionAutoNaming: true });
    expect(renderHook(() => useFeatureTitle(42)).result.current.isAutoNaming).toBe(true);
  });
});
