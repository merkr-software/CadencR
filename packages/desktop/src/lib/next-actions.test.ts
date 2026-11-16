import { describe, expect, it } from "vitest";
import type { CiState, PrState, PrStatusSnapshot, ReviewState } from "@/api/generated";
import type { AttentionEntry } from "@/lib/attention-index";
import { deriveNextActions, prActionKey, prActionKind } from "./next-actions";

interface PrInput {
  state?: PrState;
  review?: ReviewState;
  ci?: CiState | null;
  updatedAt?: string;
}

function pr(
  featureId: number,
  {
    state = "open",
    review = "none",
    ci = "none",
    updatedAt = "2026-10-01T00:00:00Z",
  }: PrInput = {},
): PrStatusSnapshot {
  return {
    feature_id: featureId,
    fetched_at: 1,
    setup_required: false,
    error: null,
    ci: ci == null ? null : { state: ci, checks: [] },
    pr: {
      number: featureId,
      title: `PR ${featureId}`,
      body_markdown: "",
      state,
      url: `https://forge.test/pr/${featureId}`,
      source_branch: `b${featureId}`,
      target_branch: "main",
      head_sha: "abc",
      review_state: review,
      author: { username: "me", display_name: null, avatar_url: null },
      updated_at: updatedAt,
      pr_label: "Pull request",
    },
  };
}

function byFeature(...snapshots: PrStatusSnapshot[]): Record<number, PrStatusSnapshot> {
  return Object.fromEntries(snapshots.map((snapshot) => [snapshot.feature_id, snapshot]));
}

/** `snapshot` plus another branch's proposal, as the poller publishes it. */
function withOther(snapshot: PrStatusSnapshot, other: PrStatusSnapshot): PrStatusSnapshot {
  return {
    ...snapshot,
    other_prs: [{ branch: other.pr!.source_branch, pr: other.pr!, ci: other.ci }],
  };
}

describe("prActionKind across a conversation's branches", () => {
  it("surfaces another branch's failing checks over the current branch's merge", () => {
    const current = pr(1, { review: "approved", ci: "passing" });
    const stacked = { ...pr(2, { ci: "failing" }), feature_id: 1 };
    const snapshot = withOther(current, stacked);
    expect(prActionKind(snapshot)).toBe("fix_ci");
    expect(prActionKey(snapshot)).toBe("fix_ci:2:abc");
  });

  it("asks about another branch even when the current branch has no proposal", () => {
    const snapshot = withOther({ ...pr(1), pr: null }, pr(2, { review: "changes_requested" }));
    expect(prActionKind(snapshot)).toBe("address_review");
  });

  it("does not let the current branch's forge error silence the others", () => {
    const snapshot = withOther({ ...pr(1, { ci: "failing" }), error: "rate limited" }, pr(2));
    expect(prActionKind(snapshot)).toBeNull();
    const stackedFailing = withOther({ ...pr(1), error: "rate limited" }, pr(2, { ci: "failing" }));
    expect(prActionKind(stackedFailing)).toBe("fix_ci");
  });
});

describe("prActionKind", () => {
  it("asks for nothing without an open pull request", () => {
    expect(prActionKind(undefined)).toBeNull();
    expect(prActionKind({ ...pr(1), pr: null })).toBeNull();
    expect(prActionKind(pr(1, { state: "merged", ci: "failing" }))).toBeNull();
    expect(prActionKind(pr(1, { state: "closed", review: "changes_requested" }))).toBeNull();
  });

  it("offers Merge only when the row's PR chip reads ready", () => {
    const approved = pr(1, { review: "approved", ci: "passing" });
    expect(prActionKind(approved)).toBe("merge");
    // Unresolved threads keep the chip yellow; a running check keeps it blocked.
    expect(prActionKind({ ...approved, unresolved_threads: 2 })).toBeNull();
    expect(prActionKind(pr(1, { review: "approved", ci: "running" }))).toBeNull();
  });

  it("asks nothing of a snapshot the forge failed to refresh", () => {
    expect(prActionKind({ ...pr(1, { ci: "failing" }), error: "rate limited" })).toBeNull();
  });

  it("puts failing checks before a requested change", () => {
    expect(prActionKind(pr(1, { ci: "failing", review: "changes_requested" }))).toBe("fix_ci");
    expect(prActionKind(pr(1, { review: "changes_requested", ci: "passing" }))).toBe(
      "address_review",
    );
  });

  it("offers a merge once approved and green (or without checks)", () => {
    expect(prActionKind(pr(1, { review: "approved", ci: "passing" }))).toBe("merge");
    expect(prActionKind(pr(1, { review: "approved", ci: "none" }))).toBe("merge");
    expect(prActionKind(pr(1, { review: "approved", ci: null }))).toBe("merge");
    expect(prActionKind(pr(1, { review: "approved", ci: "running" }))).toBeNull();
    expect(prActionKind(pr(1, { review: "pending", ci: "passing" }))).toBeNull();
  });

  it("lets a draft be fixed or addressed but never merged", () => {
    expect(prActionKind(pr(1, { state: "draft", ci: "failing" }))).toBe("fix_ci");
    expect(prActionKind(pr(1, { state: "draft", review: "changes_requested" }))).toBe(
      "address_review",
    );
    expect(prActionKind(pr(1, { state: "draft", review: "approved", ci: "passing" }))).toBeNull();
  });
});

