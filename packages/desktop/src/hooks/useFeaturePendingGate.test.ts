// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { queryClient } from "@/lib/queryClient";
import { toast } from "sonner";
import type { FeatureRespondGateResponse } from "@/api/generated";
import { AxiosError, AxiosHeaders } from "axios";

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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import { useFeaturePendingGate } from "@/hooks/useFeaturePendingGate";

/** The service's answer while no gate is open. */
function notFound(): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", config, null, {
    data: { error: "feature 10 has no pending gate", code: "NOT_FOUND" },
    status: 404,
    statusText: "",
    headers: {},
    config,
  });
}

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
    vi.restoreAllMocks();
    vi.clearAllMocks();
    getPendingGate.mockReset();
    respondGate.mockReset();
    useSessionStatusStore.setState({ bySession: {} });
  });

  it.each([undefined, [], ["The permission was accepted, but saving its receipt failed."]])(
    "keeps the accepted response successful and displays returned warnings %j",
    async (warnings) => {
      getPendingGate.mockResolvedValue({
        session_id: 1,
        request_id: "req-1",
        kind: "permission",
        payload: {},
      });
      const response = {
        request_id: "req-1",
        resolved: true,
        ...(warnings === undefined ? {} : { warnings }),
      } satisfies FeatureRespondGateResponse;
      respondGate.mockResolvedValue(response);
      const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
      const statuses = useSessionStatusStore.getState().bySession;
      const { result } = renderHook(() => useFeaturePendingGate({ featureId: 10, enabled: true }), {
        wrapper: wrapper(),
      });
      await waitFor(() => expect(result.current.gate?.request_id).toBe("req-1"));

      result.current.respond({ type: "permission", action: "allow_once" });

      await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
      await waitFor(() => expect(result.current.isSubmitting).toBe(false));
      expect(respondGate).toHaveBeenCalledExactlyOnceWith(10, {
        request_id: "req-1",
        decision: { type: "permission", action: "allow_once" },
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["/api/features", 10, "pending-gate"],
      });
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.warning).toHaveBeenCalledTimes(warnings?.length ?? 0);
      if (warnings?.length) {
        expect(toast.warning).toHaveBeenCalledWith(warnings[0], {
          id: "pending-gate-warning:10:req-1:0",
        });
      }
      expect(result.current.isError).toBe(false);
      expect(useSessionStatusStore.getState().bySession).toBe(statuses);
    },
  );

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

  it("reads no open gate as an empty answer, then asks again on the next mount", async () => {
    // A restart cleared the gate the row shows; the resumed turn raises it again.
    getPendingGate.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({
      session_id: 1,
      request_id: "req-1",
      kind: "permission",
      payload: {},
    });
    useSessionStatusStore.setState({
      bySession: {
        1: { status: "question", kind: "permission", featureId: 10, seq: 1, requestId: "req-1" },
      },
    });
    const Wrapper = wrapper();

    const first = renderHook(() => useFeaturePendingGate({ featureId: 10, enabled: true }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(first.result.current.gate).toBeUndefined();
    expect(first.result.current.isError).toBe(false);
    expect(first.result.current.errorMessage).toBeNull();
    first.unmount();

    // An empty answer is not kept for the request id the way a gate is.
    const second = renderHook(() => useFeaturePendingGate({ featureId: 10, enabled: true }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(second.result.current.gate?.request_id).toBe("req-1"));
    expect(getPendingGate).toHaveBeenCalledTimes(2);
  });

  it("still reports a failure that is not the service's no-gate answer", async () => {
    getPendingGate.mockRejectedValueOnce(new AxiosError("Network Error", "ERR_NETWORK"));
    useSessionStatusStore.setState({
      bySession: {
        1: { status: "question", kind: "permission", featureId: 10, seq: 1, requestId: "req-1" },
      },
    });
    const { result } = renderHook(() => useFeaturePendingGate({ featureId: 10, enabled: true }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.errorMessage).toBeTruthy();
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
