// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { handleAgentArchived } from "@/lib/agent-archived";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

function event(cleanup: Record<string, unknown>, ids = [2]) {
  return {
    project_id: 1,
    feature_id: 2,
    title: "Archive target",
    archived_by: "Orchestrator",
    archived_feature_ids: ids,
    cleanup,
  };
}

describe("handleAgentArchived", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toasts the finished cleanup", () => {
    handleAgentArchived(
      event({
        terminals: { status: "done", detail: "killed 1 shell(s)" },
        worktree: { status: "done" },
      }),
    );

    expect(toast.success).toHaveBeenCalledWith("Orchestrator archived “Archive target”", {
      description: "Cleanup finished: terminals, worktree.",
    });
  });

  it("warns about a blocked step and names the relatives archived alongside", () => {
    handleAgentArchived(
      event(
        { branch: { status: "blocked", reason: "unmerged_branch", message: "Branch not merged" } },
        [2, 3],
      ),
    );

    expect(toast.warning).toHaveBeenCalledWith(
      "Orchestrator archived “Archive target” and 1 related session, but cleanup is incomplete",
      { description: "Review it to resume or force the remaining steps." },
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not count a step waiting for the desktop as a problem", () => {
    handleAgentArchived(
      event({ browser_tabs: { status: "pending", reason: "waiting for the desktop app" } }),
    );

    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Orchestrator archived “Archive target”", {
      description: undefined,
    });
  });

  it("reports an unreadable event instead of dropping it", () => {
    handleAgentArchived({ feature_id: "2" });

    expect(toast.error).toHaveBeenCalledWith("An agent archived a session", {
      description: "Cadencr could not read the archive details; the session list was refreshed.",
    });
  });
});
