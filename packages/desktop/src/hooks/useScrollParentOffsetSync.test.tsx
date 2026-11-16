import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollParentOffsetSync } from "./useScrollParentOffsetSync";

const observed: Element[] = [];
const resizeCallbacks: Array<() => void> = [];
const disconnect = vi.fn();
class CapturingResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe(element: Element): void {
    observed.push(element);
  }
  disconnect = disconnect;
}

function boxed<T extends HTMLElement>(element: T, box: Partial<DOMRect>): T {
  element.getBoundingClientRect = () => ({ ...box }) as DOMRect;
  return element;
}

/** viewport > content > lists, each with a mutable box. */
function sidebar(listCount = 1) {
  const viewport = boxed(document.createElement("div"), { top: 100 });
  const content = viewport.appendChild(document.createElement("div"));
  const lists = Array.from({ length: listCount }, (_, index) => {
    const box = { top: 300 + index * 500 };
    return {
      ref: { current: content.appendChild(boxed(document.createElement("div"), box)) },
      box,
    };
  });
  const scrolls = vi.fn();
  viewport.addEventListener("scroll", scrolls);
  return { viewport, content, lists, scrolls };
}

/** Delivers a content resize; the first one records each list's offset. */
const resize = () => resizeCallbacks.forEach((callback) => callback());

describe("useScrollParentOffsetSync", () => {
  beforeEach(() => {
    observed.length = 0;
    resizeCallbacks.length = 0;
    disconnect.mockClear();
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replays a scroll when content above moves the list", () => {
    const { viewport, content, lists, scrolls } = sidebar();
    renderHook(() => useScrollParentOffsetSync(lists[0].ref, viewport));
    expect(observed).toEqual([content]);
    resize();
    scrolls.mockClear();

    // A block above the list shrinks: the list moves up without any scroll.
    lists[0].box.top = 220;
    resize();
    expect(scrolls).toHaveBeenCalledTimes(1);

    resize();
    expect(scrolls).toHaveBeenCalledTimes(1);
  });

  it("measures the offset within the content, so a real scroll is not replayed", () => {
    const { viewport, lists, scrolls } = sidebar();
    renderHook(() => useScrollParentOffsetSync(lists[0].ref, viewport));
    resize();
    scrolls.mockClear();

    viewport.scrollTop = 50;
    lists[0].box.top = 250;
    resize();
    expect(scrolls).not.toHaveBeenCalled();
  });

  it("shares one observer and one replay across the lists of a scroll parent", () => {
    const { viewport, lists, scrolls } = sidebar(2);
    const hooks = lists.map((list) =>
      renderHook(() => useScrollParentOffsetSync(list.ref, viewport)),
    );
    expect(resizeCallbacks).toHaveLength(1);
    resize();
    scrolls.mockClear();

    for (const list of lists) list.box.top -= 80;
    resize();
    expect(scrolls).toHaveBeenCalledTimes(1);

    hooks[0].unmount();
    expect(disconnect).not.toHaveBeenCalled();
    hooks[1].unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
