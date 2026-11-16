/**
 * Snapshot matrix for `deriveGitAction` — the pure core of the smart Git
 * action button. Each test names one row of the matrix.
 */
import { describe, expect, it } from "vitest";
import { deriveGitAction, resolveGitUpdateSource } from "./useGitAction";
import type { GitStatusSnapshot, PrSummary } from "@/api/generated";

function snapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    feature_id: 1,
    current_branch: "feature/x",
    target_branch: "main",
    uncommitted_count: 0,
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    ahead_of_remote: 0,
    behind_remote: 0,
    ahead_of_target: 0,
    behind_target: 0,
    target_resolved: true,
    conflict_count: 0,
    operation: null,
    has_remote: true,
    host: "GitHub",
    compare_url: "https://github.com/x/y/compare/main...feature/x",
    action_label: "Open pull request",
    computed_at: 0,
    ...overrides,
  };
}

function pullRequest(): PrSummary {
  return {
    number: 42,
    title: "Forge integration",
    body_markdown: "",
    state: "open",
    url: "https://github.com/x/y/pull/42",
    source_branch: "feature/x",
    target_branch: "main",
    head_sha: "a".repeat(40),
    review_state: "pending",
    author: { username: "octocat", display_name: null, avatar_url: null },
    updated_at: "2026-07-23T10:00:00Z",
    pr_label: "Pull request",
  };
}

