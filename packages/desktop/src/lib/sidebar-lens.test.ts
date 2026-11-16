import { describe, expect, it } from "vitest";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import {
  groupConversations,
  sortConversations,
  type LensContext,
  type LensGroup,
} from "@/lib/sidebar-lens";

const NOW = new Date(2026, 9, 12, 15, 0).getTime();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function feature(id: number, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    project_id: 1,
    title: `Conversation ${id}`,
    status: "active",
    type: "ws-session",
    is_pinned: false,
    created_at: hoursAgo(1000 - id),
    last_activity_at: hoursAgo(id),
    ...overrides,
  };
}

function worktree(featureId: number, branch: string, main = false): FeatureWorktreeInfo {
  return {
    feature_id: featureId,
    worktree_path: `/tmp/${branch}`,
    worktree_branch: branch,
    is_main_worktree: main,
    is_default_branch: main,
    live: true,
    directory_exists: true,
    branch_exists: true,
  };
}

const context = (overrides: Partial<LensContext> = {}): LensContext => ({
  stateOf: () => "idle",
  worktreeOf: () => undefined,
  now: NOW,
  ...overrides,
});

const summary = (groups: readonly LensGroup[]) =>
  groups.map((group) => [group.value, group.features.map((f) => f.id)]);

describe("groupConversations", () => {
  it("groups by status, most urgent first, leaving empty states out", () => {
    const states: Record<number, "waiting" | "unread" | "idle"> = { 1: "unread", 2: "waiting" };
    const groups = groupConversations([feature(1), feature(2), feature(3)], "status", {
      ...context(),
      stateOf: (id) => states[id] ?? "idle",
    });
    expect(summary(groups)).toEqual([
      ["waiting", [2]],
      ["unread", [1]],
      ["idle", [3]],
    ]);
  });

  it("groups by worktree branch, the project checkout last", () => {
    const worktrees = new Map([
      [1, worktree(1, "fix-login")],
      [2, worktree(2, "main", true)],
      [3, worktree(3, "fix-login")],
    ]);
    const groups = groupConversations(
      [feature(1), feature(2), feature(3), feature(4)],
      "worktree",
      context({ worktreeOf: (id) => worktrees.get(id) }),
    );
    expect(summary(groups)).toEqual([
      ["fix-login", [1, 3]],
      [null, [2, 4]],
    ]);
  });

  it("groups by provider and by label, in the order of their newest conversation", () => {
    const features = [
      feature(1, { runtime_provider: "codex", label: "Bug" }),
      feature(2, { runtime_provider: "claude_code" }),
      feature(3, { runtime_provider: "codex", label: " Bug " }),
    ];
    expect(summary(groupConversations(features, "provider", context()))).toEqual([
      ["codex", [1, 3]],
      ["claude_code", [2]],
    ]);
    expect(summary(groupConversations(features, "label", context()))).toEqual([
      ["Bug", [1, 3]],
      [null, [2]],
    ]);
  });

  it("groups by last activity: today, yesterday, this week, older", () => {
    const features = [
      feature(1, { last_activity_at: hoursAgo(2) }),
      feature(2, { last_activity_at: hoursAgo(20) }),
      feature(3, { last_activity_at: hoursAgo(24 * 4) }),
      feature(4, { last_activity_at: hoursAgo(24 * 30) }),
    ];
    expect(summary(groupConversations(features, "date", context()))).toEqual([
      ["today", [1]],
      ["yesterday", [2]],
      ["week", [3]],
      ["older", [4]],
    ]);
  });

  it("reads SQLite's UTC timestamps (no zone suffix) when bucketing by date", () => {
    const startOfToday = new Date(NOW).setHours(0, 0, 0, 0);
    const sqlite = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const features = [
      feature(1, { last_activity_at: sqlite(startOfToday + 10 * 60_000) }),
      feature(2, { last_activity_at: sqlite(startOfToday - 10 * 60_000) }),
    ];
    expect(summary(groupConversations(features, "date", context()))).toEqual([
      ["today", [1]],
      ["yesterday", [2]],
    ]);
  });

  it("names a detached worktree by its folder", () => {
    const detached = { ...worktree(1, "x"), worktree_branch: null, worktree_path: "/tmp/wt-42" };
    const groups = groupConversations(
      [feature(1)],
      "worktree",
      context({ worktreeOf: () => detached }),
    );
    expect(summary(groups)).toEqual([["wt-42", [1]]]);
  });

  it("puts everything in one group for the flat list", () => {
    expect(summary(groupConversations([feature(1), feature(2)], "flat", context()))).toEqual([
      ["all", [1, 2]],
    ]);
  });
});

describe("sortConversations", () => {
  const features = [
    feature(1, { title: "beta", created_at: hoursAgo(5) }),
    feature(2, { title: "Alpha 10", created_at: hoursAgo(1) }),
    feature(3, { title: "alpha 9", created_at: hoursAgo(3) }),
  ];

  it("keeps the given activity order", () => {
    expect(sortConversations(features, "activity", [])).toBe(features);
  });

  it("sorts by creation, newest first", () => {
    expect(sortConversations(features, "created", []).map((f) => f.id)).toEqual([2, 3, 1]);
  });

  it("sorts by title, ignoring case and reading numbers as numbers", () => {
    expect(sortConversations(features, "title", []).map((f) => f.id)).toEqual([3, 2, 1]);
  });

  it("follows the manual rank, unranked conversations first in their given order", () => {
    expect(sortConversations(features, "manual", [1, 3]).map((f) => f.id)).toEqual([2, 1, 3]);
  });
});
