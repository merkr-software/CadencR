import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test-utils";
import { toast } from "sonner";
import type { ArchiveCleanupStatus } from "@/api/generated";
import { ArchiveCleanupNotices } from "./ArchiveCleanupNotices";
import { useArchiveCleanupReviewStore } from "@/stores/archive-cleanup-review-store";

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));

vi.mock("@/api/generated", () => ({ useListArchiveCleanups: mockList }));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));

function interrupted(featureId: number, running = false): ArchiveCleanupStatus {
  return {
    feature_id: featureId,
    project_id: 1,
    title: `Session ${featureId}`,
    running,
    settled: false,
    cleanup: { worktree: { status: running ? "running" : "interrupted" } },
  };
}

describe("ArchiveCleanupNotices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useArchiveCleanupReviewStore.getState().close();
  });

  it("keeps a notice per cleanup needing the user, until the service settles it", () => {
    mockList.mockReturnValue({ data: [interrupted(3), interrupted(4, true)], error: null });
    const { rerender } = render(<ArchiveCleanupNotices />);

    expect(toast.warning).toHaveBeenCalledOnce();
    const [title, options] = vi.mocked(toast.warning).mock.calls[0] ?? [];
    expect(title).toBe("Cleanup of “Session 3” is incomplete");
    expect(options).toMatchObject({
      id: "archive-cleanup-3",
      duration: Infinity,
      description: "Worktree: Interrupted",
    });
    const action = (options as unknown as { action: { onClick: () => void } }).action;
    action.onClick();
    expect(useArchiveCleanupReviewStore.getState().featureId).toBe(3);

    mockList.mockReturnValue({ data: [], error: null });
    rerender(<ArchiveCleanupNotices />);
    expect(toast.dismiss).toHaveBeenCalledWith("archive-cleanup-3");
  });

  it("surfaces a failure to load the cleanups", () => {
    mockList.mockReturnValue({ data: undefined, error: new Error("service down") });
    render(<ArchiveCleanupNotices />);

    expect(toast.error).toHaveBeenCalledWith("service down", { id: "archive-cleanups-error" });
  });
});
