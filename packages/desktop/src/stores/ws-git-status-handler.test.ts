import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/ToastScope", () => ({
  scopedToastDescription: (scope: unknown, description?: unknown) => ({ scope, description }),
}));

import { toast } from "sonner";
import {
  handleGitEnvelope,
  parseGitStatusSnapshot,
  parsePrStatusSnapshot,
  resetGitInvalidationSchedulingForTest,
} from "./ws-git-status-handler";
import { useGitStatusStore } from "./useGitStatusStore";
import {
  selectCommitOutput,
  selectCommitOutcome,
  selectCommitRunning,
  useCommitOutputStore,
} from "./useCommitOutputStore";
import { selectPushOutput, selectPushRunning, usePushOutputStore } from "./usePushOutputStore";
import { queryClient } from "@/lib/queryClient";
import { getGetFileBlobShasQueryKey, getListStashesQueryKey } from "@/api/generated";
import { getInvalidatePredicate } from "@/test-utils";
import { usePrStatusStore } from "./usePrStatusStore";

const validSnapshot = {
  feature_id: 7,
  current_branch: "feature/foo",
  target_branch: "main",
  uncommitted_count: 3,
  staged_count: 1,
  unstaged_count: 1,
  untracked_count: 1,
  ahead_of_remote: 0,
  behind_remote: 0,
  ahead_of_target: 2,
  has_remote: true,
  host: "GitHub" as const,
  compare_url: "https://github.com/org/repo/compare/main...feature/foo",
  action_label: "Open pull request",
  computed_at: 1_700_000_000_000,
};

const validPrSnapshot = {
  feature_id: 7,
  fetched_at: 1_700_000_000_001,
  setup_required: false,
  error: null,
  pr: {
    number: 42,
    title: "Forge integration",
    body_markdown: "Ready",
    state: "open",
    url: "https://github.com/org/repo/pull/42",
    source_branch: "feature/foo",
    target_branch: "main",
    head_sha: "a".repeat(40),
    review_state: "pending",
    author: { username: "octocat", display_name: null, avatar_url: null },
    updated_at: "2026-07-23T10:00:00Z",
    pr_label: "Pull request",
  },
  ci: { state: "passing", checks: [] },
} as const;

beforeEach(() => {
  resetGitInvalidationSchedulingForTest();
  useGitStatusStore.setState({ byFeature: {}, errorByFeature: {} });
  useCommitOutputStore.setState({ byFeature: {} });
  usePushOutputStore.setState({ byFeature: {} });
  usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  resetGitInvalidationSchedulingForTest();
  vi.restoreAllMocks();
});

describe("parseGitStatusSnapshot", () => {
  it("accepts a fully-typed payload", () => {
    expect(parseGitStatusSnapshot(validSnapshot)).toEqual(validSnapshot);
  });

  it("rejects a payload with the wrong feature_id type", () => {
    expect(parseGitStatusSnapshot({ ...validSnapshot, feature_id: "7" })).toBeNull();
  });

  it("rejects a payload missing has_remote", () => {
    const { has_remote: _omit, ...rest } = validSnapshot;
    expect(parseGitStatusSnapshot(rest)).toBeNull();
  });
});

describe("parsePrStatusSnapshot", () => {
  it("accepts the neutral forge payload and rejects malformed timestamps", () => {
    expect(parsePrStatusSnapshot(validPrSnapshot)).toEqual(validPrSnapshot);
    expect(parsePrStatusSnapshot({ ...validPrSnapshot, fetched_at: "later" })).toBeNull();
  });

  it("rejects malformed nested PR and CI data", () => {
    expect(parsePrStatusSnapshot({ ...validPrSnapshot, pr: [] })).toBeNull();
    expect(
      parsePrStatusSnapshot({
        ...validPrSnapshot,
        ci: { state: "unknown", checks: [] },
      }),
    ).toBeNull();
  });
});

