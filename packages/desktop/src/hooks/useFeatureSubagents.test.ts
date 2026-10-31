import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getListFeatureSubagentsQueryKey, type SubagentRun } from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import {
  applySubagentRunPush,
  invalidateFeatureSubagents,
  refreshFeatureSubagentsAfterTurn,
} from "./useFeatureSubagents";

function run(status: SubagentRun["status"]): SubagentRun {
  return {
    sessionId: 1,
    toolUseId: "toolu_1",
    status,
    modelResolved: false,
    background: false,
    startedAt: "2026-10-30T10:00:00.000Z",
  };
}

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("sub-agent list pushes", () => {
  it("does not let a fetch that read the registry before a push land over it", async () => {
    const key = getListFeatureSubagentsQueryKey(7);
    let release: (runs: SubagentRun[]) => void = () => {};
    const answers = [
      new Promise<SubagentRun[]>((resolve) => {
        release = resolve;
      }),
      Promise.resolve([run("completed")]),
    ];
    const queryFn = vi.fn(() => answers.shift() ?? Promise.resolve([run("completed")]));
    queryClient.setQueryData(key, [run("running")]);
    // Something shows the list, and its refetch is in flight.
    const observer = new QueryObserver(queryClient, { queryKey: key, queryFn, staleTime: 0 });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    applySubagentRunPush(7, run("completed"));
    release([run("running")]);

    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: key })).toBe(0));
    expect(queryClient.getQueryData<SubagentRun[]>(key)?.[0].status).toBe("completed");
    // The push did not restart the fetch: a stream of them cannot starve it.
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("lays the runs pushed during a first fetch over its answer", async () => {
    const key = getListFeatureSubagentsQueryKey(6);
    let release: (runs: SubagentRun[]) => void = () => {};
    const queryFn = vi.fn(
      () =>
        new Promise<SubagentRun[]>((resolve) => {
          release = resolve;
        }),
    );
    const observer = new QueryObserver(queryClient, { queryKey: key, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    applySubagentRunPush(6, run("running"));
    applySubagentRunPush(6, run("completed"));
    release([]);

    await vi.waitFor(() =>
      expect(queryClient.getQueryData<SubagentRun[]>(key)?.[0]?.status).toBe("completed"),
    );
    expect(queryClient.getQueryData<SubagentRun[]>(key)).toHaveLength(1);
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("forgets the runs held for a fetch that was cancelled", async () => {
    const key = getListFeatureSubagentsQueryKey(5);
    const queryFn = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<SubagentRun[]>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const observer = new QueryObserver(queryClient, { queryKey: key, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    applySubagentRunPush(5, run("running"));
    // The card unmounts mid-fetch: the fetch is cancelled and reverted.
    unsubscribe();
    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: key })).toBe(0));

    await queryClient.fetchQuery({ queryKey: key, queryFn: () => [run("completed")] });

    expect(queryClient.getQueryData<SubagentRun[]>(key)?.[0].status).toBe("completed");
  });

  it("refetches at a turn's end only when a sub-agent changed since the last refetch", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    refreshFeatureSubagentsAfterTurn(8);
    expect(invalidate).not.toHaveBeenCalled();

    applySubagentRunPush(8, run("running"));
    refreshFeatureSubagentsAfterTurn(8);
    expect(invalidate).toHaveBeenCalledTimes(1);
    refreshFeatureSubagentsAfterTurn(8);
    expect(invalidate).toHaveBeenCalledTimes(1);

    invalidateFeatureSubagents(8);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid payload", () => {
    expect(applySubagentRunPush(9, { toolUseId: "x" })).toBe(false);
  });
});
