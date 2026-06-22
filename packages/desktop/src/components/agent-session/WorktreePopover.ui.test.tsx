import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { BranchInfo } from "@/api/generated";
import type { WorktreeMode } from "@/lib/worktree-mode";
import { WorktreeButtonGroup } from "./WorktreePopover";

const mocks = vi.hoisted(() => ({
  mockUseListBranches: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useListBranches: mocks.mockUseListBranches,
}));

function branch(name: string, opts?: { attached?: string | null; local?: boolean }): BranchInfo {
  return {
    name,
    is_local: opts?.local ?? true,
    attached_worktree_path: opts?.attached ?? null,
    attached_feature_id: opts?.attached ? 7 : null,
  } as unknown as BranchInfo;
}

function renderGroup(args: {
  branches: BranchInfo[];
  selectedBranch: string | null;
  mode: WorktreeMode;
  projectPath?: string;
  onModeChange?: () => void;
  onSelectedBranchChange?: () => void;
}): ReturnType<typeof render> {
  mocks.mockUseListBranches.mockReturnValue({
    data: args.branches,
    isLoading: false,
    isError: false,
    error: null,
  });
  return render(
    <WorktreeButtonGroup
      projectId={1}
      defaultBranch="main"
      projectPath={args.projectPath ?? "/repo"}
      mode={args.mode}
      onModeChange={args.onModeChange ?? vi.fn()}
      selectedBranch={args.selectedBranch}
      onSelectedBranchChange={args.onSelectedBranchChange ?? vi.fn()}
    />,
  );
}

describe("WorktreeButtonGroup", () => {
  it("shows the current mode label in the mode segment", () => {
    renderGroup({ branches: [], selectedBranch: null, mode: "on_branch" });
    expect(screen.getByRole("button", { name: /branch \/ worktree behavior/i })).toHaveTextContent(
      "On branch",
    );
  });

  it("labels the worktree mode 'Reuse worktree' for a branch that already has one", () => {
    renderGroup({
      branches: [branch("feat/attached", { attached: "/tmp/wt" })],
      selectedBranch: "feat/attached",
      mode: "branch_worktree",
    });
    expect(screen.getByRole("button", { name: /branch \/ worktree behavior/i })).toHaveTextContent(
      "Reuse worktree",
    );
  });

  it("lists every explicit behavior and disables worktree-for-default-branch", async () => {
    const { user } = renderGroup({ branches: [], selectedBranch: null, mode: "on_branch" });
    await user.click(screen.getByRole("button", { name: /branch \/ worktree behavior/i }));

    // Row labels unique to the menu (the trigger already shows "On branch").
    expect(await screen.findByText("From branch")).toBeInTheDocument();
    expect(screen.getByText("From branch with worktree")).toBeInTheDocument();
    // The default branch can't be moved into a dedicated worktree.
    const worktreeRow = screen.getByText("New worktree").closest("button");
    expect(worktreeRow).toBeDisabled();
  });

  it("disables the worktree mode for a non-default branch checked out at the project path", async () => {
    // Repro: the project path was switched to `toto`, which the user then picks
    // in the selector. Its worktree attachment equals the project path, so
    // "reuse/new worktree" must be off even though it isn't the default branch.
    const { user } = renderGroup({
      branches: [branch("toto", { attached: "/repo" })],
      selectedBranch: "toto",
      mode: "on_branch",
      projectPath: "/repo",
    });
    await user.click(screen.getByRole("button", { name: /branch \/ worktree behavior/i }));
    const worktreeRow = (await screen.findByText("New worktree")).closest("button");
    expect(worktreeRow).toBeDisabled();
  });

  it("selects a mode from the menu", async () => {
    const onModeChange = vi.fn();
    const { user } = renderGroup({
      branches: [],
      selectedBranch: null,
      mode: "on_branch",
      onModeChange,
    });
    await user.click(screen.getByRole("button", { name: /branch \/ worktree behavior/i }));
    await user.click(await screen.findByText("From branch with worktree"));
    expect(onModeChange).toHaveBeenCalledWith("from_branch_worktree");
  });

  it("spells out that an on_branch switch is deferred until the first message", async () => {
    // Regression for #61: picking a different branch in the pre-prompt chip
    // must not imply the switch already happened — the checkout is deferred to
    // send, so the chip surfaces a future-tense hint in both popovers.
    const { user } = renderGroup({
      branches: [branch("develop")],
      selectedBranch: "develop",
      mode: "on_branch",
    });
    // Mode popover (stays open while reading behaviors).
    await user.click(screen.getByRole("button", { name: /branch \/ worktree behavior/i }));
    expect(
      await screen.findByText("Switches the project to develop when you send your first message."),
    ).toBeInTheDocument();
  });

  it("does not show a deferral hint when staying on the current branch", async () => {
    const { user } = renderGroup({ branches: [], selectedBranch: null, mode: "on_branch" });
    await user.click(screen.getByRole("button", { name: /branch \/ worktree behavior/i }));
    expect(await screen.findByText("From branch")).toBeInTheDocument();
    expect(screen.queryByText(/when you send your first message/i)).not.toBeInTheDocument();
  });

  it("steers the mode to reuse when picking a branch that has a worktree", async () => {
    const onModeChange = vi.fn();
    const { user } = renderGroup({
      branches: [branch("feat/attached", { attached: "/tmp/wt" })],
      selectedBranch: null,
      mode: "from_branch_worktree",
      onModeChange,
    });
    await user.click(screen.getByRole("button", { name: /^main$|^branch$/i }));
    await user.click(await screen.findByText("feat/attached"));
    expect(onModeChange).toHaveBeenCalledWith("branch_worktree");
  });
});
