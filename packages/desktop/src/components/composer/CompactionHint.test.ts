import { describe, expect, it } from "vitest";
import { shouldRecommendCompaction } from "./CompactionHint";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-24T12:00:00Z");
const usage = (input: number, window: number | null) => ({
  inputTokens: input,
  outputTokens: 0,
  contextWindow: window,
  wasCompacted: false,
});

describe("shouldRecommendCompaction", () => {
  it("needs a conversation older than an hour", () => {
    const recent = new Date(now - 30 * 60 * 1000).toISOString();
    expect(shouldRecommendCompaction(usage(150_000, 200_000), recent, now)).toBe(false);
    const old = new Date(now - 2 * HOUR).toISOString();
    expect(shouldRecommendCompaction(usage(150_000, 200_000), old, now)).toBe(true);
  });

  it("needs half the window, or 100k tokens when the window is unknown", () => {
    const old = new Date(now - 2 * HOUR).toISOString();
    expect(shouldRecommendCompaction(usage(90_000, 200_000), old, now)).toBe(false);
    expect(shouldRecommendCompaction(usage(120_000, null), old, now)).toBe(true);
    expect(shouldRecommendCompaction(usage(60_000, null), old, now)).toBe(false);
    expect(shouldRecommendCompaction(null, old, now)).toBe(false);
  });
});
