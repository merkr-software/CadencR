// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UnifiedAgentEntry } from "@/api/generated";
import { useStableAgentOrder } from "@/components/useStableAgentOrder";

function agent(id: number, state = "idle"): UnifiedAgentEntry {
  return {
    agent_created_at: "2026-03-04T23:00:00Z",
    feature: { created_at: "2026-03-04 23:00:00", id, title: `Agent ${id}`, type: "feature" },
    is_pinned: false,
    last_activity_at: state,
    project: { id: 1, name: "Project", path: "/tmp/project" },
    session: {
      agentType: "codex",
      blocks: [],
      hasFileChanges: false,
      hasMore: false,
      inputTokens: 0,
      isIncremental: false,
      maxMessageId: 0,
      outputTokens: 0,
      permissionMode: "default",
      accessMode: "default",
      resumable: false,
      sessionDbId: id,
      status: "completed",
      wasCompacted: false,
    },
  };
}

// The tests carry the "state" in `last_activity_at` so the signature sees it.
const signatureOf = (entry: UnifiedAgentEntry): string => entry.last_activity_at ?? "";
const idsOf = (entries: UnifiedAgentEntry[]): number[] =>
  entries.map((entry) => entry.session.sessionDbId);

function setup(initial: UnifiedAgentEntry[], resetKey = "k") {
  return renderHook(
    ({ sorted, key }: { sorted: UnifiedAgentEntry[]; key: string }) =>
      useStableAgentOrder(sorted, signatureOf, key, true),
    { initialProps: { sorted: initial, key: resetKey } },
  );
}

describe("useStableAgentOrder", () => {
  it("keeps cards in place when the sorted order changes, and counts what moved", () => {
    const { result, rerender } = setup([agent(1), agent(2), agent(3)]);
    rerender({ sorted: [agent(3, "working"), agent(1), agent(2)], key: "k" });

    expect(idsOf(result.current.agents)).toEqual([1, 2, 3]);
    expect(result.current.pendingChanges).toBe(1);
  });

  it("adopts the sorted order on re-sort", () => {
    const { result, rerender } = setup([agent(1), agent(2), agent(3)]);
    rerender({ sorted: [agent(3, "working"), agent(1), agent(2)], key: "k" });
    act(() => result.current.resort());

    expect(idsOf(result.current.agents)).toEqual([3, 1, 2]);
    expect(result.current.pendingChanges).toBe(0);
  });

  it("appends new agents and drops removed ones without reordering the rest", () => {
    const { result, rerender } = setup([agent(1), agent(2), agent(3)]);
    rerender({ sorted: [agent(4, "working"), agent(3), agent(1)], key: "k" });

    expect(idsOf(result.current.agents)).toEqual([1, 3, 4]);
    expect(result.current.pendingChanges).toBe(1);
  });

  it("re-takes the order when the filter changes", () => {
    const { result, rerender } = setup([agent(1), agent(2)]);
    rerender({ sorted: [agent(2), agent(1)], key: "other" });

    expect(idsOf(result.current.agents)).toEqual([2, 1]);
    expect(result.current.pendingChanges).toBe(0);
  });

  it("hands back the sorted list itself while the order holds", () => {
    const sorted = [agent(1), agent(2)];
    const { result, rerender } = setup(sorted);
    const next = [agent(1, "working"), agent(2)];
    rerender({ sorted: next, key: "k" });

    expect(result.current.agents).toBe(next);
  });

  it("stays silent when the order drifts without any signature changing", () => {
    const first = agent(1);
    const second = agent(2);
    const { result, rerender } = setup([first, second]);
    rerender({ sorted: [second, first], key: "k" });

    expect(idsOf(result.current.agents)).toEqual([1, 2]);
    expect(result.current.pendingChanges).toBe(0);
  });
});
