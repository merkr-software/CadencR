import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import {
  markHistoryLoaded,
  markPageLoaded,
  NO_HISTORY_GAPS,
  snapshotHistoryGaps,
  type HistoryGap,
} from "./ws-history-gaps";

function block(id: string, type: AgentBlockData["type"] = "text"): AgentBlockData {
  return { id, type, content: id };
}

function bounds(gaps: HistoryGap[]): Array<[number | null, number]> {
  return gaps.map(({ afterId, beforeId }) => [afterId, beforeId]);
}

describe("snapshotHistoryGaps", () => {
  it("has no gap when the snapshot holds the whole session", () => {
    expect(snapshotHistoryGaps({ blocks: [], hasMore: false, oldestMessageId: 5 })).toBe(
      NO_HISTORY_GAPS,
    );
  });

  it("makes every row shipped ahead of the latest page an island between two gaps", () => {
    const gaps = snapshotHistoryGaps({
      blocks: [block("msg-3", "user_message"), block("msg-40", "tool_call"), block("msg-90")],
      hasMore: true,
      oldestMessageId: 90,
    });
    // The first prompt and a tool call whose result is in the page: neither
    // follows the rows around it, so each sits between two gap rows.
    expect(bounds(gaps)).toEqual([
      [null, 3],
      [3, 40],
      [40, 90],
    ]);
  });
});

describe("markHistoryLoaded", () => {
  const gap: HistoryGap = { id: "a", afterId: 10, beforeId: 100 };

  it("shrinks a gap from below and keeps its id", () => {
    expect(markHistoryLoaded([gap], 60, 99)).toEqual([{ id: "a", afterId: 10, beforeId: 60 }]);
  });

  it("shrinks a gap from above and keeps its id", () => {
    expect(markHistoryLoaded([gap], 11, 40)).toEqual([{ id: "a", afterId: 40, beforeId: 100 }]);
  });

  it("splits a gap around an island, giving the newer part a new id", () => {
    const [older, newer] = markHistoryLoaded([gap], 30, 40);
    expect(older).toEqual({ id: "a", afterId: 10, beforeId: 30 });
    expect(newer.id).not.toBe("a");
    expect(bounds([newer])).toEqual([[40, 100]]);
  });

  it("closes a gap a range covers, and one left with no id between its bounds", () => {
    expect(markHistoryLoaded([gap], 5, 200)).toEqual([]);
    expect(markHistoryLoaded([gap], 11, 99)).toEqual([]);
  });

  it("closes every gap a page reaching the start of the session covers", () => {
    const gaps: HistoryGap[] = [
      { id: "a", afterId: null, beforeId: 3 },
      { id: "b", afterId: 3, beforeId: 90 },
    ];
    expect(markHistoryLoaded(gaps, -Infinity, 89)).toEqual([]);
  });

  it("hands back the same list when the range touches no gap", () => {
    const gaps = [gap];
    expect(markHistoryLoaded(gaps, 100, Infinity)).toBe(gaps);
    expect(markHistoryLoaded(gaps, -Infinity, 10)).toBe(gaps);
  });
});

describe("markPageLoaded", () => {
  it("makes a row the page ships from outside its range an island", () => {
    const gaps: HistoryGap[] = [{ id: "a", afterId: 10, beforeId: 100 }];
    const parent = block("msg-20", "tool_call");
    expect(bounds(markPageLoaded(gaps, [parent, block("msg-80")], 80, 99))).toEqual([
      [10, 20],
      [20, 80],
    ]);
  });
});
