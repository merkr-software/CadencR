import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitStatusSnapshot, PrStatusSnapshot, PrSummary } from "@/api/generated";
import { render, screen, within } from "@/test-utils";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

const mocks = vi.hoisted(() => ({
  updateTarget: vi.fn(),
  linkBranch: vi.fn(),
  unlinkBranch: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useListBranches: () => ({
    data: [
      { name: "main", is_local: true },
      { name: "develop", is_local: true },
    ],
    isLoading: false,
    isError: false,
    error: null,
  }),
  useUpdateTargetBranch: () => ({ mutateAsync: mocks.updateTarget }),
  useLinkFeatureBranch: () => ({ mutate: mocks.linkBranch, mutateAsync: mocks.linkBranch }),
  useUnlinkFeatureBranch: () => ({ mutate: mocks.unlinkBranch }),
}));

import { BranchChip } from "./BranchChip";

function status(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    feature_id: 7,
    current_branch: "fix/b",
    target_branch: "feature/a",
    uncommitted_count: 0,
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    ahead_of_remote: 0,
    behind_remote: 0,
    ahead_of_target: 2,
    behind_target: 1,
    has_remote: true,
    compare_url: null,
    action_label: null,
    computed_at: 1,
    thread_branches: [
      {
        name: "fix/b",
        origin: "agent",
        target_branch: "feature/a",
        is_current: true,
        last_seen_at: "2026-10-16T10:00:00.000Z",
      },
      { name: "feature/a", origin: "provisioned", target_branch: "main", is_current: false },
    ],
    ...overrides,
  };
}

function pr(number: number, branch: string, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number,
    title: `PR ${number}`,
    body_markdown: "",
    state: "open",
    url: `https://forge.test/pr/${number}`,
    source_branch: branch,
    target_branch: "main",
    head_sha: "abc",
    review_state: "none",
    author: { username: "me" },
    updated_at: "2026-10-16T00:00:00Z",
    pr_label: "Pull request",
    ...overrides,
  };
}

