/**
 * Coverage for the explicit worktree-mode resolver matrix: attached-worktree
 * branches, the selected default branch, a selected non-default branch, remote
 * branches, and no selected branch. The resolver is the pure rule the prompt
 * send handler relies on to persist feature settings + drive the checkout.
 */
import { describe, expect, it } from "vitest";
import type { BranchInfo } from "@/api/generated";
import {
  branchWorktreeState,
  describeWorktreeMode,
  defaultWorktreeMode,
  firstPromptBranchEffect,
  isWorktreeModeDisabled,
  resolveWorktreeChoice,
} from "./worktree-mode";

function branch(name: string, opts?: { attached?: string; local?: boolean }): BranchInfo {
  return {
    name,
    is_local: opts?.local ?? true,
    attached_worktree_path: opts?.attached ?? null,
    attached_feature_id: opts?.attached ? 7 : null,
  } as unknown as BranchInfo;
}

describe("branchWorktreeState", () => {
  it("treats no selection as the project's current branch (on the project path)", () => {
    const state = branchWorktreeState({
      selectedBranch: null,
      defaultBranch: "main",
      branches: [branch("main")],
      projectPath: "/repo",
    });
    expect(state).toMatchObject({
      effectiveBranch: "main",
      isOnProjectPath: true,
      hasWorktree: false,
    });
  });

  it("flags a branch attached to a separate worktree", () => {
    const state = branchWorktreeState({
      selectedBranch: "feat/foo",
      defaultBranch: "main",
      branches: [branch("feat/foo", { attached: "/tmp/feat-foo-wt" })],
      projectPath: "/repo",
    });
    expect(state).toMatchObject({ isOnProjectPath: false, hasWorktree: true, isLocal: true });
  });

  it("treats a branch checked out at the project path as on-project-path, not a worktree", () => {
    // The repro: project path was switched to a non-default branch in the
    // terminal, then picked in the selector. `git worktree list` reports the
    // project path as that branch's worktree → reuse must be impossible even
    // though it isn't the (stale) default branch.
    const state = branchWorktreeState({
      selectedBranch: "toto",
      defaultBranch: "main",
      branches: [branch("toto", { attached: "/repo" })],
      projectPath: "/repo",
    });
    expect(state.isOnProjectPath).toBe(true);
    expect(state.hasWorktree).toBe(false);
  });

  it("normalizes a trailing slash when comparing the attachment to the project path", () => {
    const state = branchWorktreeState({
      selectedBranch: "toto",
      defaultBranch: "main",
      branches: [branch("toto", { attached: "/repo" })],
      projectPath: "/repo/",
    });
    expect(state.isOnProjectPath).toBe(true);
  });

  it("marks remote-tracking refs as non-local", () => {
    const state = branchWorktreeState({
      selectedBranch: "origin/foo",
      defaultBranch: "main",
      branches: [branch("origin/foo", { local: false })],
      projectPath: "/repo",
    });
    expect(state.isLocal).toBe(false);
  });
});

describe("isWorktreeModeDisabled", () => {
  const base = { effectiveBranch: "feat/x", hasWorktree: false };
  it("disables branch_worktree for the branch on the project path", () => {
    expect(
      isWorktreeModeDisabled("branch_worktree", { ...base, isOnProjectPath: true, isLocal: true }),
    ).toBe(true);
  });
  it("disables branch_worktree for remote branches", () => {
    expect(
      isWorktreeModeDisabled("branch_worktree", {
        ...base,
        isOnProjectPath: false,
        isLocal: false,
      }),
    ).toBe(true);
  });
  it("allows branch_worktree for a local branch not on the project path", () => {
    expect(
      isWorktreeModeDisabled("branch_worktree", { ...base, isOnProjectPath: false, isLocal: true }),
    ).toBe(false);
  });
  it("never disables the other modes", () => {
    const state = { ...base, isOnProjectPath: true, isLocal: false };
    for (const mode of ["on_branch", "from_branch", "from_branch_worktree"] as const) {
      expect(isWorktreeModeDisabled(mode, state)).toBe(false);
    }
  });
});