describe("handleGitEnvelope", () => {
  it("writes the first PR status without invalidating queries", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleGitEnvelope("pr_status", validPrSnapshot as unknown as Record<string, unknown>);

    expect(usePrStatusStore.getState().byFeature[7]).toEqual(validPrSnapshot);
    expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates comments only when the pull request was updated", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    usePrStatusStore
      .getState()
      .setStatus(validPrSnapshot as unknown as import("@/api/generated").PrStatusSnapshot);

    handleGitEnvelope("pr_status", {
      ...validPrSnapshot,
      fetched_at: validPrSnapshot.fetched_at + 1,
      pr: {
        ...validPrSnapshot.pr,
        updated_at: "2026-07-23T10:01:00Z",
      },
    } as unknown as Record<string, unknown>);

    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/git/pr/comments", { feature_id: 7 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/git/pr", { feature_id: 7 }] })).toBe(false);
    expect(predicate({ queryKey: ["/api/git/pr", { feature_id: 8 }] })).toBe(false);
  });

  it("surfaces malformed pull request updates", () => {
    handleGitEnvelope("pr_status", {
      ...validPrSnapshot,
      ci: { state: "invalid", checks: [] },
    } as unknown as Record<string, unknown>);

    expect(toast.error).toHaveBeenCalledWith("Invalid pull request status update received.");
  });

  it("writes the first valid status into the store without invalidating git queries", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleGitEnvelope("status", validSnapshot as Record<string, unknown>);

    expect(useGitStatusStore.getState().byFeature[7]).toEqual(validSnapshot);
    expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates git queries when an existing status meaningfully changes", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useGitStatusStore.getState().setStatus(validSnapshot);

    handleGitEnvelope("status", {
      ...validSnapshot,
      uncommitted_count: 4,
      computed_at: validSnapshot.computed_at + 1,
    } as Record<string, unknown>);

    expect(useGitStatusStore.getState().byFeature[7]?.uncommitted_count).toBe(4);
    expect(spy).toHaveBeenCalledOnce();
    // Working-tree churn cannot change history: the graph is left alone.
    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/git/diff", { feature_id: 7 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/git/commit-graph", { feature_id: 7 }] })).toBe(false);
  });

  it("refetches the commit graph when a push moves the remote counts", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useGitStatusStore.getState().setStatus({ ...validSnapshot, ahead_of_remote: 4 });

    handleGitEnvelope("status", {
      ...validSnapshot,
      ahead_of_remote: 0,
      computed_at: validSnapshot.computed_at + 1,
    } as Record<string, unknown>);

    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/git/commit-graph", { feature_id: 7 }] })).toBe(true);
  });

  it("invalidates stashes after a confirmed newer refresh with unchanged status", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useGitStatusStore.getState().setStatus(validSnapshot);

    handleGitEnvelope("status", {
      ...validSnapshot,
      computed_at: validSnapshot.computed_at + 1,
    } as Record<string, unknown>);

    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: getListStashesQueryKey({ feature_id: 7 }) })).toBe(true);
    expect(predicate({ queryKey: getListStashesQueryKey({ feature_id: 8 }) })).toBe(false);
  });

  it("invalidates git queries for a newer status event even when counts are unchanged", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useGitStatusStore.getState().setStatus(validSnapshot);

    handleGitEnvelope("status", {
      ...validSnapshot,
      computed_at: validSnapshot.computed_at + 1,
    } as Record<string, unknown>);

    expect(useGitStatusStore.getState().byFeature[7]?.computed_at).toBe(
      validSnapshot.computed_at + 1,
    );
    expect(spy).toHaveBeenCalledOnce();
    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/git/diff", { feature_id: 7 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/git/diff-image", { feature_id: 7 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/git/commit-log", { feature_id: 7 }] })).toBe(false);
  });

  it("coalesces a rapid burst of status pushes into one leading + one trailing refetch", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
      useGitStatusStore.getState().setStatus(validSnapshot);

      // Simulate a rebase storm: many snapshots arriving faster than the
      // settle window (backend caps them at ~1/sec; here we fire them tighter).
      for (let i = 1; i <= 10; i++) {
        vi.advanceTimersByTime(200);
        handleGitEnvelope("status", {
          ...validSnapshot,
          uncommitted_count: validSnapshot.uncommitted_count + i,
          computed_at: validSnapshot.computed_at + i,
        } as Record<string, unknown>);
      }

      // Only the leading edge has fired so far — the rest are still coalescing.
      expect(spy).toHaveBeenCalledTimes(1);
      // Store stays live throughout the burst (branch chip / counts).
      expect(useGitStatusStore.getState().byFeature[7]?.uncommitted_count).toBe(
        validSnapshot.uncommitted_count + 10,
      );

      // Let the churn settle → exactly one trailing refetch captures final state.
      vi.advanceTimersByTime(1_500);
      expect(spy).toHaveBeenCalledTimes(2);

      // No further churn → window closes, no extra invalidations.
      vi.advanceTimersByTime(5_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates cached blob SHAs for the changed feature so viewed files reset", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useGitStatusStore.getState().setStatus(validSnapshot);

    handleGitEnvelope("status", {
      ...validSnapshot,
      unstaged_count: 2,
      uncommitted_count: 4,
      computed_at: validSnapshot.computed_at + 1,
    } as Record<string, unknown>);

    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: getGetFileBlobShasQueryKey({ feature_id: 7 }) })).toBe(true);
    expect(predicate({ queryKey: getGetFileBlobShasQueryKey({ feature_id: 8 }) })).toBe(false);
  });

  it("ignores a malformed status payload (no store write, no toast)", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleGitEnvelope("status", { feature_id: "not-a-number" });

    expect(useGitStatusStore.getState().byFeature).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("writes errors and surfaces a toast on status_error", () => {
    handleGitEnvelope("status_error", { feature_id: 7, error: "fatal: not a git repo" });

    expect(useGitStatusStore.getState().errorByFeature[7]).toBe("fatal: not a git repo");
    expect(toast.error).toHaveBeenCalledWith("Git status error", {
      id: "git-status-error-7",
      description: { scope: { featureId: 7 }, description: "fatal: not a git repo" },
    });
  });

  it("clears any prior error when a fresh snapshot arrives", () => {
    useGitStatusStore.getState().setStatusError({ feature_id: 7, error: "boom" });
    expect(useGitStatusStore.getState().errorByFeature[7]).toBe("boom");

    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    handleGitEnvelope("status", validSnapshot as Record<string, unknown>);

    expect(useGitStatusStore.getState().errorByFeature[7]).toBeUndefined();
  });

  it("routes commit lifecycle envelopes into the commit output store", () => {
    handleGitEnvelope("commit.start", { feature_id: 7 });
    handleGitEnvelope("commit.output", { feature_id: 7, text: "pre-commit\n" });
    handleGitEnvelope("commit.output", { feature_id: 7, line: "created commit" });
    handleGitEnvelope("commit.complete", { feature_id: 7, success: false });

    const state = useCommitOutputStore.getState();
    expect(selectCommitOutput(7)(state)).toBe("pre-commit\ncreated commit\n");
    expect(selectCommitRunning(7)(state)).toBe(false);
    expect(selectCommitOutcome(7)(state)).toBe("error");
  });

  it("routes push lifecycle envelopes into the push output store", () => {
    handleGitEnvelope("push.start", { feature_id: 7 });
    handleGitEnvelope("push.output", { feature_id: 7, text: "Counting objects\n" });
    handleGitEnvelope("push.output", { feature_id: 7, line: "remote: ok" });
    handleGitEnvelope("push.complete", { feature_id: 7, success: true });

    const state = usePushOutputStore.getState();
    expect(selectPushOutput(7)(state)).toBe("Counting objects\nremote: ok\n");
    expect(selectPushRunning(7)(state)).toBe(false);
  });

  it("refetches the commit graph once a push succeeds, and only then", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleGitEnvelope("push.complete", { feature_id: 7, success: false });
    expect(spy).not.toHaveBeenCalled();

    handleGitEnvelope("push.complete", { feature_id: 7, success: true });
    expect(spy).toHaveBeenCalledOnce();
    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/git/commit-graph", { feature_id: 7 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/git/commit-log", { feature_id: 7 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/git/commit-graph", { feature_id: 8 }] })).toBe(false);
    expect(predicate({ queryKey: ["/api/git/diff", { feature_id: 7 }] })).toBe(false);
    // The status broadcast before it may already be refetching: join, never restart.
    expect(spy.mock.calls[0]?.[1]).toEqual({ cancelRefetch: false });
  });

  it("ignores a completion envelope without an explicit outcome", () => {
    handleGitEnvelope("commit.start", { feature_id: 7 });
    handleGitEnvelope("commit.complete", { feature_id: 7 });

    expect(selectCommitRunning(7)(useCommitOutputStore.getState())).toBe(true);
  });

  it("ignores malformed commit and push lifecycle payloads", () => {
    handleGitEnvelope("commit.start", { feature_id: "7" });
    handleGitEnvelope("commit.output", { feature_id: 7, text: 42 });
    handleGitEnvelope("commit.complete", { feature_id: null });
    handleGitEnvelope("push.start", { feature_id: "7" });
    handleGitEnvelope("push.output", { feature_id: 7, text: 42 });
    handleGitEnvelope("push.complete", { feature_id: null });

    expect(useCommitOutputStore.getState().byFeature).toEqual({});
    expect(usePushOutputStore.getState().byFeature).toEqual({});
  });
});
