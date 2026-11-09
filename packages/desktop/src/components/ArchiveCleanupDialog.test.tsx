import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, render, screen, waitFor } from "@/test-utils";
import type { ArchiveCleanupStatus } from "@/api/generated";
import { ArchiveCleanupDialog } from "./ArchiveCleanupDialog";
import { useArchiveCleanupReviewStore } from "@/stores/archive-cleanup-review-store";

const { mockGetCleanup, mockRetry } = vi.hoisted(() => ({
  mockGetCleanup: vi.fn(),
  mockRetry: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetArchiveCleanup: mockGetCleanup,
  useRetryArchiveCleanup: vi.fn(() => ({ mutateAsync: mockRetry, isPending: false, error: null })),
}));

function status(overrides: Partial<ArchiveCleanupStatus> = {}): ArchiveCleanupStatus {
  return {
    feature_id: 7,
    project_id: 1,
    title: "Fix login",
    running: false,
    settled: false,
    cleanup: {
      terminals: { status: "done", detail: "killed 1 shell(s)" },
      worktree: {
        status: "blocked",
        reason: "dirty_worktree",
        message: "Worktree has uncommitted or untracked changes",
      },
      branch: { status: "pending", reason: "waiting for the worktree removal" },
    },
    ...overrides,
  };
}

describe("ArchiveCleanupDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRetry.mockResolvedValue(status({ settled: true }));
    mockGetCleanup.mockReturnValue({ data: status(), isLoading: false, error: null });
    act(() => useArchiveCleanupReviewStore.getState().open(7));
  });

  it("shows each journaled step and forces a blocked worktree only after confirmation", async () => {
    const user = userEvent.setup();
    render(<ArchiveCleanupDialog />);

    expect(mockGetCleanup).toHaveBeenCalledWith(7, expect.anything());
    expect(screen.getByText("“Fix login”")).toBeInTheDocument();
    expect(screen.getByText("Done: killed 1 shell(s)")).toBeInTheDocument();
    expect(
      screen.getByText("Blocked: Worktree has uncommitted or untracked changes"),
    ).toBeInTheDocument();
    expect(screen.getByText("Pending: waiting for the worktree removal")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard changes & remove worktree…" }));
    expect(mockRetry).not.toHaveBeenCalled();
    expect(screen.getByText("Discard uncommitted changes?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard changes & remove worktree" }));

    await waitFor(() =>
      expect(mockRetry).toHaveBeenCalledExactlyOnceWith({
        id: 7,
        data: { force_remove_worktree: true },
      }),
    );
  });

  it("resumes an interrupted cleanup without forcing anything", async () => {
    mockGetCleanup.mockReturnValue({
      data: status({ cleanup: { worktree: { status: "interrupted" } } }),
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    render(<ArchiveCleanupDialog />);

    expect(screen.getByText("Interrupted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discard changes/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume cleanup" }));

    expect(mockRetry).toHaveBeenCalledExactlyOnceWith({ id: 7, data: {} });
  });

  it("disables every action while the service runs the cleanup", () => {
    mockGetCleanup.mockReturnValue({
      data: status({ running: true, cleanup: { worktree: { status: "running" } } }),
      isLoading: false,
      error: null,
    });
    render(<ArchiveCleanupDialog />);

    expect(screen.getByRole("button", { name: "Cleaning up…" })).toBeDisabled();
  });

  it("offers nothing to do once the cleanup is settled", () => {
    mockGetCleanup.mockReturnValue({
      data: status({ settled: true, cleanup: { worktree: { status: "done" } } }),
      isLoading: false,
      error: null,
    });
    render(<ArchiveCleanupDialog />);

    expect(screen.queryByRole("button", { name: "Resume cleanup" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
