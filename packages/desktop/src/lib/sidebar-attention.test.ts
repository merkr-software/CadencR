import { describe, expect, it } from "vitest";
import { deriveAttention } from "./sidebar-attention";

const row = (featureId: number, status: "idle" | "agent" | "question", isUnread = false) => ({
  featureId,
  status,
  mark: isUnread ? ("unread" as const) : ("none" as const),
});

describe("deriveAttention", () => {
  it("ranks a pending request over work over an unread reply", () => {
    expect(deriveAttention(row(1, "agent", true))).toEqual({
      state: "working",
      sourceFeatureId: 1,
    });
    expect(deriveAttention(row(1, "idle", true)).state).toBe("unread");
    expect(deriveAttention(row(1, "idle")).state).toBe("idle");
    expect(deriveAttention(row(1, "question", true)).state).toBe("waiting");
  });

  it("surfaces the most urgent hidden child, naming where it comes from", () => {
    expect(deriveAttention(row(1, "agent"), [row(2, "idle", true), row(3, "question")])).toEqual({
      state: "waiting",
      sourceFeatureId: 3,
    });
  });

  it("keeps the row itself on a tie", () => {
    expect(deriveAttention(row(1, "agent"), [row(2, "agent")]).sourceFeatureId).toBe(1);
  });

  it("puts an unseen failure above work and below a pending request", () => {
    const failed = { featureId: 2, status: "idle" as const, mark: "failed" as const };
    expect(deriveAttention(failed).state).toBe("failed");
    expect(deriveAttention(row(1, "agent"), [failed])).toEqual({
      state: "failed",
      sourceFeatureId: 2,
    });
    expect(deriveAttention(row(1, "question"), [failed]).state).toBe("waiting");
  });
});
