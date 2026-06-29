import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnifiedAgentEntry } from "@/api/generated";
import {
  getUnifiedAgentsMatchingFilters,
  orderUnifiedAgentsForDisplay,
  pruneRedundantExcludedTitles,
  type UnifiedAgentFilterArgs,
} from "@/components/UnifiedAgentsViewData";

interface AgentOverrides {
  id?: number;
  projectId?: number;
  projectName?: string;
  title?: string;
  sessionStatus?: string;
  isPinned?: boolean;
  lastActivityAt?: string | null;
  agentCreatedAt?: string;
  pendingQuestions?: unknown;
  pendingPermission?: unknown;
}

const ALL_FILTERS: UnifiedAgentFilterArgs = {
  mode: "all",
  freshMinutes: 5,
  projectIds: [],
  excludedTitles: [],
  pinnedOnly: false,
  queryText: "",
  sortOrder: "created_desc",
};

function buildAgent(overrides: AgentOverrides = {}): UnifiedAgentEntry {
  const id = overrides.id ?? 1;
  const projectId = overrides.projectId ?? 1;
  return {
    agent_created_at:
      overrides.agentCreatedAt ?? `2026-03-04T23:${String(id).padStart(2, "0")}:00Z`,
    feature: {
      created_at: "2026-03-04 23:00:00",
      id,
      title: overrides.title ?? `Agent ${id}`,
      type: "feature",
    },
    is_pinned: overrides.isPinned ?? false,
    last_activity_at: overrides.lastActivityAt ?? "2026-03-04 23:20:00",
    project: {
      id: projectId,
      name: overrides.projectName ?? `Project ${projectId}`,
      path: `/tmp/project-${projectId}`,
    },
    session: {
      agentType: "codex",
      blocks: [],
      hasFileChanges: false,
      hasMore: false,
      inputTokens: 0,
      isIncremental: false,
      maxMessageId: 0,
      outputTokens: 0,
      pendingPermission: overrides.pendingPermission,
      pendingQuestions: overrides.pendingQuestions,
      permissionMode: "default",
      codexPermissionMode: "default",
      resumable: false,
      sessionDbId: id,
      status: overrides.sessionStatus ?? "completed",
      wasCompacted: false,
    },
  };
}

function ids(entries: UnifiedAgentEntry[]): number[] {
  return entries.map((entry: UnifiedAgentEntry): number => entry.session.sessionDbId);
}

