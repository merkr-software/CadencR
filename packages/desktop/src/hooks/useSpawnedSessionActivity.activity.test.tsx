import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, createTestQueryClient, renderHook } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useSpawnedSessionActivity } from "./useSpawnedSessionActivity";

const digest = vi.hoisted(() => vi.fn());

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  getAgentActivityDigest: digest,
}));

function renderCard(activity: WorkspaceActivityController) {
  const client = createTestQueryClient();
  return renderHook(() => useSpawnedSessionActivity(4, "agent"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
      </QueryClientProvider>
    ),
  });
}

/** Lets the poll's timers and the query's promises run, `ms` at a time. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("a spawned agent's card in a workspace kept mounted but hidden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    digest.mockReset();
    digest.mockResolvedValue({ entries: [] });
  });

  afterEach(() => vi.useRealTimers());

  it("polls while its conversation is on screen", async () => {
    renderCard(createWorkspaceActivity(true));
    await wait(100);
    const first = digest.mock.calls.length;

    await wait(6_000);

    expect(digest.mock.calls.length).toBeGreaterThan(first);
  });

  it("stops polling while hidden and polls again once shown", async () => {
    const activity = createWorkspaceActivity(true);
    renderCard(activity);
    await wait(100);

    act(() => activity.set(false));
    await wait(100);
    const whileHidden = digest.mock.calls.length;
    await wait(10_000);
    expect(digest.mock.calls.length).toBe(whileHidden);

    act(() => activity.set(true));
    await wait(6_000);
    expect(digest.mock.calls.length).toBeGreaterThan(whileHidden);
  });
});
