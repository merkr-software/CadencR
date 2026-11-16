import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => {
  const mutateAsync = vi.fn();
  const useDeletePendingDiffComments = vi.fn(() => ({ mutateAsync }));
  const toastError = vi.fn();
  return { mutateAsync, useDeletePendingDiffComments, toastError };
});

vi.mock("@/api/generated", () => ({
  useDeletePendingDiffComments: mocks.useDeletePendingDiffComments,
  // The hook now invalidates via the orval-generated query-key helper. Mocking
  // it here closes the gap that previously let the hook's catch-block swallow
  // a "function is not defined" error and silently mask the success path.
  getListDiffCommentsQueryKey: (featureId?: number) =>
    [`/api/features/${featureId ?? ""}/diff-comments`] as const,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

import { useSendPendingComments, type PendingDiffComment } from "./useSendPendingComments";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const asIs = (path: string): string => path;

const sampleComments: PendingDiffComment[] = [
  { file_path: "src/a.ts", line_number: 1, content: "fix this" },
  { file_path: "src/a.ts", line_number: 4, content: "and this" },
];

describe("useSendPendingComments", () => {
  beforeEach(() => {
    mocks.mutateAsync.mockReset();
    mocks.toastError.mockReset();
  });

  it("disables + hides when there are no comments", () => {
    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 1,
          pendingComments: [],
          toAgentPath: asIs,
          onSend: vi.fn(),
        }),
      { wrapper: makeWrapper() },
    );
    expect(result.current.disabled).toBe(true);
    expect(result.current.shouldRender).toBe(false);
    expect(result.current.buttonLabel).toBe("Send 0 comments");
  });

  it("uses the provided verb in the button label", () => {
    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 1,
          pendingComments: sampleComments,
          toAgentPath: asIs,
          onSend: vi.fn(),
          verb: "Fix",
        }),
      { wrapper: makeWrapper() },
    );
    expect(result.current.buttonLabel).toBe("Fix 2 comments");
    expect(result.current.shouldRender).toBe(true);
    expect(result.current.disabled).toBe(false);
  });

  it("is inert when onSend is omitted", async () => {
    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 1,
          pendingComments: sampleComments,
          toAgentPath: asIs,
        }),
      { wrapper: makeWrapper() },
    );
    expect(result.current.disabled).toBe(true);
    expect(result.current.shouldRender).toBe(false);
    await act(async () => {
      await result.current.send();
    });
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("awaits deletePending before invoking onSend + onAfterSend", async () => {
    const events: string[] = [];
    let resolveDelete!: () => void;
    mocks.mutateAsync.mockImplementation(
      () =>
        new Promise<{ deleted: number }>((resolve) => {
          events.push("delete:start");
          resolveDelete = () => {
            events.push("delete:resolve");
            resolve({ deleted: 2 });
          };
        }),
    );
    const onSend = vi.fn(() => events.push("send"));
    const onAfterSend = vi.fn(() => events.push("afterSend"));

    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 7,
          pendingComments: sampleComments,
          toAgentPath: asIs,
          onSend,
          onAfterSend,
        }),
      { wrapper: makeWrapper() },
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send();
    });
    await waitFor(() => expect(events).toContain("delete:start"));
    expect(onSend).not.toHaveBeenCalled();
    resolveDelete();
    await act(async () => {
      await sendPromise;
    });

    expect(events).toEqual(["delete:start", "delete:resolve", "send", "afterSend"]);
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining("src/a.ts"));
    expect(result.current.sending).toBe(false);
    // Regression guard: the success path must not surface an error toast.
    // Previously a missing `getListDiffCommentsQueryKey` mock made the hook
    // throw inside its `try`, hit the catch-block, and call `toast.error` —
    // but the assertions above all still passed.
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("surfaces errors via toast and clears sending state", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.mutateAsync.mockRejectedValue(new Error("boom"));
    const onSend = vi.fn();
    const onAfterSend = vi.fn();
    try {
      const { result } = renderHook(
        () =>
          useSendPendingComments({
            featureId: 1,
            pendingComments: sampleComments,
            toAgentPath: asIs,
            onSend,
            onAfterSend,
          }),
        { wrapper: makeWrapper() },
      );
      await act(async () => {
        await result.current.send();
      });
      expect(onSend).not.toHaveBeenCalled();
      expect(onAfterSend).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith("Failed to send comments");
      expect(result.current.sending).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to send pending comments",
        expect.any(Error),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("does nothing when already sending", async () => {
    let resolveDelete!: () => void;
    mocks.mutateAsync.mockImplementation(
      () =>
        new Promise<{ deleted: number }>((resolve) => {
          resolveDelete = () => resolve({ deleted: 2 });
        }),
    );
    const onSend = vi.fn();
    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 1,
          pendingComments: sampleComments,
          toAgentPath: asIs,
          onSend,
        }),
      { wrapper: makeWrapper() },
    );

    let first!: Promise<void>;
    act(() => {
      first = result.current.send();
    });
    await waitFor(() => expect(result.current.sending).toBe(true));
    await act(async () => {
      await result.current.send(); // no-op while sending
    });
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    resolveDelete();
    await act(async () => {
      await first;
    });
  });

  it("waits for the agent path mapping before sending", async () => {
    const onSend = vi.fn();
    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 1,
          pendingComments: sampleComments,
          toAgentPath: undefined,
          onSend,
        }),
      { wrapper: makeWrapper() },
    );
    expect(result.current.disabled).toBe(true);
    await act(async () => {
      await result.current.send();
    });
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("names the files the way the agent resolves them", async () => {
    mocks.mutateAsync.mockResolvedValue({ deleted: 1 });
    const onSend = vi.fn();
    const { result } = renderHook(
      () =>
        useSendPendingComments({
          featureId: 1,
          pendingComments: [
            { file_path: "packages/app/src/a.ts", line_number: 3, content: "rename" },
          ],
          toAgentPath: (path) => path.replace("packages/app/", ""),
          onSend,
        }),
      { wrapper: makeWrapper() },
    );
    await act(async () => {
      await result.current.send();
    });
    expect(onSend).toHaveBeenCalledWith("## src/a.ts\n- Line 3: rename");
  });
});