describe("deriveGitAction", () => {
  it("returns Loading state when no snapshot is available", () => {
    const state = deriveGitAction(undefined);
    expect(state.primary).toBeNull();
    expect(state.label).toBe("Loading…");
    expect(state.disabled.commit).toBe("Loading…");
    expect(state.disabled.stash).toBe("Loading…");
    expect(state.disabled.update).toBe("Loading…");
    expect(state.disabled.push).toBe("Loading…");
    expect(state.disabled.pr).toBe("Loading…");
    expect(state.disabled.merge).toBe("Loading…");
  });

  it("primary=commit when there are uncommitted changes", () => {
    const state = deriveGitAction(snapshot({ uncommitted_count: 3, untracked_count: 1 }));
    expect(state.primary).toBe("commit");
    expect(state.label).toBe("Commit");
    expect(state.disabled.commit).toBeNull();
    expect(state.disabled.update).toBe("Commit or stash your changes first");
    expect(state.disabled.merge).toBe("Nothing to merge");
  });

  it("enables secondary Stash for tracked changes without replacing Commit", () => {
    const state = deriveGitAction(
      snapshot({ uncommitted_count: 2, staged_count: 1, unstaged_count: 1 }),
    );

    expect(state.primary).toBe("commit");
    expect(state.label).toBe("Commit");
    expect(state.disabled.stash).toBeNull();
  });

  it("enables untracked-only stash creation and explains clean and conflicted states", () => {
    expect(deriveGitAction(snapshot()).disabled.stash).toBe("No changes to stash");
    expect(
      deriveGitAction(snapshot({ uncommitted_count: 1, untracked_count: 1 })).disabled.stash,
    ).toBeNull();
    expect(
      deriveGitAction(
        snapshot({
          uncommitted_count: 2,
          staged_count: 1,
          unstaged_count: 1,
          conflict_count: 1,
        }),
      ).disabled.stash,
    ).toBe("Resolve conflicting files first");
  });

  it("surfaces feature-scoped stash mutation exclusion without changing the primary action", () => {
    const state = deriveGitAction(
      snapshot({ uncommitted_count: 1, unstaged_count: 1 }),
      false,
      "Pop stash@{0} in progress",
    );

    expect(state.primary).toBe("commit");
    expect(state.disabled.stash).toBe("Pop stash@{0} in progress");
  });

  it("primary=update when the clean current branch is behind its resolved target", () => {
    const state = deriveGitAction(snapshot({ behind_target: 3, ahead_of_target: 2 }));

    expect(state.primary).toBe("update");
    expect(state.label).toBe("Update");
    expect(state.disabled.update).toBeNull();
    expect(state.disabled.merge).toBeNull();
  });

  it("disables update when the exact configured target does not resolve", () => {
    const state = deriveGitAction(
      snapshot({ target_branch: "origin/missing", target_resolved: false, behind_target: 3 }),
    );

    expect(state.disabled.update).toBe("Target 'origin/missing' does not resolve");
  });

  it("disables update when the current and exact target identities are the same", () => {
    const state = deriveGitAction(
      snapshot({ current_branch: "main", target_branch: "main", behind_target: 3 }),
    );

    expect(state.disabled.update).toBe("Current branch is already the update target");
  });

  it("recognizes a fully-qualified local target as the current branch identity", () => {
    const state = deriveGitAction(
      snapshot({ current_branch: "main", target_branch: "refs/heads/main", behind_target: 3 }),
    );

    expect(state.disabled.update).toBe("Current branch is already the update target");
  });

  it("preserves origin/main as distinct from checked-out main for Update", () => {
    const state = deriveGitAction(
      snapshot({ current_branch: "main", target_branch: "origin/main", behind_target: 2 }),
    );

    expect(state.primary).toBe("update");
    expect(state.disabled.update).toBeNull();
    expect(state.disabled.merge).toBe("Cannot merge a branch into itself");
  });

  it("enables Update for incoming commits on the current branch upstream", () => {
    const currentMain = snapshot({
      current_branch: "main",
      target_branch: "main",
      behind_remote: 3,
      update_target_branch: "origin/main",
      behind_update_target: 3,
      update_target_resolved: true,
    });

    const state = deriveGitAction(currentMain);

    expect(state.primary).toBe("update");
    expect(state.disabled.update).toBeNull();
    expect(resolveGitUpdateSource(currentMain)).toEqual({
      branch: "origin/main",
      ahead: 0,
      behind: 3,
      kind: "upstream",
      resolved: true,
    });
  });

  it("prefers incoming upstream commits over configured-target divergence", () => {
    const state = snapshot({
      ahead_of_remote: 1,
      behind_remote: 2,
      ahead_of_target: 4,
      behind_target: 5,
      update_target_branch: "origin/feature/x",
      ahead_of_update_target: 1,
      behind_update_target: 2,
      update_target_resolved: true,
    });

    expect(resolveGitUpdateSource(state)).toEqual({
      branch: "origin/feature/x",
      ahead: 1,
      behind: 2,
      kind: "upstream",
      resolved: true,
    });
  });

  it("requires every clean-worktree count to be zero before Update", () => {
    const fields: Array<keyof GitStatusSnapshot> = [
      "uncommitted_count",
      "staged_count",
      "unstaged_count",
      "untracked_count",
      "conflict_count",
    ];

    for (const field of fields) {
      const state = deriveGitAction(snapshot({ behind_target: 1, [field]: 1 }));
      expect(state.disabled.update, field).toBe("Commit or stash your changes first");
    }
  });

  it("requires behind_target to be positive before Update", () => {
    const state = deriveGitAction(snapshot({ behind_target: 0 }));

    expect(state.disabled.update).toBe("Already up to date");
  });

  it("blocks incompatible actions while an update request is pending", () => {
    const state = deriveGitAction(snapshot({ behind_target: 2, ahead_of_target: 2 }), true);

    expect(state.primary).toBeNull();
    expect(state.label).toBe("Updating…");
    expect(state.disabled).toMatchObject({
      commit: "Update request in progress",
      stash: "Update request in progress",
      update: "Update request in progress",
      push: "Update request in progress",
      pr: null,
      merge: "Update request in progress",
    });
    expect(state.recovery).toBeNull();
  });

  it("derives recovery actions from an active operation and live conflict count", () => {
    const state = deriveGitAction(
      snapshot({ operation: "rebase", conflict_count: 2, uncommitted_count: 2 }),
    );

    expect(state.disabled.commit).toBe("Finish or abort the active rebase update first");
    expect(state.recovery).toEqual({
      operation: "rebase",
      conflictCount: 2,
      continueDisabled: "Resolve and stage 2 conflicting files first",
      abortDisabled: null,
    });
  });

  it("enables Continue only after backend status reports no remaining conflicts", () => {
    const state = deriveGitAction(snapshot({ operation: "merge", conflict_count: 0 }));

    expect(state.recovery?.continueDisabled).toBeNull();
    expect(state.recovery?.abortDisabled).toBeNull();
  });

  it("waits for canonical status before exposing recovery actions", () => {
    const state = deriveGitAction(snapshot());
    expect(state.recovery).toBeNull();
  });

  it("keeps merge and compare enabled when committed branch changes exist with uncommitted source changes", () => {
    const state = deriveGitAction(
      snapshot({ uncommitted_count: 3, untracked_count: 1, ahead_of_target: 2 }),
    );
    expect(state.primary).toBe("commit");
    expect(state.disabled.commit).toBeNull();
    expect(state.disabled.merge).toBeNull();
    expect(state.disabled.pr).toBeNull();
  });

  it("primary=push when clean but ahead of remote", () => {
    const state = deriveGitAction(snapshot({ ahead_of_remote: 2 }));
    expect(state.primary).toBe("push");
    expect(state.label).toBe("Push");
    expect(state.disabled.push).toBeNull();
    expect(state.disabled.commit).toBe("No uncommitted changes");
    expect(state.disabled.pr).toBe("Push your commits first");
  });

  it("primary=pr when clean, pushed, and ahead of target with provider compare URL", () => {
    const state = deriveGitAction(
      snapshot({ ahead_of_target: 4, action_label: "Open merge request" }),
    );
    expect(state.primary).toBe("pr");
    expect(state.label).toBe("Open merge request");
    expect(state.disabled.pr).toBeNull();
    expect(state.disabled.merge).toBeNull();
  });

  it("opens an existing proposal even when the branch has nothing left to compare", () => {
    const state = deriveGitAction(snapshot(), false, null, pullRequest());

    expect(state.primary).toBe("pr");
    expect(state.label).toBe("View pull request #42");
    expect(state.compareLabel).toBe("View pull request #42");
    expect(state.disabled.pr).toBeNull();
  });

  it("primary=merge when compare is unavailable but target has commits to merge", () => {
    const state = deriveGitAction(
      snapshot({ ahead_of_target: 4, compare_url: null, action_label: "Open compare" }),
    );
    expect(state.primary).toBe("merge");
    expect(state.label).toBe("Merge");
    expect(state.disabled.merge).toBeNull();
  });

  it("keeps merge enabled after a pushed feature branch is ahead of target", () => {
    const state = deriveGitAction(
      snapshot({
        ahead_of_remote: 0,
        ahead_of_target: 1,
        current_branch: "feature/x",
        target_branch: "origin/main",
        compare_url: null,
        action_label: "Open compare",
      }),
    );
    expect(state.primary).toBe("merge");
    expect(state.disabled.merge).toBeNull();
  });

  it("merge disabled when current branch and target branch are the same local branch", () => {
    const state = deriveGitAction(
      snapshot({
        current_branch: "main",
        target_branch: "main",
        ahead_of_target: 2,
        compare_url: null,
      }),
    );
    expect(state.primary).toBeNull();
    expect(state.disabled.merge).toBe("Cannot merge a branch into itself");
  });

  it("merge disabled when current branch matches an origin-prefixed target", () => {
    const state = deriveGitAction(
      snapshot({
        current_branch: "main",
        target_branch: "origin/main",
        ahead_of_target: 2,
        compare_url: null,
      }),
    );
    expect(state.primary).toBeNull();
    expect(state.disabled.merge).toBe("Cannot merge a branch into itself");
  });

  it("primary=null on a fully clean tree with nothing to push or PR", () => {
    const state = deriveGitAction(snapshot());
    expect(state.primary).toBeNull();
    expect(state.disabled.commit).toBe("No uncommitted changes");
    expect(state.disabled.push).toBe("Nothing to push");
    expect(state.disabled.pr).toBe("Nothing to compare");
    expect(state.disabled.merge).toBe("Nothing to merge");
  });

  it("PR disabled with 'No remote configured' when has_remote=false", () => {
    const state = deriveGitAction(
      snapshot({ ahead_of_target: 1, has_remote: false, compare_url: null, host: null }),
    );
    expect(state.primary).toBe("merge");
    expect(state.disabled.pr).toBe("No remote configured");
  });

  it("PR disabled with provider-unavailable reason for Other host without compare URL", () => {
    const state = deriveGitAction(
      snapshot({
        ahead_of_target: 1,
        host: "Other",
        compare_url: null,
        action_label: "Open compare",
      }),
    );
    expect(state.primary).toBe("merge");
    expect(state.disabled.pr).toBe("Compare URL not available for this remote");
    expect(state.compareLabel).toBe("Open compare");
  });

  it("PR enabled for Other host when backend supplied a compare URL", () => {
    const state = deriveGitAction(
      snapshot({
        ahead_of_target: 1,
        host: "Other",
        compare_url: "https://example.com/compare",
        action_label: "Open compare",
      }),
    );
    expect(state.primary).toBe("pr");
    expect(state.label).toBe("Open compare");
  });

  it("commit wins over push when both are technically actionable (commit has higher priority)", () => {
    const state = deriveGitAction(snapshot({ uncommitted_count: 1, ahead_of_remote: 2 }));
    expect(state.primary).toBe("commit");
    expect(state.disabled.push).toBeNull();
  });

  it("falls back to 'Open pull request' for compareLabel when action_label is missing", () => {
    const state = deriveGitAction(
      snapshot({
        ahead_of_target: 1,
        action_label: null,
        host: null,
        compare_url: "https://example.com/compare",
      }),
    );
    // compareLabel is the per-action label rendered in the popover, even when
    // backend didn't ship action_label — the frontend is provider-neutral and
    // uses a generic fallback.
    expect(state.compareLabel).toBe("Open pull request");
    expect(state.primary).toBe("pr");
    expect(state.label).toBe("Open pull request");
  });

  it("PR disabled whenever compare_url is missing, regardless of host", () => {
    // Provider-neutral check: the frontend never reads `host` to decide
    // availability — `compare_url == null` is the single source of truth.
    const state = deriveGitAction(
      snapshot({ ahead_of_target: 1, host: null, compare_url: null, action_label: null }),
    );
    expect(state.primary).toBe("merge");
    expect(state.disabled.pr).toBe("Compare URL not available for this remote");
  });
});
