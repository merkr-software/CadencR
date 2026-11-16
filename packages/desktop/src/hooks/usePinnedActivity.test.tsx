import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  getListFeatureActivityQueryKey,
  getListFeatureWorktreesQueryKey,
  type Feature,
} from "@/api/generated";
import { featureActivityParams } from "@/lib/sidebar-queries";
import { usePinnedActivity } from "./usePinnedActivity";

function pinned(id: number, projectId: number): Feature {
  return { id, project_id: projectId } as unknown as Feature;
}

describe("usePinnedActivity", () => {
  it("merges shell counts and live worktrees from each pinned project", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    for (const projectId of [1, 2]) {
      client.setQueryData(getListFeatureActivityQueryKey(featureActivityParams(projectId)), [
        { feature_id: projectId * 10, shell_count: projectId },
      ]);
      client.setQueryData(getListFeatureWorktreesQueryKey({ project_id: projectId }), [
        { feature_id: projectId * 10, live: projectId === 2 },
      ]);
    }
    const { result } = renderHook(() => usePinnedActivity([pinned(10, 1), pinned(20, 2)]), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    expect([...result.current.shellCountByFeatureId]).toEqual([
      [10, 1],
      [20, 2],
    ]);
    expect([...result.current.liveWorktreeFeatureIds]).toEqual([20]);
  });
});
