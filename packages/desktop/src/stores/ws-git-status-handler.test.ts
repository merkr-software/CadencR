import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import {
  handleGitEnvelope,
  parseGitStatusSnapshot,
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
import { getGetFileBlobShasQueryKey } from "@/api/generated";
import { getInvalidatePredicate } from "@/test-utils";

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
  action_label: "Open PR",
  computed_at: 1_700_000_000_000,
};

beforeEach(() => {
  resetGitInvalidationSchedulingForTest();
  useGitStatusStore.setState({ byFeature: {}, errorByFeature: {} });
  useCommitOutputStore.setState({ byFeature: {} });
  usePushOutputStore.setState({ byFeature: {} });
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

describe("handleGitEnvelope", () => {
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
    expect(toast.error).toHaveBeenCalledWith("Git status error: fatal: not a git repo");
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
