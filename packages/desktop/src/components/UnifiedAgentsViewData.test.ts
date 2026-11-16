import { describe, expect, it } from "vitest";
import type { UnifiedAgentEntry } from "@/api/generated";
import { agentsWentStale, liveFeatures } from "@/components/UnifiedAgentsViewData";
import type { AttentionEntry } from "@/lib/attention-index";

const fetched = (...featureIds: number[]): UnifiedAgentEntry[] =>
  featureIds.map((id) => ({ feature: { id } }) as UnifiedAgentEntry);

function stale(
  before: AttentionEntry[],
  after: AttentionEntry[],
  known: UnifiedAgentEntry[] = fetched(1, 2),
): boolean {
  return agentsWentStale(liveFeatures(before, known), liveFeatures(after, known));
}

describe("agentsWentStale", () => {
  it("reloads when a known agent's turn ends", () => {
    expect(stale([{ featureId: 1, state: "working" }], [{ featureId: 1, state: "unread" }])).toBe(
      true,
    );
  });

  it("reloads when an agent the grid does not know starts", () => {
    expect(stale([], [{ featureId: 9, state: "working" }])).toBe(true);
  });

  it("ignores reading a reply or acknowledging a failure", () => {
    expect(stale([{ featureId: 1, state: "unread" }], [])).toBe(false);
    expect(stale([{ featureId: 2, state: "failed" }], [])).toBe(false);
  });

  it("ignores a known agent starting or asking, until its turn ends", () => {
    expect(stale([], [{ featureId: 1, state: "working" }])).toBe(false);
    expect(stale([{ featureId: 1, state: "working" }], [{ featureId: 1, state: "waiting" }])).toBe(
      false,
    );
  });
});
