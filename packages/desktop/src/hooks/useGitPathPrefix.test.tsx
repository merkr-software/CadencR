import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGetGitPathPrefixQueryKey, type GitPathPrefixResponse } from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import { useGitPathPrefix } from "./useGitPathPrefix";

const mocks = vi.hoisted(() => ({
  active: new Set<string>(),
  request: vi.fn<(featureId: number, signal: AbortSignal) => Promise<GitPathPrefixResponse>>(),
  error: vi.fn<
    (
      title: string,
      options: {
        id: string;
        action: { label: string; onClick: (event: { preventDefault: () => void }) => void };
      },
    ) => void
  >(),
  dismiss: vi.fn<(id: string) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.error,
    dismiss: mocks.dismiss,
    getToasts: () => Array.from(mocks.active, (id) => ({ id })),
  },
}));
vi.mock("@/api/client", () => ({
  customInstance: ({ params, signal }: { params: { feature_id: number }; signal: AbortSignal }) =>
    mocks.request(params.feature_id, signal),
}));

function renderPrefix(featureId: number) {
  const client = createTestQueryClient();
  const hook = renderHook(({ id }) => useGitPathPrefix(id), {
    initialProps: { id: featureId },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}

function retryAction(featureId: number) {
  const options = mocks.error.mock.calls
    .map(([, options]) => options)
    .find((options) => options.id === `git-path-prefix-${featureId}`);
  expect(options).toBeDefined();
  return options!.action;
}

const unavailable = new Error("The feature's worktree is no longer available");
const restored = { root: "/checkout", prefix: "packages/app" };

beforeEach(() => {
  mocks.active.clear();
  mocks.request.mockReset();
  mocks.error.mockClear().mockImplementation((_title, { id }) => {
    mocks.active.add(id);
  });
  mocks.dismiss.mockClear().mockImplementation((id) => {
    mocks.active.delete(id);
  });
});

describe("useGitPathPrefix error recovery", () => {
  it("keeps each error until its own feature recovers, including a retry after navigation", async () => {
    const recovery = Promise.withResolvers<GitPathPrefixResponse>();
    mocks.request
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(new Error("Another checkout is unavailable"))
      .mockReturnValueOnce(recovery.promise);
    const { rerender } = renderPrefix(4);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Could not resolve the project's Git paths",
        expect.objectContaining({ id: "git-path-prefix-4", duration: Infinity }),
      ),
    );
    const retry = retryAction(4);

    rerender({ id: 9 });
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Could not resolve the project's Git paths",
        expect.objectContaining({ id: "git-path-prefix-9" }),
      ),
    );
    const event = { preventDefault: vi.fn() };
    act(() => retry.onClick(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenLastCalledWith(4, expect.any(AbortSignal));
    expect(mocks.dismiss).not.toHaveBeenCalled();

    await act(async () => recovery.resolve(restored));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith("git-path-prefix-4"));
    expect([...mocks.active]).toEqual(["git-path-prefix-9"]);
  });

  it("keeps the error during replacement and ignores a late failure from the old query", async () => {
    const obsolete = Promise.withResolvers<GitPathPrefixResponse>();
    const recovery = Promise.withResolvers<GitPathPrefixResponse>();
    mocks.request
      .mockRejectedValueOnce(unavailable)
      .mockReturnValueOnce(obsolete.promise)
      .mockReturnValueOnce(recovery.promise);
    const { client, result } = renderPrefix(4);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());

    act(() => retryAction(4).onClick({ preventDefault: vi.fn() }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    const obsoleteSignal = mocks.request.mock.calls[1][1];
    act(() => {
      client.removeQueries({
        queryKey: getGetGitPathPrefixQueryKey({ feature_id: 4 }),
        exact: true,
      });
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
    expect(obsoleteSignal.aborted).toBe(true);
    expect(mocks.dismiss).not.toHaveBeenCalled();

    await act(async () => recovery.resolve(restored));
    await waitFor(() => expect(result.current).toBe("packages/app"));
    expect(mocks.dismiss).toHaveBeenCalledWith("git-path-prefix-4");

    await act(async () => obsolete.reject(new Error("Obsolete checkout response")));
    expect(result.current).toBe("packages/app");
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("releases the old prefix when the active checkout query is removed", async () => {
    const replacement = Promise.withResolvers<GitPathPrefixResponse>();
    mocks.request
      .mockResolvedValueOnce({ root: "/project", prefix: "" })
      .mockReturnValueOnce(replacement.promise);
    const { client, result } = renderPrefix(4);
    await waitFor(() => expect(result.current).toBe(""));

    act(() => {
      client.removeQueries({
        queryKey: getGetGitPathPrefixQueryKey({ feature_id: 4 }),
        exact: true,
      });
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();

    await act(async () => replacement.resolve(restored));
    await waitFor(() => expect(result.current).toBe("packages/app"));
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
