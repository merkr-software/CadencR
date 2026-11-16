import { describe, expect, it } from "vitest";
import { buildAttentionIndex, liveAttentionIds, markedAttentionIds } from "./attention-index";

const session = (featureId: number, status: "idle" | "agent" | "question", seq: number) => ({
  featureId,
  status,
  kind: null,
  seq,
});

describe("attention index", () => {
  it("queues waiting conversations by when their request arrived", () => {
    const live = liveAttentionIds({
      1: session(10, "question", 7),
      2: session(11, "question", 3),
      3: session(10, "question", 9),
      4: session(12, "agent", 1),
      5: session(11, "agent", 2),
    });
    expect(live).toEqual({ waiting: [11, 10], working: [12] });
  });

  it("orders failures and unread replies by when they were marked", () => {
    expect(
      markedAttentionIds({ 5: true }, { 3: true, 4: true, 5: true }, { 3: 9, 4: 2, 5: 1 }),
    ).toEqual({ failed: [5], unread: [4, 3] });
  });

  it("lists each conversation once, under its most urgent state", () => {
    const entries = buildAttentionIndex(
      { waiting: [2], working: [3, 4] },
      { failed: [3], unread: [2, 5] },
    );
    expect(entries).toEqual([
      { featureId: 2, state: "waiting" },
      { featureId: 3, state: "failed" },
      { featureId: 4, state: "working" },
      { featureId: 5, state: "unread" },
    ]);
  });
});
