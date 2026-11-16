// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollReviewThreadToCenter } from "./scroll-to-review-thread";

let frames: Map<number, FrameRequestCallback>;
let nextId: number;

function tick(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

beforeEach(() => {
  frames = new Map();
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeThread(elementHeight = 100) {
  const container = document.createElement("div");
  const thread = document.createElement("section");
  thread.dataset.reviewThreadId = "thread-1";
  container.appendChild(thread);
  let scrollTop = 0;
  let threadOffset = 700;
  Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
    configurable: true,
  });
  container.getBoundingClientRect = () => ({ top: 100, height: 600 }) as DOMRect;
  thread.getBoundingClientRect = () =>
    ({ top: 100 + threadOffset - scrollTop, height: elementHeight }) as DOMRect;
  return {
    container,
    getScrollTop: () => scrollTop,
    shiftThread: (delta: number) => {
      threadOffset += delta;
    },
  };
}

describe("scrollReviewThreadToCenter", () => {
  it("centers the thread in the diff viewport", () => {
    const { container, getScrollTop } = makeThread();

    scrollReviewThreadToCenter(container, "thread-1");
    tick();

    expect(getScrollTop()).toBe(450);
    tick();
    tick();
    expect(frames.size).toBe(0);
  });

  it("re-centers after virtualized file heights change", () => {
    const { container, getScrollTop, shiftThread } = makeThread();

    scrollReviewThreadToCenter(container, "thread-1");
    tick();
    expect(getScrollTop()).toBe(450);

    shiftThread(80);
    tick();
    expect(getScrollTop()).toBe(530);
  });

  it("aligns a thread taller than the viewport to the viewport top", () => {
    const { container, getScrollTop } = makeThread(800);

    scrollReviewThreadToCenter(container, "thread-1");
    tick();

    expect(getScrollTop()).toBe(700);
  });

  it("keeps independent diff viewers from cancelling each other", () => {
    const first = makeThread();
    const second = makeThread();

    scrollReviewThreadToCenter(first.container, "thread-1");
    scrollReviewThreadToCenter(second.container, "thread-1");
    tick();

    expect(first.getScrollTop()).toBe(450);
    expect(second.getScrollTop()).toBe(450);
  });
});
