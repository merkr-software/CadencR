// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { StashEntry } from "@/api/generated";
import { useStashMutations } from "./useStashMutations";
import {
  resetStashMutationCoordinatorForTest,
  useStashMutationCoordinator,
} from "./useStashMutationCoordinator";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  pop: vi.fn(),
  drop: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/api/generated", () => ({
  useApplyStash: () => ({ mutateAsync: mocks.apply }),
  usePopStash: () => ({ mutateAsync: mocks.pop }),
  useDropStash: () => ({ mutateAsync: mocks.drop }),
}));

const stash: StashEntry = {
  ref_name: "stash@{2}",
  sha: "a".repeat(40),
  message: "WIP parser",
  date: "2026-01-01 12:00:00 +0000",
  files_changed: 2,
  additions: 4,
  deletions: 1,
};

describe("useStashMutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStashMutationCoordinatorForTest();
    mocks.apply.mockResolvedValue({ outcome: "completed" });
    mocks.pop.mockResolvedValue({ outcome: "completed" });
    mocks.drop.mockResolvedValue({ outcome: "completed" });
  });

  it.each([
    ["apply", mocks.apply],
    ["pop", mocks.pop],
    ["drop", mocks.drop],
  ] as const)(
    "sends a stable selector for %s and explicitly refreshes",
    async (operation, mutate) => {
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => {
        const coordinator = useStashMutationCoordinator(17);
        return useStashMutations({ featureId: 17, stash, onRefresh, coordinator });
      });

      await act(() => result.current[operation]());

      expect(mutate).toHaveBeenCalledWith({
        data: {
          feature_id: 17,
          ref_name: "stash@{2}",
          expected_sha: "a".repeat(40),
        },
      });
      expect(onRefresh).toHaveBeenCalledOnce();
    },
  );

  it("reports conflicted pop retention, conflict files, routing, and Editor handoff", async () => {
    mocks.pop.mockResolvedValue({
      outcome: "conflicts",
      conflict_files: ["src/a.ts", "src/b.ts"],
    });
    const onConflicts = vi.fn();
    const onOpenConflict = vi.fn();
    const { result } = renderHook(() => {
      const coordinator = useStashMutationCoordinator(17);
      return useStashMutations({ featureId: 17, stash, onConflicts, onOpenConflict, coordinator });
    });

    await act(() => result.current.pop());

    expect(onConflicts).toHaveBeenCalledWith({
      operation: "pop",
      stash,
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "Stash pop has conflicts",
      expect.objectContaining({
        description: expect.stringContaining("stash@{2} was kept because the pop conflicted"),
      }),
    );
    const options = mocks.toast.warning.mock.calls[0]?.[1] as {
      action?: { onClick: () => void };
    };
    options.action?.onClick();
    expect(onOpenConflict).toHaveBeenCalledWith("src/a.ts");
  });

  it("keeps pending state through the deterministic refresh", async () => {
    let finishRefresh: (() => void) | undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const { result } = renderHook(() => {
      const coordinator = useStashMutationCoordinator(17);
      return useStashMutations({ featureId: 17, stash, onRefresh, coordinator });
    });

    let operation: Promise<boolean> | undefined;
    act(() => {
      operation = result.current.pop();
    });
    expect(result.current.pendingOperation).toBe("pop");

    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());

    await act(async () => {
      finishRefresh?.();
      await operation;
    });
    expect(result.current.pendingOperation).toBeNull();
  });

  it("surfaces mutation and refresh errors", async () => {
    mocks.apply.mockRejectedValueOnce(new Error("stash moved"));
    const onRefresh = vi.fn().mockRejectedValue(new Error("refresh failed"));
    const { result } = renderHook(() => {
      const coordinator = useStashMutationCoordinator(17);
      return useStashMutations({ featureId: 17, stash, onRefresh, coordinator });
    });

    await act(() => result.current.apply());
    expect(toast.error).toHaveBeenCalledWith("stash moved");

    await act(() => result.current.pop());
    expect(toast.error).toHaveBeenCalledWith(
      "Popped stash, but could not refresh the list",
      expect.objectContaining({ description: "refresh failed" }),
    );
  });
});
