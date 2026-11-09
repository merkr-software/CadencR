import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { parseIdList, SIDEBAR_EXPANDED_PROJECTS_KEY, usePersistedIdSet } from "./usePersistedIdSet";

const mocks = vi.hoisted(() => ({ writes: [] as string[] }));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setWorkspaceSetting: (_key: string, data: { value: string }) => {
    mocks.writes.push(data.value);
    return Promise.resolve({ value: data.value });
  },
}));

describe("parseIdList", () => {
  it("reads a JSON array of integer ids", () => {
    expect(parseIdList("[3,1]")).toEqual({ ids: [3, 1], error: null });
    expect(parseIdList(null)).toEqual({ ids: [], error: null });
  });

  it("reports malformed values instead of hiding them", () => {
    expect(parseIdList("{oops").error).not.toBeNull();
    expect(parseIdList('["a"]').error).toBe("expected an array of ids");
  });
});

describe("usePersistedIdSet", () => {
  function wrapperWith(stored: string) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(getGetWorkspaceSettingQueryKey(SIDEBAR_EXPANDED_PROJECTS_KEY), {
      value: stored,
    });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  it("writes each toggle as a sorted JSON array and shows it once confirmed", async () => {
    mocks.writes = [];
    const { result } = renderHook(() => usePersistedIdSet(SIDEBAR_EXPANDED_PROJECTS_KEY), {
      wrapper: wrapperWith("[5,7]"),
    });
    expect([...result.current.ids]).toEqual([5, 7]);
    // Two toggles in one tick compose: each write starts from the one confirmed before it.
    act(() => {
      result.current.setMember(2, true);
      result.current.setMember(7, false);
    });
    expect([...result.current.ids]).toEqual([5, 7]);
    await waitFor(() => expect(mocks.writes).toEqual(["[2,5,7]", "[2,5]"]));
    await waitFor(() => expect([...result.current.ids]).toEqual([2, 5]));
  });

  it("refuses to write before the stored list has loaded", () => {
    mocks.writes = [];
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const { result } = renderHook(() => usePersistedIdSet(SIDEBAR_EXPANDED_PROJECTS_KEY), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() => result.current.setMember(3, true));
    expect(mocks.writes).toEqual([]);
  });
});
