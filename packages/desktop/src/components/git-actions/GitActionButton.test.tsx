import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, within } from "@testing-library/react";
import { render, screen } from "@/test-utils";
import type { GitStatusSnapshot } from "@/api/generated";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useGitStatusSubscription } from "@/hooks/useGitStatusSubscription";
import { useCommitOutputStore } from "@/stores/useCommitOutputStore";
import { usePushOutputStore } from "@/stores/usePushOutputStore";
import { GitActionButton } from "./GitActionButton";
import {
  resetStashMutationCoordinatorForTest,
  useStashMutationCoordinator,
} from "../diff/useStashMutationCoordinator";

const buttonMocks = vi.hoisted(() => ({ isMobile: false, updatePending: false }));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => buttonMocks.isMobile,
}));

vi.mock("./useGitUpdatePending", () => ({
  gitUpdateMutationKey: (featureId: number) => ["git-update", featureId],
  useGitUpdatePending: () => buttonMocks.updatePending,
}));

vi.mock("./MergeDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Merge branch" /> : null,
}));

vi.mock("./CommitDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Commit progress" /> : null,
}));

vi.mock("./UpdateBranchDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Update current branch" /> : null,
}));

vi.mock("./StashChangesDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Stash changes" /> : null,
}));

vi.mock("./PushDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Push progress" /> : null,
}));

function makeMergeableSnapshot(featureId: number): GitStatusSnapshot {
  return {
    feature_id: featureId,
    current_branch: "feature/test",
    target_branch: "origin/main",
    uncommitted_count: 0,
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    ahead_of_remote: 0,
    behind_remote: 0,
    ahead_of_target: 1,
    behind_target: 0,
    target_resolved: true,
    conflict_count: 0,
    operation: null,
    has_remote: true,
    compare_url: null,
    action_label: "Open PR",
    computed_at: 1,
  };
}

function makeDirtyMergeableSnapshot(featureId: number): GitStatusSnapshot {
  return {
    ...makeMergeableSnapshot(featureId),
    uncommitted_count: 2,
    unstaged_count: 2,
  };
}

beforeEach(() => {
  buttonMocks.isMobile = false;
  buttonMocks.updatePending = false;
  useGitStatusStore.setState(useGitStatusStore.getInitialState());
  useSessionStatusStore.setState({ isConnected: false });
  useCommitOutputStore.setState({ byFeature: {} });
  usePushOutputStore.setState({ byFeature: {} });
  resetStashMutationCoordinatorForTest();
});

afterEach(() => useSessionStatusStore.setState(useSessionStatusStore.getInitialState()));

function SubscribedGitActionButton() {
  useGitStatusSubscription(42);
  return <GitActionButton featureId={42} projectId={7} />;
}

describe("GitActionButton status recovery", () => {
  it("blocks Commit during a checkout outage and offers retry in the same view", async () => {
    const git = useGitStatusStore.getState();
    git.setStatus(makeDirtyMergeableSnapshot(42));
    useSessionStatusStore.setState({ isConnected: true });
    const { user } = render(<GitActionButton featureId={42} projectId={7} />);
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
    act(() =>
      git.setStatusError({
        feature_id: 42,
        error: "The feature's worktree is no longer available",
        code: "WORKTREE_UNAVAILABLE",
      }),
    );
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Worktree unavailable" }));
    expect(useGitStatusStore.getState().watcherEpoch[42]).toBe(1);
    act(() => git.setSubscription(42, "pending"));
    expect(screen.getByRole("button", { name: "Refreshing Git status…" })).toBeDisabled();
    act(() => {
      git.setSubscription(42, "answered");
      git.setStatus({ ...makeDirtyMergeableSnapshot(42), computed_at: 2 }, null);
    });
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
  });

  it("offers a retry for an initial failure and restores actions after the status arrives", async () => {
    const git = useGitStatusStore.getState();
    const unsubscribe = vi.fn((featureId: number) => git.setSubscription(featureId));
    const subscribeGitStatus = vi.fn((featureId: number) => {
      git.setSubscription(featureId, "pending");
      return () => unsubscribe(featureId);
    });
    useSessionStatusStore.setState({ isConnected: true, subscribeGitStatus });
    const { user } = render(<SubscribedGitActionButton />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    act(() => {
      git.setSubscription(42, "answered");
      git.setStatusError({ feature_id: 42, error: "Cannot read Git status" });
    });
    await user.click(screen.getByRole("button", { name: "Git status unavailable" }));
    expect(unsubscribe).toHaveBeenCalledWith(42);
    expect(subscribeGitStatus.mock.calls).toEqual([[42], [42]]);
    expect(screen.getByRole("button", { name: "Refreshing Git status…" })).toBeDisabled();
    act(() => {
      git.setSubscription(42, "answered");
      git.setStatus(makeDirtyMergeableSnapshot(42), null);
    });
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
  });

  it("offers retry on mobile when watcher setup fails after a valid snapshot", async () => {
    buttonMocks.isMobile = true;
    useSessionStatusStore.setState({ isConnected: true });
    const git = useGitStatusStore.getState();
    const snapshot = makeDirtyMergeableSnapshot(42);
    git.setStatus(snapshot);
    const { user } = render(<GitActionButton featureId={42} projectId={7} />);
    act(() => git.setStatus({ ...snapshot, computed_at: 2 }, "inotify limit"));
    await user.click(screen.getByRole("button", { name: "Git live updates unavailable" }));
    expect(screen.getByText(/inotify limit/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Commit" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Retry Git status" }));
    expect(useGitStatusStore.getState().watcherEpoch[42]).toBe(1);
    act(() => git.setStatus({ ...snapshot, computed_at: 3 }, null));
    expect(screen.queryByText(/inotify limit/)).not.toBeInTheDocument();
  });
});

