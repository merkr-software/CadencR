import { beforeEach, describe, expect, it, vi } from "vitest";
import { getListSchedulesQueryKey, type Schedule } from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import {
  archiveUndoCaveats,
  canUndoArchive,
  enabledScheduleFeatureIds,
  undoArchive,
} from "./archive-undo";

const toast = vi.hoisted(() => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const api = vi.hoisted(() => ({ updateFeatureStatus: vi.fn() }));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  updateFeatureStatus: api.updateFeatureStatus,
}));

const lists = vi.hoisted(() => ({ invalidateFeatureLists: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/featureUpdated", () => lists);

const RESET = { description: undefined, action: undefined, cancel: undefined, duration: undefined };

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const undo = (archivedIds: number[], caveats?: string) => ({
  featureId: 4,
  archivedIds,
  projectId: 1,
  caveats,
});

describe("undoArchive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unarchives every archived conversation and refreshes only once the service confirms", async () => {
    const answer = deferred();
    api.updateFeatureStatus.mockReturnValue(answer.promise);
    const client = createTestQueryClient();
    const done = undoArchive(client, undo([4, 9]));

    expect(api.updateFeatureStatus).toHaveBeenCalledWith(4, { status: "active" });
    expect(api.updateFeatureStatus).toHaveBeenCalledWith(9, { status: "active" });
    expect(toast.loading).toHaveBeenCalledWith("Restoring session…", {
      ...RESET,
      id: "archive-undo-4",
    });
    // Nothing on screen changes before the answer: no list refresh, no success.
    await Promise.resolve();
    expect(lists.invalidateFeatureLists).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    answer.resolve();
    await done;
    expect(lists.invalidateFeatureLists).toHaveBeenCalledWith(client, 1);
    expect(toast.success).toHaveBeenCalledWith("2 sessions restored", {
      ...RESET,
      id: "archive-undo-4",
      description: undefined,
    });
  });

  it("says what Undo left as the archive made it", async () => {
    api.updateFeatureStatus.mockResolvedValue(undefined);
    await undoArchive(createTestQueryClient(), undo([4], "Its terminals stay closed."));
    expect(toast.success).toHaveBeenCalledWith("Session restored", {
      ...RESET,
      id: "archive-undo-4",
      description: "Its terminals stay closed.",
    });
  });

  it("names the error when the service refuses, and still refreshes", async () => {
    api.updateFeatureStatus.mockRejectedValue(new Error("status refused"));
    await undoArchive(createTestQueryClient(), undo([4]));
    expect(lists.invalidateFeatureLists).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Could not restore session", {
      ...RESET,
      id: "archive-undo-4",
      description: "status refused",
    });
  });

  it("reports a partial restore, refreshing the lists for what did change", async () => {
    api.updateFeatureStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce(undefined);
    await undoArchive(createTestQueryClient(), undo([4, 5, 6]));
    expect(api.updateFeatureStatus).toHaveBeenCalledTimes(3);
    expect(lists.invalidateFeatureLists).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("2 of 3 sessions restored", {
      ...RESET,
      id: "archive-undo-4",
      description: "gone",
    });
  });
});

describe("what Undo can promise", () => {
  const done = { status: "done" } as const;
  const skipped = { status: "skipped" } as const;

  it("is offered only when no worktree or branch was removed", () => {
    expect(canUndoArchive({})).toBe(true);
    expect(canUndoArchive({ terminals: done, browser_tabs: done })).toBe(true);
    expect(canUndoArchive({ worktree: skipped, branch: skipped })).toBe(true);
    expect(canUndoArchive({ worktree: done })).toBe(false);
    expect(canUndoArchive({ branch: done })).toBe(false);
    expect(canUndoArchive({ worktree: { status: "running" } })).toBe(false);
  });

  it("names closed terminals and tabs and the schedules the archive paused", () => {
    expect(archiveUndoCaveats({}, [4], [])).toBeUndefined();
    expect(archiveUndoCaveats({ terminals: done, browser_tabs: skipped }, [4], [])).toBe(
      "Its terminals stay closed.",
    );
    expect(archiveUndoCaveats({ terminals: done, browser_tabs: done }, [4, 5], [5, 5, 9])).toBe(
      "Its terminals and browser tabs stay closed. 2 schedules stay paused.",
    );
    expect(archiveUndoCaveats({}, [4], [4])).toBe("1 schedule stays paused.");
    expect(archiveUndoCaveats({}, [4], null)).toBe("Any schedule the archive paused stays paused.");
  });

  it("reads the enabled schedules bound to a conversation from the full cached list only", () => {
    const client = createTestQueryClient();
    expect(enabledScheduleFeatureIds(client)).toBeNull();
    const schedule = (id: number, enabled: boolean, featureId: number | null) =>
      ({ id, enabled, target: { kind: "conversation", feature_id: featureId } }) as Schedule;
    // A per-conversation list alone says nothing about the other conversations.
    client.setQueryData(getListSchedulesQueryKey({ feature_id: 4 }), [schedule(1, true, 4)]);
    expect(enabledScheduleFeatureIds(client)).toBeNull();
    client.setQueryData(getListSchedulesQueryKey({}), [
      schedule(1, true, 4),
      schedule(2, false, 4),
      schedule(3, true, null),
    ]);
    expect(enabledScheduleFeatureIds(client)).toEqual([4]);
  });
});
