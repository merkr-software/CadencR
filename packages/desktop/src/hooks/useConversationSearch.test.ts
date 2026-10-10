// @vitest-environment happy-dom
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

function renderSearchWith(initialItems: DisplayItem[]) {
  const virtuosoRef = createRef<VirtuosoHandle>();
  const scrollerRef = createRef<HTMLElement>();
  return renderHook(
    ({ currentItems }: { currentItems: DisplayItem[] }) =>
      useConversationSearch({ items: currentItems, virtuosoRef, scrollerRef }),
    { initialProps: { currentItems: initialItems } },
  );
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

  it("advances twice when navigation calls are batched", () => {
    const { result } = renderSearch();
    act(() => result.current.openSearch());
    type(result, "fox");

    act(() => {
      result.current.next();
      result.current.next();
    });

    expect(result.current.activeNumber).toBe(3);
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

  it("keeps the active block selected across prepend and reorder", () => {
    const active = row("active", "fox");
    const first = row("first", "fox");
    const { result, rerender } = renderSearchWith([first, active]);
    act(() => result.current.openSearch());
    type(result, "fox");
    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(2);

    const prepended = row("prepended", "fox");
    rerender({ currentItems: [active, prepended, first] });

    expect(result.current.activeNumber).toBe(1);
  });

  it("refreshes duplicate-id display identity before a canonical replacement", () => {
    const first = { ...row("duplicate", "fox"), key: "duplicate" };
    const active = { ...row("duplicate", "fox"), key: "duplicate#1" };
    const { result, rerender } = renderSearchWith([first, active]);
    act(() => result.current.openSearch());
    type(result, "fox");
    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(2);

    rerender({
      currentItems: [
        { ...active, key: "duplicate" },
        { ...first, key: "duplicate#1" },
      ],
    });
    expect(result.current.activeNumber).toBe(1);

    rerender({
      currentItems: [
        { ...row("duplicate", "fox"), key: "duplicate" },
        { ...first, key: "duplicate#1" },
      ],
    });
    expect(result.current.activeNumber).toBe(1);
  });

  it("keeps the public hook result stable for an irrelevant tail replacement", () => {
    const first = row("first", "fox");
    const tail = row("tail", "streaming text");
    const { result, rerender } = renderSearchWith([first, tail]);
    act(() => result.current.openSearch());
    type(result, "fox");
    const previous = result.current;

    rerender({ currentItems: [first, row("tail", "streaming text continued")] });

    expect(result.current).toBe(previous);
  });

  it("clamps after deleting the active match, then wraps next and previous", () => {
    const first = row("first", "fox");
    const deleted = row("deleted", "fox");
    const last = row("last", "fox");
    const { result, rerender } = renderSearchWith([first, deleted, last]);
    act(() => result.current.openSearch());
    type(result, "fox");
    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(2);

    rerender({ currentItems: [first, last] });
    expect(result.current.activeNumber).toBe(2);
    act(() => result.current.next());
    expect(result.current.activeNumber).toBe(1);
    act(() => result.current.prev());
    expect(result.current.activeNumber).toBe(2);
  });
});