describe("deriveNextActions", () => {
  it("lists tiers in order: waiting, failed, pull request blocked, review, merge", () => {
    const attention: AttentionEntry[] = [
      { featureId: 1, state: "waiting" },
      { featureId: 2, state: "failed" },
      { featureId: 3, state: "unread" },
    ];
    const prs = byFeature(
      pr(4, { review: "approved", ci: "passing" }),
      pr(5, { review: "changes_requested" }),
      pr(6, { ci: "failing" }),
    );
    expect(deriveNextActions(attention, prs)).toEqual([
      { featureId: 1, kind: "waiting" },
      { featureId: 2, kind: "failed" },
      { featureId: 5, kind: "address_review" },
      { featureId: 6, kind: "fix_ci" },
      { featureId: 3, kind: "review" },
      { featureId: 4, kind: "merge" },
    ]);
  });

  it("keeps oldest first within a tier", () => {
    const attention: AttentionEntry[] = [
      { featureId: 7, state: "waiting" },
      { featureId: 3, state: "waiting" },
      { featureId: 9, state: "unread" },
      { featureId: 8, state: "unread" },
    ];
    const prs = byFeature(
      pr(1, { ci: "failing", updatedAt: "2026-10-03T00:00:00Z" }),
      pr(2, { review: "changes_requested", updatedAt: "2026-10-01T00:00:00Z" }),
      pr(4, { review: "approved", updatedAt: "2026-10-05T00:00:00Z" }),
      pr(5, { review: "approved", updatedAt: "2026-10-02T00:00:00Z" }),
    );
    expect(deriveNextActions(attention, prs)).toEqual([
      { featureId: 7, kind: "waiting" },
      { featureId: 3, kind: "waiting" },
      { featureId: 2, kind: "address_review" },
      { featureId: 1, kind: "fix_ci" },
      { featureId: 9, kind: "review" },
      { featureId: 8, kind: "review" },
      { featureId: 5, kind: "merge" },
      { featureId: 4, kind: "merge" },
    ]);
  });

  it("gives a conversation one action, its most urgent", () => {
    const attention: AttentionEntry[] = [
      { featureId: 1, state: "waiting" },
      { featureId: 2, state: "failed" },
      { featureId: 3, state: "unread" },
      { featureId: 4, state: "unread" },
    ];
    const prs = byFeature(
      pr(1, { ci: "failing" }),
      pr(2, { review: "changes_requested" }),
      pr(3, { ci: "failing" }),
      pr(4, { review: "approved", ci: "passing" }),
    );
    expect(deriveNextActions(attention, prs)).toEqual([
      { featureId: 1, kind: "waiting" },
      { featureId: 2, kind: "failed" },
      { featureId: 3, kind: "fix_ci" },
      { featureId: 4, kind: "review" },
    ]);
  });

  it("leaves out a conversation whose agent is at work, pull request included", () => {
    const attention: AttentionEntry[] = [
      { featureId: 1, state: "working" },
      { featureId: 2, state: "unread" },
    ];
    const prs = byFeature(pr(1, { ci: "failing" }), pr(3, { review: "approved" }));
    expect(deriveNextActions(attention, prs)).toEqual([
      { featureId: 2, kind: "review" },
      { featureId: 3, kind: "merge" },
    ]);
  });

  it("ignores merged and closed pull requests", () => {
    const prs = byFeature(
      pr(1, { state: "merged", ci: "failing" }),
      pr(2, { state: "closed", review: "approved", ci: "passing" }),
    );
    expect(deriveNextActions([], prs)).toEqual([]);
  });

  it("never offers to merge a draft", () => {
    const prs = byFeature(
      pr(1, { state: "draft", review: "approved", ci: "passing" }),
      pr(2, { state: "draft", ci: "failing" }),
    );
    expect(deriveNextActions([], prs)).toEqual([{ featureId: 2, kind: "fix_ci" }]);
  });
});
