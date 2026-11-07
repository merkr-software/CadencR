import { afterEach, describe, expect, it } from "vitest";
import { queryClient } from "@/lib/queryClient";
import { resetPushResyncForTests, resyncPushMaintainedQueries } from "./app-socket-resync";

function seed(key: readonly unknown[]): void {
  queryClient.setQueryData(key, { cached: true });
}

function invalidated(key: readonly unknown[]): boolean {
  return queryClient.getQueryState(key)?.isInvalidated ?? false;
}

describe("resyncPushMaintainedQueries", () => {
  afterEach(() => {
    resetPushResyncForTests();
    queryClient.clear();
  });

  it("invalidates every push-maintained family but leaves transcripts to their own resync", async () => {
    const pushed = [
      ["/api/features", { project_id: 1 }],
      ["/api/features/pinned"],
      ["/api/features/9/pending-gate"],
      ["/api/features/9/status"],
      ["/api/projects"],
      ["/api/projects/1/settings"],
      ["/api/workspace/settings/sidebar.lens"],
      ["/api/schedules"],
      ["/api/custom-actions"],
      ["/api/themes"],
    ] as const;
    for (const key of pushed) seed(key);
    seed(["/api/features/9/agent-state", { limit: 50 }]);
    seed(["/api/health"]);

    resyncPushMaintainedQueries();
    await Promise.resolve();

    for (const key of pushed) expect(invalidated(key), JSON.stringify(key)).toBe(true);
    expect(invalidated(["/api/features/9/agent-state", { limit: 50 }])).toBe(false);
    expect(invalidated(["/api/health"])).toBe(false);
  });
});
