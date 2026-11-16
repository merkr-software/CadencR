// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  failArchiveProgress,
  finishArchiveProgress,
  startArchiveProgress,
  updateArchiveProgress,
} from "./archive-progress-toast";

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
const scopedToastDescription = vi.hoisted(() => vi.fn((): ReactNode => undefined));

vi.mock("@/components/ToastScope", () => ({ scopedToastDescription }));

const TOAST_ID = "archive-progress-2";

function lastDescription(mock: ReturnType<typeof vi.fn>): ReactNode {
  const options = mock.mock.lastCall?.[1] as { description?: ReactNode } | undefined;
  return options?.description;
}

describe("archive progress toast", () => {
  beforeEach(() => vi.clearAllMocks());

  it("follows each step the service reports, then settles on the outcome", () => {
    startArchiveProgress(2);
    expect(toast.loading).toHaveBeenCalledExactlyOnceWith("Archiving session…", {
      id: TOAST_ID,
      description: undefined,
    });

    updateArchiveProgress(2, {
      terminals: { status: "done" },
      worktree: { status: "running" },
      branch: { status: "pending", reason: "waiting for the worktree removal" },
    });
    expect(toast.loading).toHaveBeenLastCalledWith("Archiving session…", expect.anything());
    render(<>{lastDescription(toast.loading)}</>);
    const steps = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(steps).toEqual(["TerminalsDone", "WorktreeIn progress", "BranchPending"]);

    finishArchiveProgress(2, {
      terminals: { status: "done" },
      worktree: { status: "done" },
      branch: { status: "done" },
    });
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("Session archived", {
      id: TOAST_ID,
      description: "Cleanup finished: terminals, worktree, branch.",
    });

    // A step event arriving after the response must not reopen the spinner.
    updateArchiveProgress(2, { branch: { status: "done" } });
    expect(toast.loading).toHaveBeenCalledTimes(2);
  });

  it("keeps the scope line read when the archive started above the steps", () => {
    scopedToastDescription.mockReturnValueOnce(<div>qa-archive · With cleanup</div>);
    startArchiveProgress(2);
    updateArchiveProgress(2, { worktree: { status: "running" } });
    render(<>{lastDescription(toast.loading)}</>);
    expect(screen.getByText("qa-archive · With cleanup")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("WorktreeIn progress");
    finishArchiveProgress(2, { worktree: { status: "done" } });
    expect(toast.success).toHaveBeenCalledWith(
      "Session archived",
      expect.objectContaining({ id: TOAST_ID }),
    );
  });

  it("follows archives of different conversations on their own toasts", () => {
    startArchiveProgress(2);
    startArchiveProgress(5);
    finishArchiveProgress(2, {});
    updateArchiveProgress(5, { branch: { status: "running" } });
    expect(toast.loading).toHaveBeenLastCalledWith(
      "Archiving session…",
      expect.objectContaining({ id: "archive-progress-5" }),
    );
    failArchiveProgress(5, new Error("refused"), false);
    expect(toast.error).toHaveBeenCalledWith(
      "Could not archive session",
      expect.objectContaining({ id: "archive-progress-5" }),
    );
  });

  it("ignores events of archives this window did not start", () => {
    updateArchiveProgress(7, { terminals: { status: "running" } });
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it("gives way to the cleanup notice when a step needs the user", () => {
    startArchiveProgress(2);
    finishArchiveProgress(2, { worktree: { status: "blocked", reason: "dirty_worktree" } });
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(TOAST_ID);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports a refused archive as an error", () => {
    startArchiveProgress(2);
    failArchiveProgress(2, new Error("archive refused"), false);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could not archive session", {
      id: TOAST_ID,
      description: "archive refused",
    });
  });

  it("warns when the archive committed but its answer was lost", () => {
    startArchiveProgress(2);
    failArchiveProgress(2, new Error("Network Error"), true);
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      "Session archived, but its cleanup did not report back",
      expect.objectContaining({ id: TOAST_ID }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});
