import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { GitStatusSnapshot } from "@/api/generated";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import { useCommitOutputStore } from "@/stores/useCommitOutputStore";
import { GitActionButton } from "./GitActionButton";

const viewportMocks = vi.hoisted(() => ({ isMobile: false }));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => viewportMocks.isMobile,
}));

vi.mock("./MergeDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Merge branch" /> : null,
}));

vi.mock("./CommitDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Commit progress" /> : null,
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
  };
}

beforeEach(() => {
  viewportMocks.isMobile = false;
  useGitStatusStore.setState({ byFeature: {}, errorByFeature: {}, watcherEpoch: {} });
  useCommitOutputStore.setState({ byFeature: {} });
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
    viewportMocks.isMobile = true;
    useGitStatusStore.getState().setStatus(makeDirtyMergeableSnapshot(42));
    useCommitOutputStore.getState().start(42);

    const { user } = render(<GitActionButton featureId={42} projectId={7} />);

    expect(screen.getByRole("button", { name: "Committing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More git actions" }));

    expect(await screen.findByText("View commit progress")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
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
});