describe("UnifiedAgentsViewData", () => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("orders pinned agents first without user filters", () => {
    const ordered = orderUnifiedAgentsForDisplay(
      [
        buildAgent({ id: 1 }),
        buildAgent({ id: 2, isPinned: true }),
        buildAgent({ id: 3, isPinned: true }),
        buildAgent({ id: 4, isPinned: true }),
        buildAgent({ id: 5 }),
      ],
      ALL_FILTERS,
    );

    expect(ids(ordered)).toEqual([4, 3, 2, 5, 1]);
  });

  it("can order created agents oldest first", () => {
    const ordered = orderUnifiedAgentsForDisplay(
      [buildAgent({ id: 1 }), buildAgent({ id: 2 }), buildAgent({ id: 3 })],
      { ...ALL_FILTERS, sortOrder: "created_asc" },
    );

    expect(ids(ordered)).toEqual([1, 2, 3]);
  });

  it("can order agents by latest message first", () => {
    const ordered = orderUnifiedAgentsForDisplay(
      [
        buildAgent({ id: 1, lastActivityAt: "2026-03-04T23:20:00Z" }),
        buildAgent({ id: 2, lastActivityAt: "2026-03-04T23:45:00Z" }),
        buildAgent({ id: 3, lastActivityAt: "2026-03-04T23:30:00Z" }),
      ],
      { ...ALL_FILTERS, sortOrder: "activity_desc" },
    );

    expect(ids(ordered)).toEqual([2, 3, 1]);
  });

  it("can order agents by oldest message first", () => {
    const ordered = orderUnifiedAgentsForDisplay(
      [
        buildAgent({ id: 1, lastActivityAt: "2026-03-04T23:20:00Z" }),
        buildAgent({ id: 2, lastActivityAt: "2026-03-04T23:45:00Z" }),
        buildAgent({ id: 3, lastActivityAt: "2026-03-04T23:30:00Z" }),
      ],
      { ...ALL_FILTERS, sortOrder: "activity_asc" },
    );

    expect(ids(ordered)).toEqual([1, 3, 2]);
  });

  it("places pinned extras last when a user project filter is active", () => {
    const ordered = orderUnifiedAgentsForDisplay(
      [
        buildAgent({ id: 1, projectId: 2, isPinned: true }),
        buildAgent({ id: 2, projectId: 1 }),
        buildAgent({ id: 3, projectId: 1, isPinned: true }),
        buildAgent({ id: 4, projectId: 3, isPinned: true }),
      ],
      { ...ALL_FILTERS, projectIds: [1] },
    );

    expect(ids(ordered)).toEqual([3, 2, 4, 1]);
  });

  it("hides agents whose title matches an excluded substring (case-insensitive)", () => {
    const ordered = orderUnifiedAgentsForDisplay(
      [
        buildAgent({ id: 1, title: "Auth login" }),
        buildAgent({ id: 2, title: "Docs update" }),
        buildAgent({ id: 3, title: "AUTH logout" }),
      ],
      { ...ALL_FILTERS, excludedTitles: ["auth"] },
    );

    expect(ids(ordered)).toEqual([2]);
  });

  it("excludes pinned agents too — exclude wins over the pinned-extras fallback", () => {
    const visible = getUnifiedAgentsMatchingFilters(
      [
        buildAgent({ id: 1, title: "Keep me" }),
        buildAgent({ id: 2, title: "Hide me", isPinned: true }),
      ],
      { ...ALL_FILTERS, excludedTitles: ["hide me"] },
    );

    expect(ids(visible)).toEqual([1]);
  });

  it("keeps pinned extras visible for text filters", () => {
    const visible = getUnifiedAgentsMatchingFilters(
      [
        buildAgent({ id: 1, title: "Matches query" }),
        buildAgent({ id: 2, title: "Pinned extra", isPinned: true }),
        buildAgent({ id: 3, title: "Pinned extra 2", isPinned: true }),
        buildAgent({ id: 4, title: "Other" }),
      ],
      { ...ALL_FILTERS, queryText: "matches" },
    );

    expect(ids(visible)).toEqual([1, 2, 3]);
  });

  it("includes recent running, pending, and fresh completed sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T23:30:00.000Z"));

    const visible = getUnifiedAgentsMatchingFilters(
      [
        buildAgent({ id: 1, sessionStatus: "running", lastActivityAt: "2026-03-04 20:00:00" }),
        buildAgent({ id: 2, pendingPermission: { id: 10 }, lastActivityAt: "2026-03-04 20:00:00" }),
        buildAgent({ id: 3, lastActivityAt: "2026-03-04 23:26:00" }),
        buildAgent({ id: 4, lastActivityAt: "2026-03-04 23:20:00" }),
      ],
      { ...ALL_FILTERS, mode: "recent", freshMinutes: 5 },
    );

    expect(ids(visible)).toEqual([1, 2, 3]);
  });

  it("keeps a stale-by-timestamp session visible when the live store marks it active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T23:30:00.000Z"));

    // REST says "completed" + last activity 3.5h ago, but the live WS
    // store flips it back to non-idle (e.g. the user just resumed it):
    // it must stay visible in the Recent grid.
    const visible = getUnifiedAgentsMatchingFilters(
      [
        buildAgent({ id: 1, sessionStatus: "completed", lastActivityAt: "2026-03-04 20:00:00" }),
        buildAgent({ id: 2, lastActivityAt: "2026-03-04 23:26:00" }),
      ],
      {
        ...ALL_FILTERS,
        mode: "recent",
        freshMinutes: 5,
        liveActiveSessionIds: new Set([1]),
      },
    );

    expect(ids(visible)).toEqual([1, 2]);
  });

  it("shows only pinned features when /pin is active", () => {
    const visible = getUnifiedAgentsMatchingFilters(
      [
        buildAgent({ id: 1, title: "Unpinned" }),
        buildAgent({ id: 2, title: "Pinned A", isPinned: true }),
        buildAgent({ id: 3, title: "Pinned B", isPinned: true }),
      ],
      { ...ALL_FILTERS, pinnedOnly: true },
    );

    expect(ids(visible)).toEqual([2, 3]);
  });

  it("prunes excluded titles whose only match aged out of the /last window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T23:30:00.000Z"));

    const entries = [
      // Fresh and currently hidden by "keep": the title is still doing work.
      buildAgent({ id: 1, title: "Keep me", lastActivityAt: "2026-03-04 23:28:00" }),
      // Stale: outside the 5-minute window, so "gone" no longer hides anything.
      buildAgent({ id: 2, title: "Gone agent", lastActivityAt: "2026-03-04 20:00:00" }),
    ];

    const pruned = pruneRedundantExcludedTitles(entries, {
      ...ALL_FILTERS,
      mode: "recent",
      freshMinutes: 5,
      excludedTitles: ["keep", "gone"],
    });

    expect(pruned).toEqual(["keep"]);
  });

  it("returns the same excluded-titles reference when nothing is redundant", () => {
    const excludedTitles = ["keep"];
    const pruned = pruneRedundantExcludedTitles([buildAgent({ id: 1, title: "Keep me" })], {
      ...ALL_FILTERS,
      excludedTitles,
    });

    expect(pruned).toBe(excludedTitles);
  });

  it("parses SQLite UTC timestamps consistently for recent filtering", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T23:30:00.000Z"));

    const visible = getUnifiedAgentsMatchingFilters(
      [
        buildAgent({ id: 1, lastActivityAt: "2026-03-04 23:25:33" }),
        buildAgent({ id: 2, lastActivityAt: "2026-03-04T23:24:59.000Z" }),
      ],
      { ...ALL_FILTERS, mode: "recent", freshMinutes: 5 },
    );

    expect(ids(visible)).toEqual([1]);
  });
});
