import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test-utils";
import type { PrMergeStatus, PrSummary } from "@/api/generated";
import { PrMergeBar } from "./PrMergeBar";

const mergeMutate = vi.fn();
const cancelMutate = vi.fn();

vi.mock("@/api/generated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/generated")>();
  return {
    ...actual,
    usePostPrMerge: () => ({ mutateAsync: mergeMutate, isPending: false }),
    useDeletePrMerge: () => ({ mutateAsync: cancelMutate, isPending: false }),
  };
});

const pr: PrSummary = {
  author: { username: "me" },
  body_markdown: "",
  head_sha: "abc",
  number: 42,
  pr_label: "Pull request",
  review_state: "none",
  source_branch: "feature/x",
  state: "open",
  target_branch: "main",
  title: "Ship it",
  updated_at: "2026-10-31T00:00:00Z",
  url: "https://example.test/pr/42",
};

function status(overrides: Partial<PrMergeStatus> = {}): PrMergeStatus {
  return {
    pr_number: 42,
    head_sha: "abc123",
    approvals: { reviewers: [], approved_count: 0, required: null, satisfied: null },
    readiness: "ready",
    reasons: [],
    can_merge: true,
    methods: ["squash", "merge"],
    default_method: "squash",
    actions: ["merge"],
    cancellable: false,
    delete_source_branch: { default: false, configurable: true, deferred: false },
    fetched_at: 1,
    ...overrides,
  };
}

function bar(
  merge: PrMergeStatus | undefined,
  extra: { isLoading?: boolean; error?: string } = {},
) {
  return (
    <PrMergeBar
      featureId={7}
      pr={pr}
      status={merge}
      isLoading={extra.isLoading ?? false}
      error={extra.error ?? null}
      onRefetch={vi.fn()}
    />
  );
}

describe("PrMergeBar", () => {
  beforeEach(() => {
    mergeMutate.mockReset();
    cancelMutate.mockReset();
  });

  it("shows a loading line while the forge is asked", () => {
    render(bar(undefined, { isLoading: true }));
    expect(screen.getByText("Checking merge status…")).toBeInTheDocument();
  });

  it("surfaces a failed status read with a retry", () => {
    render(bar(undefined, { error: "Forge rate limit reached" }));
    expect(screen.getByText("Forge rate limit reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry merge status" })).toBeInTheDocument();
  });

  it("confirms before merging and sends the chosen method and head", async () => {
    mergeMutate.mockResolvedValue({ outcome: "merged", warning: null });
    render(bar(status()));
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }));
    // Nothing is sent until the dialog is confirmed.
    expect(mergeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /Create a merge commit/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Create a merge commit/ }));
    await waitFor(() => expect(mergeMutate).toHaveBeenCalledTimes(1));
    expect(mergeMutate).toHaveBeenCalledWith({
      data: {
        feature_id: 7,
        pr_number: 42,
        action: "merge",
        method: "merge",
        delete_source_branch: true,
        expected_head_sha: "abc123",
      },
    });
  });

  it("never merges a head pushed after the dialog opened without a new confirmation", async () => {
    mergeMutate.mockResolvedValue({ outcome: "merged", warning: null });
    const { rerender } = render(bar(status()));
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }));
    rerender(bar(status({ head_sha: "def4567890" })));
    const confirm = screen.getByRole("button", { name: /Squash and merge/ });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/New commits were pushed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use the new head" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(mergeMutate).toHaveBeenCalledTimes(1));
    expect(mergeMutate.mock.calls[0]?.[0].data.expected_head_sha).toBe("def4567890");
  });

  it("keeps the last status on screen but flags a failed refresh", () => {
    render(bar(status(), { error: "Forge rate limit reached" }));
    expect(screen.getByText("Ready to merge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry merge status" })).toBeInTheDocument();
  });

  it("hides the branch clean-up the forge cannot carry to a later merge", () => {
    render(bar(status({ readiness: "blocked", actions: ["auto_merge"] })));
    fireEvent.click(screen.getByRole("button", { name: "Merge when ready" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps the dialog open with the forge's refusal", async () => {
    mergeMutate.mockRejectedValue(new Error("Pull Request is not mergeable"));
    render(bar(status()));
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Squash and merge/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("names merge trains and offers to leave them", async () => {
    cancelMutate.mockResolvedValue({ cancelled: true });
    render(
      bar(
        status({
          queue: "merge_train",
          queue_entry: { ahead: 2 },
          actions: [],
          cancellable: true,
        }),
      ),
    );
    expect(screen.getByText("In the merge train · 2 ahead")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove from merge train" }));
    await waitFor(() =>
      expect(cancelMutate).toHaveBeenCalledWith({ params: { feature_id: 7, pr_number: 42 } }),
    );
  });

  it("explains a missing button when the viewer cannot merge", () => {
    render(
      bar(
        status({
          can_merge: false,
          actions: [],
          readiness: "conflicts",
          reasons: ["Conflicts with the target branch must be resolved"],
        }),
      ),
    );
    // The blocker stays visible next to the permission note.
    expect(
      screen.getByText(
        "Conflicts with the target branch must be resolved · You don't have permission to merge into the target.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Merge$/ })).not.toBeInTheDocument();
  });

  it("offers the queue action on merge-queue branches", () => {
    render(
      bar(
        status({
          queue: "merge_queue",
          actions: ["enqueue_when_ready"],
          readiness: "blocked",
          reasons: ["Required checks are still running"],
        }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Add to merge queue when ready" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Required checks are still running")).toBeInTheDocument();
  });
});
