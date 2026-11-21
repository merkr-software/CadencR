import { describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { act, render, renderHook, screen } from "@/test-utils";
import type { DisplayItem } from "@/types/agent-stream";
import { TranscriptTailPreview, selectTailItems, useListSettled } from "./TranscriptTailPreview";

function textRow(index: number, content = "short"): DisplayItem {
  return { kind: "block", key: `row-${index}`, block: { id: `b-${index}`, type: "text", content } };
}

function toolRow(index: number): DisplayItem {
  return {
    kind: "block",
    key: `row-${index}`,
    block: { id: `b-${index}`, type: "tool_call", content: "" },
  };
}

describe("selectTailItems", () => {
  it("takes every row of a transcript shorter than the minimum", () => {
    expect(selectTailItems([textRow(0), textRow(1)], 600)).toBe(2);
  });

  it("stops once the estimated rows cover the viewport", () => {
    const long = "x".repeat(20_000);
    const items = Array.from({ length: 30 }, (_, index) => textRow(index, long));
    // Three long messages already overflow any viewport: no need for more.
    expect(selectTailItems(items, 600)).toBe(3);
  });

  it("takes more rows when they are short, up to its cap", () => {
    const items = Array.from({ length: 60 }, (_, index) => toolRow(index));
    const count = selectTailItems(items, 600);
    expect(count).toBeGreaterThan(3);
    expect(count).toBeLessThanOrEqual(14);
  });
});

describe("TranscriptTailPreview", () => {
  it("renders the last rows only, then the footer", () => {
    const long = "x".repeat(20_000);
    const items = Array.from({ length: 10 }, (_, index) => textRow(index, long));
    render(
      <TranscriptTailPreview
        items={items}
        renderRow={(item) => <p>{item.key}</p>}
        footer={<p>footer</p>}
      />,
    );

    expect(screen.queryByText("row-0")).not.toBeInTheDocument();
    expect(screen.getByText("row-9")).toBeInTheDocument();
    expect(screen.getByText("footer")).toBeInTheDocument();
  });
});

/** A scroller whose geometry the test controls, as the list's would be. */
function scrollerWith({ rows, gap }: { rows: number; gap: number }): HTMLElement {
  const scroller = document.createElement("div");
  const list = scroller.appendChild(document.createElement("div"));
  list.setAttribute("data-testid", "virtuoso-item-list");
  for (let index = 0; index < rows; index += 1) list.appendChild(document.createElement("div"));
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 600 - gap },
  });
  return scroller;
}

function renderSettled(scroller: HTMLElement | null, active = true) {
  return renderHook(() => {
    const ref = useRef(scroller);
    return useListSettled(ref, active);
  });
}

describe("useListSettled", () => {
  it("is settled at once when the list already shows its last rows", () => {
    const { result } = renderSettled(scrollerWith({ rows: 4, gap: 0 }));
    expect(result.current).toBe(true);
  });

  it("waits for a list that has not rendered its rows", () => {
    vi.useFakeTimers();
    try {
      const scroller = scrollerWith({ rows: 0, gap: 0 });
      const { result } = renderSettled(scroller);
      expect(result.current).toBe(false);

      scroller.firstElementChild?.appendChild(document.createElement("div"));
      // Two frames resting on the bottom, one `act` each.
      act(() => void vi.advanceTimersByTime(20));
      act(() => void vi.advanceTimersByTime(20));

      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a list that is not resting on its bottom yet", () => {
    vi.useFakeTimers();
    try {
      const scroller = scrollerWith({ rows: 4, gap: 300 });
      const { result } = renderSettled(scroller);
      act(() => void vi.advanceTimersByTime(60));
      expect(result.current).toBe(false);

      scroller.scrollTop = 600;
      act(() => void vi.advanceTimersByTime(20));
      act(() => void vi.advanceTimersByTime(20));

      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the transcript to the list after its deadline, settled or not", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderSettled(scrollerWith({ rows: 0, gap: 0 }));
      act(() => void vi.advanceTimersByTime(700));
      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is settled at once when the list exposes no scroller to watch", () => {
    const { result } = renderSettled(null);
    expect(result.current).toBe(true);
  });

  it("does not wait while there is nothing to show", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderSettled(scrollerWith({ rows: 0, gap: 0 }), false);
      act(() => void vi.advanceTimersByTime(700));
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
