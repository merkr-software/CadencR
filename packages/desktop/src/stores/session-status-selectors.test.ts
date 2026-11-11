import { describe, expect, it } from "vitest";
import { isFeatureWaiting } from "@/stores/session-status-selectors";

describe("isFeatureWaiting", () => {
  const bySession = {
    1: { status: "question", kind: "permission", featureId: 10, seq: 1 },
    2: { status: "agent", kind: null, featureId: 20, seq: 2 },
  } as const;

  it("is true only for a feature with a session waiting on the user", () => {
    expect(isFeatureWaiting(bySession, 10)).toBe(true);
    expect(isFeatureWaiting(bySession, 20)).toBe(false);
    expect(isFeatureWaiting(bySession, 30)).toBe(false);
  });
});