describe("describeWorktreeMode", () => {
  it("labels branch_worktree as Reuse when a worktree exists, New otherwise", () => {
    const withWt = {
      effectiveBranch: "feat/x",
      isOnProjectPath: false,
      hasWorktree: true,
      isLocal: true,
    };
    const noWt = { ...withWt, hasWorktree: false };
    expect(describeWorktreeMode("branch_worktree", withWt).label).toBe("Reuse worktree");
    expect(describeWorktreeMode("branch_worktree", noWt).label).toBe("New worktree");
  });
});

describe("defaultWorktreeMode", () => {
  it("maps project defaults onto the richer mode set", () => {
    expect(defaultWorktreeMode("new")).toBe("from_branch_worktree");
    expect(defaultWorktreeMode("skip")).toBe("on_branch");
  });
});

describe("firstPromptBranchEffect", () => {
  it("announces the deferred project switch for on_branch with a different pick", () => {
    expect(
      firstPromptBranchEffect({
        mode: "on_branch",
        selectedBranch: "develop",
        defaultBranch: "main",
      }),
    ).toBe("Switches the project to develop when you send your first message.");
  });

  it("says nothing for on_branch on the current branch (no deferred action)", () => {
    expect(
      firstPromptBranchEffect({ mode: "on_branch", selectedBranch: null, defaultBranch: "main" }),
    ).toBeNull();
    // Picking the current branch explicitly is still a no-op switch.
    expect(
      firstPromptBranchEffect({ mode: "on_branch", selectedBranch: "main", defaultBranch: "main" }),
    ).toBeNull();
  });

  it("describes deferred provisioning for the worktree/new-branch modes", () => {
    expect(
      firstPromptBranchEffect({ mode: "from_branch", selectedBranch: null, defaultBranch: "main" }),
    ).toBe("Creates a new branch from main when you send your first message.");
    expect(
      firstPromptBranchEffect({
        mode: "branch_worktree",
        selectedBranch: "feat/foo",
        defaultBranch: "main",
      }),
    ).toBe("Sets up a worktree on feat/foo when you send your first message.");
    expect(
      firstPromptBranchEffect({
        mode: "from_branch_worktree",
        selectedBranch: "feat/foo",
        defaultBranch: "main",
      }),
    ).toBe("Creates a new branch from feat/foo in a worktree when you send your first message.");
  });
});

describe("resolveWorktreeChoice", () => {
  it("on_branch with no pick stays on the current branch (skip, no checkout)", () => {
    expect(
      resolveWorktreeChoice({ mode: "on_branch", selectedBranch: null, defaultBranch: "main" }),
    ).toEqual({ backendMode: "skip", checkout: null });
  });

  it("on_branch with an explicit non-default pick checks it out", () => {
    expect(
      resolveWorktreeChoice({
        mode: "on_branch",
        selectedBranch: "develop",
        defaultBranch: "main",
      }),
    ).toEqual({ backendMode: "skip", checkout: "develop" });
  });

  it("branch_worktree resolves to reuse on the selected branch", () => {
    expect(
      resolveWorktreeChoice({
        mode: "branch_worktree",
        selectedBranch: "feat/foo",
        defaultBranch: "main",
      }),
    ).toEqual({ backendMode: "reuse", reuseBranch: "feat/foo" });
  });

  it("from_branch resolves to a worktree-free project_branch with the base", () => {
    expect(
      resolveWorktreeChoice({
        mode: "from_branch",
        selectedBranch: "develop",
        defaultBranch: "main",
      }),
    ).toEqual({ backendMode: "project_branch", base: "develop" });
    // No explicit pick → fork from current HEAD.
    expect(
      resolveWorktreeChoice({ mode: "from_branch", selectedBranch: null, defaultBranch: "main" }),
    ).toEqual({ backendMode: "project_branch", base: null });
  });

  it("from_branch_worktree resolves to the new backend mode with the base", () => {
    expect(
      resolveWorktreeChoice({
        mode: "from_branch_worktree",
        selectedBranch: "develop",
        defaultBranch: "main",
      }),
    ).toEqual({ backendMode: "new", baseBranch: "develop" });
    expect(
      resolveWorktreeChoice({
        mode: "from_branch_worktree",
        selectedBranch: "main",
        defaultBranch: "main",
      }),
    ).toEqual({ backendMode: "new", baseBranch: null });
  });
});
