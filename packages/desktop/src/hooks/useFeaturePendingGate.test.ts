// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useSessionStatusStore } from "@/stores/session-status-store";

const getPendingGate = vi.hoisted(() => vi.fn());
const respondGate = vi.hoisted(() => vi.fn());

vi.mock("@/api/generated", async () => {
  const actual = await vi.importActual<typeof import("@/api/generated")>("@/api/generated");
  return {
    ...actual,
    getPendingGate,
    respondGate,
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { useFeaturePendingGate } from "@/hooks/useFeaturePendingGate";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("useFeaturePendingGate", () => {
  beforeEach(() => {
    getPendingGate.mockReset();
    respondGate.mockReset();
    useSessionStatusStore.setState({ bySession: {} });
  });

  it("refetches when the live pending request id changes", async () => {
    getPendingGate
      .mockResolvedValueOnce({
        session_id: 1,
        request_id: "req-1",
        kind: "permission",
        payload: {},
      })
      .mockResolvedValueOnce({
        session_id: 1,
        request_id: "req-2",
        kind: "permission",
        payload: {},
      });

    useSessionStatusStore.setState({
      bySession: {
        1: {
          status: "question",
          kind: "permission",
          featureId: 10,
          seq: 1,
          requestId: "req-1",
        },
      },
    });

    const { result, rerender } = renderHook(
      () => useFeaturePendingGate({ featureId: 10, enabled: true }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.gate?.request_id).toBe("req-1"));
    expect(getPendingGate).toHaveBeenCalledTimes(1);

    useSessionStatusStore.setState({
      bySession: {
        1: {
          status: "question",
          kind: "permission",
          featureId: 10,
          seq: 2,
          requestId: "req-2",
        },
      },
    });
    rerender();

    await waitFor(() => expect(result.current.gate?.request_id).toBe("req-2"));
    expect(getPendingGate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects respond when the fetched gate no longer matches the live request id", async () => {
    getPendingGate.mockResolvedValue({
      session_id: 1,
      request_id: "req-old",
      kind: "permission",
      payload: {},
    });
    useSessionStatusStore.setState({
      bySession: {
        1: {
          status: "question",
          kind: "permission",
          featureId: 10,
          seq: 1,
          requestId: "req-new",
        },
      },
    });

    const { result } = renderHook(() => useFeaturePendingGate({ featureId: 10, enabled: true }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Stale cached payload must not surface as the active gate.
    expect(result.current.gate).toBeUndefined();

    result.current.respond({ type: "permission", action: "allow_once" });
    await waitFor(() => expect(respondGate).not.toHaveBeenCalled());
  });

  it("does not fetch while disabled (popover closed)", () => {
    useSessionStatusStore.setState({
      bySession: {
        1: {
          status: "question",
          kind: "permission",
          featureId: 10,
          seq: 1,
          requestId: "req-1",
        },
      },
    });

    renderHook(() => useFeaturePendingGate({ featureId: 10, enabled: false }), {
      wrapper: wrapper(),
    });

    expect(getPendingGate).not.toHaveBeenCalled();
  });
});