describe("GitActionButton shortcuts", () => {
  it("replaces Commit with a clickable Committing progress control", async () => {
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    useCommitOutputStore.getState().start(42);

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    const progressButton = screen.getByRole("button", { name: "Committing" });
    expect(progressButton).toBeEnabled();
    expect(progressButton.querySelector(".animate-spin")).not.toBeNull();
    await user.click(progressButton);

    expect(await screen.findByRole("dialog", { name: "Commit progress" })).toBeInTheDocument();
  });

  it("keeps failed background output discoverable from the primary action", async () => {
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    const store = useCommitOutputStore.getState();
    store.start(42);
    store.append(42, "pre-commit failed\n");
    store.complete(42, false);

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    await user.click(screen.getByRole("button", { name: "Commit failed" }));
    expect(await screen.findByRole("dialog", { name: "Commit progress" })).toBeInTheDocument();
  });

  it("keeps the Git actions menu available on mobile while committing", async () => {
    buttonMocks.isMobile = true;
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    useCommitOutputStore.getState().start(42);

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    expect(screen.getByRole("button", { name: "Committing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More git actions" }));

    expect(await screen.findByText("View commit progress")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
  });

  it("names the checked-out branch on the mobile trigger", () => {
    buttonMocks.isMobile = true;
    useGitStatusStore.getState().setStatus(makeMergeableSnapshot(42));

    render(<GitActionButton featureId={42} projectId={7} />);

    const trigger = screen.getByRole("button", { name: /^Git actions, on / });
    expect(trigger).toHaveTextContent(useGitStatusStore.getState().byFeature[42]!.current_branch);
  });

  it("replaces the primary action with a clickable Pushing control", async () => {
    useGitStatusStore.getState().setStatus({ ...makeMergeableSnapshot(42), ahead_of_remote: 2 });
    usePushOutputStore.getState().start(42);

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    const progressButton = screen.getByRole("button", { name: "Pushing" });
    expect(progressButton.querySelector(".animate-spin")).not.toBeNull();
    await user.click(progressButton);

    expect(await screen.findByRole("dialog", { name: "Push progress" })).toBeInTheDocument();
  });

  it("keeps a backgrounded push failure reachable once the snapshot says nothing to push", async () => {
    // Post-failure the branch may look identical to a clean one; the run
    // still has to be reachable or its output is lost.
    useGitStatusStore.getState().setStatus(makeMergeableSnapshot(42));
    const store = usePushOutputStore.getState();
    store.start(42);
    store.append(42, "! [rejected]\n");
    store.complete(42, false);

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    await user.click(screen.getByRole("button", { name: "Push failed" }));
    expect(await screen.findByRole("dialog", { name: "Push progress" })).toBeInTheDocument();
  });

  it("prefers commit over push when both are running", () => {
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    useCommitOutputStore.getState().start(42);
    usePushOutputStore.getState().start(42);

    render(<GitActionButton featureId={42} projectId={7} />);

    expect(screen.getByRole("button", { name: "Committing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pushing" })).not.toBeInTheDocument();
  });

  it("opens git actions with Cmd+G while an input is focused", async () => {
    useGitStatusStore.getState().setStatus(makeMergeableSnapshot(42));

    const { user } = render(
      <>
        <input aria-label="Focused input" />
        <GitActionButton featureId={42} projectId={7} />
      </>,
    );

    screen.getByLabelText("Focused input").focus();
    await user.keyboard("{Meta>}G{/Meta}");

    expect(await screen.findByPlaceholderText("Search git actions…")).toBeInTheDocument();
  });

  it("shows a Git actions shortcut tooltip on hover", async () => {
    useGitStatusStore.getState().setStatus(makeMergeableSnapshot(42));

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    await user.hover(screen.getByRole("button", { name: /more git actions/i }));

    expect(await screen.findByText("Git actions")).toBeInTheDocument();
  });

  it("allows merge from the menu when the source worktree has uncommitted changes", async () => {
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    await user.click(await screen.findByText("Merge"));

    expect(await screen.findByRole("dialog", { name: "Merge branch" })).toBeInTheDocument();
  });

  it("opens the lazy controlled Stash dialog without replacing Commit as primary", async () => {
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    expect(screen.getByRole("button", { name: "Commit" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    await user.click(await screen.findByText("Stash changes"));

    expect(await screen.findByRole("dialog", { name: "Stash changes" })).toBeInTheDocument();
  });

  it("allows an untracked-only worktree to open Stash while keeping Commit primary", async () => {
    useGitStatusStore.getState().setStatus({
      ...makeMergeableSnapshot(42),
      uncommitted_count: 1,
      untracked_count: 1,
    });
    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    expect(screen.getByRole("button", { name: "Commit" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    const stashItem = (await screen.findByText("Stash changes")).closest("[cmdk-item]");
    expect(stashItem).toHaveAttribute("aria-disabled", "false");
    await user.click(screen.getByText("Stash changes"));

    expect(await screen.findByRole("dialog", { name: "Stash changes" })).toBeInTheDocument();
  });

  it("shows the row-operation reason and blocks opening Stash", async () => {
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    const coordinator = renderHook(() => useStashMutationCoordinator(42));
    act(() => {
      coordinator.result.current.tryAcquire({
        kind: "row",
        operation: "apply",
        stashRefName: "stash@{0}",
      });
    });
    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    const stashItem = (await screen.findByText("Stash changes")).closest("[cmdk-item]");
    expect(stashItem).toHaveAttribute("aria-disabled", "true");
    expect(stashItem).toHaveAttribute("title", "Apply stash@{0} in progress");
    await user.click(screen.getByText("Stash changes"));
    expect(screen.queryByRole("dialog", { name: "Stash changes" })).not.toBeInTheDocument();
  });

  it("opens the distinct Update dialog without changing finish-branch Merge", async () => {
    useGitStatusStore.getState().setStatus({
      ...makeMergeableSnapshot(42),
      behind_target: 3,
    });

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    expect(await screen.findByText("Merge")).toBeInTheDocument();
    const actionPicker = screen.getByPlaceholderText("Search git actions…").closest("[cmdk-root]");
    expect(actionPicker).not.toBeNull();
    await user.click(within(actionPicker as HTMLElement).getByText("Update"));

    expect(
      await screen.findByRole("dialog", { name: "Update current branch" }),
    ).toBeInTheDocument();
  });

  it("reaches the exact target selector through the branch chip in the Git actions menu", async () => {
    useGitStatusStore.getState().setStatus({
      ...makeMergeableSnapshot(42),
      behind_target: 3,
    });

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);
    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    await user.click(await screen.findByRole("button", { name: /^Branch feature\/test/ }));

    expect(
      await screen.findByRole("button", { name: "Change target of feature/test" }),
    ).toHaveTextContent("origin/main");
  });

  it("shows Continue and Abort actions while a rebase is active", async () => {
    useGitStatusStore.getState().setStatus({
      ...makeDirtyMergeableSnapshot(42),
      operation: "rebase",
      conflict_count: 1,
    });

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);
    await user.click(screen.getByRole("button", { name: /more git actions/i }));

    expect(await screen.findByText("Continue rebase")).toBeInTheDocument();
    expect(screen.getByText("Abort rebase")).toBeInTheDocument();
    expect(screen.getByText("Resolve and stage 1 conflicting file first")).toBeInTheDocument();
  });

  it("shows visible update activity and disables conflicting actions while pending", async () => {
    buttonMocks.updatePending = true;
    useGitStatusStore.getState().setStatus({
      ...makeMergeableSnapshot(42),
      behind_target: 3,
    });

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    const activity = screen.getByRole("button", { name: "Updating…" });
    expect(activity).toBeDisabled();
    expect(activity.querySelector(".animate-spin")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /more git actions/i }));
    expect(screen.getAllByText("Update request in progress").length).toBeGreaterThan(0);
  });
});
