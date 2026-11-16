import { describe, expect, it } from "vitest";
import type { AgentActivityDigestEntry } from "@/api/generated";
import {
  aggregateFeatureStatuses,
  composeNotchSnapshot,
  NOTCH_DONE_TTL_MS,
  notchTrackedFeatureIds,
  type FeatureLiveStatus,
  type NotchComposeInput,
} from "./notch-snapshot";

const NOW = 1_800_000_000_000;

function digest(
  featureId: number,
  extra: Partial<AgentActivityDigestEntry> = {},
): AgentActivityDigestEntry {
  return {
    feature_id: featureId,
    project_id: 9,
    project_name: "cadencr",
    feature_title: `Feature ${featureId}`,
    provider: "claude_code",
    last_tool: { name: "Bash", args: '{"command":"pnpm test"}' },
    last_reply: "All **green**.",
    last_activity_at: "2026-10-11T10:00:00Z",
    ...extra,
  };
}

function input(overrides: Partial<NotchComposeInput>): NotchComposeInput {
  return {
    live: new Map(),
    finishedAt: {},
    unread: {},
    dismissedAt: {},
    digest: [],
    provider: (id) => (id ? { label: "Claude", iconSrc: "/claude.png", mono: true } : null),
    now: NOW,
    ...overrides,
  };
}

const running: FeatureLiveStatus = { status: "agent", kind: null, turnStartedAtMs: NOW - 5_000 };

describe("aggregateFeatureStatuses", () => {
  it("lets a waiting session win over a working one in the same feature", () => {
    const byFeature = aggregateFeatureStatuses({
      1: { featureId: 7, status: "agent", kind: null, turnStartedAtMs: 10 },
      2: { featureId: 7, status: "question", kind: "permission" },
      3: { featureId: 8, status: "idle", kind: null },
    });
    expect(byFeature.get(7)).toEqual({
      status: "question",
      kind: "permission",
      turnStartedAtMs: null,
    });
    expect(byFeature.get(8)?.status).toBe("idle");
  });
});

describe("notchTrackedFeatureIds", () => {
  it("tracks working agents, unread finishes and recent finishes, but not stale or dismissed ones", () => {
    const ids = notchTrackedFeatureIds({
      live: new Map([[1, running]]),
      finishedAt: { 2: NOW - 60_000, 3: NOW - NOTCH_DONE_TTL_MS - 1, 4: NOW - 1_000, 5: NOW - 10 },
      unread: { 3: true },
      dismissedAt: { 4: NOW },
      now: NOW,
    });
    expect(ids).toEqual([1, 3, 5, 2]);
  });

  it("re-lists a dismissed agent that finished again", () => {
    const ids = notchTrackedFeatureIds({
      live: new Map(),
      finishedAt: { 4: NOW },
      unread: {},
      dismissedAt: { 4: NOW - 1_000 },
      now: NOW,
    });
    expect(ids).toEqual([4]);
  });
});

describe("composeNotchSnapshot", () => {
  it("orders by attention and maps digest entries to island agents", () => {
    const snapshot = composeNotchSnapshot(
      input({
        live: new Map<number, FeatureLiveStatus>([
          [1, running],
          [2, { status: "question", kind: "question", turnStartedAtMs: null }],
        ]),
        finishedAt: { 3: NOW - 2_000 },
        unread: { 3: true },
        digest: [digest(3), digest(1), digest(2)],
      }),
    );
    expect(snapshot.agents.map((a) => [a.featureId, a.status])).toEqual([
      [2, "question"],
      [3, "done"],
      [1, "running"],
    ]);
    const [question, done, working] = snapshot.agents;
    expect(question?.pendingKind).toBe("question");
    expect(working?.turnStartedAtMs).toBe(NOW - 5_000);
    expect(working?.lastAction).toEqual({ kind: "bash", label: "Running command: pnpm test" });
    expect(done).toMatchObject({
      unread: true,
      preview: "All green.",
      lastActivityAtMs: NOW - 2_000,
    });
    expect(done?.providerIconSrc).toBe("/claude.png");
  });

  it("puts what needs you first: permission, question, unread reply, working, read", () => {
    const waiting = (kind: "permission" | "question"): FeatureLiveStatus => ({
      status: "question",
      kind,
      turnStartedAtMs: null,
    });
    const at = (ms: number) => ({ last_activity_at: new Date(ms).toISOString() });
    const snapshot = composeNotchSnapshot(
      input({
        live: new Map<number, FeatureLiveStatus>([
          [1, running],
          [2, waiting("question")],
          [3, waiting("permission")],
          [4, waiting("permission")],
        ]),
        finishedAt: { 5: NOW - 9_000, 6: NOW - 1_000, 7: NOW - 3_000 },
        unread: { 5: true, 7: true },
        digest: [
          digest(1),
          digest(2),
          // Blocked longest comes first among equals.
          digest(3, at(NOW - 2_000)),
          digest(4, at(NOW - 60_000)),
          digest(5),
          digest(6),
          digest(7),
        ],
      }),
    );
    expect(snapshot.agents.map((a) => a.featureId)).toEqual([4, 3, 2, 7, 5, 1, 6]);
  });

  it("keeps unread replies over read ones when the finished list is capped", () => {
    const finishedAt = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [i + 1, NOW - (i + 1) * 1_000]),
    );
    const ids = notchTrackedFeatureIds({
      live: new Map(),
      finishedAt,
      unread: { 8: true },
      dismissedAt: {},
      now: NOW,
    });
    expect(ids[0]).toBe(8);
    expect(ids).toHaveLength(6);
  });

  it("drops digest entries the island no longer tracks", () => {
    const snapshot = composeNotchSnapshot(input({ digest: [digest(42)] }));
    expect(snapshot.agents).toEqual([]);
  });
});