function prStatus(overrides: Partial<PrStatusSnapshot> = {}): PrStatusSnapshot {
  return {
    feature_id: 7,
    fetched_at: 1,
    setup_required: false,
    error: null,
    pr: pr(12, "fix/b"),
    ci: { state: "passing", checks: [] },
    other_prs: [
      {
        branch: "feature/a",
        pr: pr(10, "feature/a"),
        ci: { state: "failing", checks: [] },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.updateTarget.mockReset().mockResolvedValue({ success: true });
  mocks.linkBranch.mockReset().mockResolvedValue({ success: true });
  mocks.unlinkBranch.mockReset().mockResolvedValue({ success: true });
  useGitStatusStore.setState({ byFeature: {}, errorByFeature: {}, watcherEpoch: {} });
  usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
});

describe("BranchChip", () => {
  it("names only the current branch, with a count of the others", () => {
    useGitStatusStore.getState().setStatus(status());
    usePrStatusStore.getState().setStatus(prStatus());
    render(<BranchChip featureId={7} projectId={3} />);

    const chip = screen.getByRole("button", { name: /^Branch fix\/b/ });
    expect(chip).toHaveTextContent("fix/b");
    expect(chip).not.toHaveTextContent("feature/a");
    expect(chip).toHaveAttribute("title", "fix/b → feature/a");
    // The other branch's checks fail: the count says so before the panel opens.
    const others = chip.querySelector("[data-branch-chip-others]")!;
    expect(others).toHaveTextContent("+1");
    expect(others.className).toContain("--acc-red");
  });

  it("lists every branch with its own target and pull request", async () => {
    useGitStatusStore.getState().setStatus(status());
    usePrStatusStore.getState().setStatus(prStatus());
    const { user } = render(<BranchChip featureId={7} projectId={3} />);

    await user.click(screen.getByRole("button", { name: /^Branch fix\/b/ }));

    const rows = document.querySelectorAll("[data-thread-branch]");
    expect([...rows].map((row) => row.getAttribute("data-thread-branch"))).toEqual([
      "fix/b",
      "feature/a",
    ]);
    const current = within(rows[0] as HTMLElement);
    expect(current.getByText("current")).toBeInTheDocument();
    expect(current.getByText("↑2 ↓1")).toBeInTheDocument();
    expect(current.getByRole("button", { name: /^Open Pull request #12/ })).toBeInTheDocument();
    const original = within(rows[1] as HTMLElement);
    expect(original.getByRole("button", { name: "Change target of feature/a" })).toHaveTextContent(
      "main",
    );
    expect(original.getByRole("button", { name: /^Open Pull request #10/ })).toBeInTheDocument();
    // The branch the conversation was created on cannot be unlinked.
    expect(original.queryByRole("button", { name: "Unlink feature/a" })).toBeNull();
  });

  it("changes the target of the branch it was opened for", async () => {
    useGitStatusStore.getState().setStatus(status());
    const { user } = render(<BranchChip featureId={7} projectId={3} />);

    await user.click(screen.getByRole("button", { name: /^Branch fix\/b/ }));
    await user.click(screen.getByRole("button", { name: "Change target of feature/a" }));
    await user.click(screen.getByRole("button", { name: "Select local branch develop" }));

    expect(mocks.updateTarget).toHaveBeenCalledWith({
      id: 7,
      data: { target_branch: "develop", branch: "feature/a" },
    });
    expect(await screen.findByText("Conversation branches")).toBeInTheDocument();
  });

  it("unlinks a discovered branch", async () => {
    useGitStatusStore.getState().setStatus(status());
    const { user } = render(<BranchChip featureId={7} projectId={3} />);

    await user.click(screen.getByRole("button", { name: /^Branch fix\/b/ }));
    await user.click(screen.getByRole("button", { name: "Unlink fix/b" }));

    expect(mocks.unlinkBranch).toHaveBeenCalledWith({ id: 7, data: { branch: "fix/b" } });
  });

  it("names the checkout even when it is not one of the conversation's branches", async () => {
    useGitStatusStore.getState().setStatus(
      status({
        current_branch: "other/c",
        thread_branches: [
          { name: "feature/a", origin: "provisioned", target_branch: "main", is_current: true },
        ],
      }),
    );
    usePrStatusStore
      .getState()
      .setStatus(
        prStatus({ pr: pr(10, "feature/a"), ci: { state: "failing", checks: [] }, other_prs: [] }),
      );
    const { user } = render(<BranchChip featureId={7} projectId={3} />);

    const chip = screen.getByRole("button", { name: /^Branch other\/c/ });
    expect(chip).toHaveTextContent("other/c");
    expect(chip).toHaveAttribute(
      "title",
      "other/c (checked out, not one of this conversation's branches)",
    );
    // The dot is the checkout's proposal; the conversation's own is behind the count.
    expect(chip.querySelector("[data-branch-chip-pr]")).toBeNull();
    const others = chip.querySelector("[data-branch-chip-others]")!;
    expect(others).toHaveTextContent("+1");
    expect(others.className).toContain("--acc-red");

    await user.click(chip);
    const rows = document.querySelectorAll("[data-thread-checkout], [data-thread-branch]");
    expect(
      [...rows].map(
        (row) => row.getAttribute("data-thread-checkout") ?? row.getAttribute("data-thread-branch"),
      ),
    ).toEqual(["other/c", "feature/a"]);
    await user.click(screen.getByRole("button", { name: "Link other/c to this conversation" }));
    expect(mocks.linkBranch).toHaveBeenCalledWith({ id: 7, data: { branch: "other/c" } });
  });

  it("offers no link for a detached checkout", async () => {
    useGitStatusStore.getState().setStatus(
      status({
        current_branch: "(detached)",
        thread_branches: [
          { name: "feature/a", origin: "provisioned", target_branch: "main", is_current: true },
        ],
      }),
    );
    const { user } = render(<BranchChip featureId={7} projectId={3} />);

    await user.click(screen.getByRole("button", { name: /^Branch \(detached\)/ }));
    expect(screen.queryByRole("button", { name: /^Link \(detached\)/ })).toBeNull();
  });

  it("falls back to the live checkout when the snapshot lists no branches", () => {
    useGitStatusStore.getState().setStatus(status({ thread_branches: [] }));
    render(<BranchChip featureId={7} projectId={3} />);
    expect(
      screen.getByRole("button", { name: "Branch fix/b, 1 in this conversation" }),
    ).toBeVisible();
  });
});
