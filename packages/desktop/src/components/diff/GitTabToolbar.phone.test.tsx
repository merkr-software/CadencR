import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/test-utils";
import { GitTabToolbar, type GitTabToolbarProps } from "./GitTabToolbar";

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));

function renderToolbar(overrides: Partial<GitTabToolbarProps> = {}) {
  const onViewModeChange = vi.fn();
  const view = render(
    <GitTabToolbar
      viewMode="uncommitted"
      onViewModeChange={onViewModeChange}
      targetBranch="main"
      prLabel={undefined}
      prNumber={42}
      prTone="ready"
      prAttention={false}
      prOtherCount={0}
      prOtherTone="neutral"
      uncommittedCount={3}
      conflictCount={0}
      pendingViewMode={null}
      isListView={false}
      fileListCollapsed={false}
      isFileListCollapseLoading={false}
      onToggleFileList={vi.fn()}
      stats={{ isLoading: false, isError: false, additions: 12, deletions: 4 }}
      {...overrides}
    />,
  );
  return { ...view, onViewModeChange };
}

describe("GitTabToolbar on the phone layout", () => {
  it("names the view on one 44px button instead of the tab strip and file-list toggle", () => {
    renderToolbar();
    const picker = screen.getByRole("button", { name: "Git view: Changes" });
    expect(picker).toHaveClass("h-11");
    expect(within(picker).getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide file list" })).not.toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
  });

  it("lists the six views in a sheet and switches to the one picked", async () => {
    const { user, onViewModeChange } = renderToolbar();
    await user.click(screen.getByRole("button", { name: "Git view: Changes" }));

    const sheet = await screen.findByRole("dialog");
    const rows = within(sheet).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Changes3",
      "vs main",
      "Pull request #42",
      "Commits",
      "Branches",
      "Stashes",
    ]);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    await user.click(within(sheet).getByRole("button", { name: /Branches/ }));
    expect(onViewModeChange).toHaveBeenCalledWith("branches");
  });

  it("puts conflicts ahead of the change count", () => {
    renderToolbar({ conflictCount: 2 });
    expect(screen.getByText("2 conflicted")).toBeInTheDocument();
  });
});
