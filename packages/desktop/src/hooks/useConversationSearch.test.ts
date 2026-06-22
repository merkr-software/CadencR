import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/components/AgentBlock";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import { useConversationSearch } from "./useConversationSearch";

function row(id: string, content: string): DisplayItem {
  const block: AgentBlockData = { id, type: "text", content };
  return { kind: "block", key: id, block };
}

const items: DisplayItem[] = [row("a", "fox and fox"), row("b", "another fox")];

function renderSearch() {
  const virtuosoRef = createRef<VirtuosoHandle>();
  const scrollerRef = createRef<HTMLElement>();
  return renderHook(() => useConversationSearch({ items, virtuosoRef, scrollerRef }));
}

/** Type a query and let the debounce settle so matches recompute. */
function type(result: ReturnType<typeof renderSearch>["result"], query: string): void {
  act(() => result.current.setQuery(query));
  act(() => void vi.advanceTimersByTime(200));
}

describe("useConversationSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts closed with no matches", () => {
    const { result } = renderSearch();
    expect(result.current.isOpen).toBe(false);
    expect(result.current.matchCount).toBe(0);
  });

  it("opens, counts every occurrence, and reports a 1-based active number", () => {
    const { result } = renderSearch();
    act(() => result.current.openSearch());
    type(result, "fox");
    expect(result.current.isOpen).toBe(true);
    expect(result.current.matchCount).toBe(3);
    expect(result.current.activeNumber).toBe(1);
  });

  it("wraps forward and backward through matches", () => {
    const { result } = renderSearch();
    act(() => result.current.openSearch());
    type(result, "fox");

    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(2);
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(1); // wrapped past the 3rd match

    act(() => result.current.prev());
    expect(result.current.activeNumber).toBe(3); // wrapped backward from the 1st
  });

  it("resets to the first match when the query changes", () => {
    const { result } = renderSearch();
    act(() => result.current.openSearch());
    type(result, "fox");
    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(2);

    type(result, "another");
    expect(result.current.matchCount).toBe(1);
    expect(result.current.activeNumber).toBe(1);
  });

  it("closing clears the query and matches", () => {
    const { result } = renderSearch();
    act(() => result.current.openSearch());
    type(result, "fox");
    expect(result.current.matchCount).toBe(3);

    act(() => result.current.closeSearch());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
    expect(result.current.matchCount).toBe(0);
  });
});
